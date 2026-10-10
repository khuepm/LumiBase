import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DECISION_LIMITS,
  LLMDecisionProvider,
  SystemOneDecisionProvider,
  createDecisionProvider,
  decisionLimitsFromEnv,
  estimateDecisionTokens,
  measureDecisionInput,
  parseRetryAfter,
  type DecisionRequest,
} from '../decision-provider';
import type { LLMProvider } from '../llm-provider';

/**
 * #509 (J02): deadline, per-attempt timeout, cancellation, bounded retries and
 * the total input budget. Time is a fake clock (vi.useFakeTimers fakes both
 * setTimeout and Date.now), so elapsed time is exact and the suite is instant.
 */

const request: DecisionRequest = {
  state: { title: 'Summer sale' },
  questions: {
    spam: { type: 'noul', instructions: 'Is this spam?', criteria: { true: 'spam', false: 'ok' } },
  },
};

const okBody = { model: 'jev-1.13', answers: { spam: { type: 'noul', noul: 0.2 } }, usage: {} };

function ok(): Response {
  return new Response(JSON.stringify(okBody), { status: 200 });
}

/** A fetch that never answers on its own; it rejects only when its signal aborts. */
function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  );
}

/** Captures `promise`'s outcome and the fake time elapsed until `finish()`. */
function track<T>(promise: Promise<T>) {
  const start = Date.now();
  const outcome = promise.then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined, error }),
  );
  return {
    async finish() {
      await vi.runAllTimersAsync();
      const result = await outcome;
      return { ...result, elapsed: Date.now() - start };
    },
  };
}

/** Runs fake time to completion and settles `promise`. */
function settle<T>(promise: Promise<T>) {
  return track(promise).finish();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('deadline and attempt timeout', () => {
  it('times out a hanging attempt and retries until the total deadline, never beyond it', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new SystemOneDecisionProvider({
      apiKey: 'k',
      limits: { deadlineMs: 10_000, attemptTimeoutMs: 3_000, maxRetries: 5 },
      random: () => 0,
    });

    const { error, elapsed } = await settle(provider.decide(request));

    expect(error).toMatchObject({ code: 'DECISION_TIMEOUT' });
    expect(elapsed).toBeLessThanOrEqual(10_000);
    // 3s + 3s + 3s + the last 1s left of the deadline.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('caps the last attempt at what remains of the deadline', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new SystemOneDecisionProvider({
      apiKey: 'k',
      limits: { deadlineMs: 2_000, attemptTimeoutMs: 8_000, maxRetries: 2 },
    });

    const { error, elapsed } = await settle(provider.decide(request));

    expect(error).toMatchObject({ code: 'DECISION_TIMEOUT' });
    expect(elapsed).toBe(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not start a backoff that would end past the deadline', async () => {
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new SystemOneDecisionProvider({
      apiKey: 'k',
      limits: { deadlineMs: 1_000, maxRetries: 5 },
      retryBaseMs: 5_000,
      maxRetryDelayMs: 5_000,
      random: () => 0.9,
    });

    const { error, elapsed } = await settle(provider.decide(request));

    expect(error).toMatchObject({ code: 'DECISION_UNAVAILABLE', status: 503 });
    expect(elapsed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('cancellation', () => {
  it('rejects immediately without fetching when the signal is already aborted', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(
      new SystemOneDecisionProvider({ apiKey: 'k' }).decide(request, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'DECISION_CANCELLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts the in-flight attempt and never retries after cancel', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const provider = new SystemOneDecisionProvider({
      apiKey: 'k',
      limits: { deadlineMs: 60_000, attemptTimeoutMs: 10_000, maxRetries: 5 },
    });

    const pending = track(provider.decide(request, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(1_500);
    controller.abort();
    const { error, elapsed } = await pending.finish();

    expect(error).toMatchObject({ code: 'DECISION_CANCELLED' });
    expect(elapsed).toBe(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
  });

  it('stops during backoff when cancelled and does not fetch again', async () => {
    const fetchMock = vi.fn(async () => new Response('slow down', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const provider = new SystemOneDecisionProvider({
      apiKey: 'k',
      limits: { deadlineMs: 60_000, maxRetries: 5 },
      retryBaseMs: 4_000,
      random: () => 1,
    });

    const pending = track(provider.decide(request, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(1_000); // inside the 4s backoff
    controller.abort();
    const { error } = await pending.finish();

    expect(error).toMatchObject({ code: 'DECISION_CANCELLED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('retry policy', () => {
  it('retries a network error and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);

    const { value, error } = await settle(new SystemOneDecisionProvider({ apiKey: 'k' }).decide(request));

    expect(error).toBeUndefined();
    expect(value?.answers.spam).toEqual({ type: 'noul', noul: 0.2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps persistent network failure to DECISION_UNAVAILABLE after the retry budget', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const { error } = await settle(
      new SystemOneDecisionProvider({ apiKey: 'k', limits: { maxRetries: 2 } }).decide(request),
    );

    expect(error).toMatchObject({ code: 'DECISION_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('waits at least Retry-After before the next attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '3' } }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);

    const { error, elapsed } = await settle(
      new SystemOneDecisionProvider({ apiKey: 'k', random: () => 0 }).decide(request),
    );

    expect(error).toBeUndefined();
    expect(elapsed).toBe(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up instead of waiting when Retry-After exceeds the deadline', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { error, elapsed } = await settle(
      new SystemOneDecisionProvider({ apiKey: 'k', limits: { deadlineMs: 20_000 } }).decide(request),
    );

    expect(error).toMatchObject({ code: 'DECISION_RATE_LIMITED', status: 429 });
    expect(elapsed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('applies jitter within the exponential cap', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const sleep = vi.fn(async () => {});

    await new SystemOneDecisionProvider({ apiKey: 'k', retryBaseMs: 1_000, sleep, random: () => 0.5 }).decide(request);

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1_000]);
  });

  it.each([
    [401, 'DECISION_AUTH'],
    [403, 'DECISION_AUTH'],
    [400, 'DECISION_VALIDATION'],
    [422, 'DECISION_VALIDATION'],
  ])('does not retry %i (%s)', async (status, code) => {
    const fetchMock = vi.fn(async () => new Response('', { status }));
    vi.stubGlobal('fetch', fetchMock);

    const { error } = await settle(new SystemOneDecisionProvider({ apiKey: 'k' }).decide(request));

    expect(error).toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a body that fails to parse', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>oops</html>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { error } = await settle(new SystemOneDecisionProvider({ apiKey: 'k' }).decide(request));

    expect(error).toMatchObject({ code: 'DECISION_PARSE_FAILED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('input budget', () => {
  it('measures state, instructions, criteria and nesting together', () => {
    const small = measureDecisionInput(request);
    const nested = measureDecisionInput({
      state: { title: 'Summer sale' },
      questions: {
        spam: {
          type: 'noul',
          instructions: { rules: [['a', 'b'], { deep: 'x'.repeat(400) }] },
          criteria: { true: 'spam', false: 'ok' },
        },
      },
    });

    expect(nested.bytes - small.bytes).toBeGreaterThan(400);
    expect(nested.estimatedTokens).toBeGreaterThan(small.estimatedTokens);
  });

  it('counts Vietnamese far more tightly than ASCII of the same length', () => {
    const vi_ = 'Bản nháp này có vi phạm chính sách biên tập không? ';
    const en = 'Does this draft violate the editorial policy, yes or no? ';
    expect(estimateDecisionTokens(vi_)).toBeGreaterThan(estimateDecisionTokens(en.slice(0, vi_.length)));
    // Every non-ASCII code point is one token; ASCII is ~4 per token.
    expect(estimateDecisionTokens('ếếế')).toBe(3);
    expect(estimateDecisionTokens('abcdefgh')).toBe(2);
  });

  it('rejects Vietnamese input over the token budget before any fetch', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const provider = new SystemOneDecisionProvider({
      apiKey: 'k',
      limits: { maxInputTokens: 1_000, maxInputBytes: 1_000_000 },
    });
    const state = 'Nội dung bài viết tiếng Việt có dấu đầy đủ. '.repeat(100);

    await expect(provider.decide({ ...request, state })).rejects.toMatchObject({
      code: 'DECISION_INPUT_TOO_LARGE',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a large object/array state over the byte cap before any fetch', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const provider = new SystemOneDecisionProvider({ apiKey: 'k' });
    const state = {
      blocks: Array.from({ length: 2_000 }, (_, i) => ({ id: i, text: 'lorem ipsum dolor sit amet '.repeat(3) })),
    };

    await expect(provider.decide({ ...request, state })).rejects.toMatchObject({
      code: 'DECISION_INPUT_TOO_LARGE',
      message: expect.stringContaining(`limit is ${DEFAULT_DECISION_LIMITS.maxInputBytes}`),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized questions, not only oversized state', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const provider = new SystemOneDecisionProvider({ apiKey: 'k', limits: { maxInputTokens: 500 } });
    const criteria = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`opt${i}`, `Option ${i} description`]));

    await expect(
      provider.decide({
        state: 'short',
        questions: { topic: { type: 'choice', instructions: 'Pick one', criteria } },
      }),
    ).rejects.toMatchObject({ code: 'DECISION_INPUT_TOO_LARGE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('LLM fallback bounds', () => {
  function hangingLLM(): LLMProvider {
    return { chat: vi.fn(() => new Promise(() => {})) };
  }

  it('releases the caller at the deadline', async () => {
    const provider = new LLMDecisionProvider(hangingLLM(), 'openai:gpt', { deadlineMs: 5_000 });

    const { error, elapsed } = await settle(provider.decide(request));

    expect(error).toMatchObject({ code: 'DECISION_TIMEOUT' });
    expect(elapsed).toBe(5_000);
  });

  it('releases the caller on cancel', async () => {
    const controller = new AbortController();
    const provider = new LLMDecisionProvider(hangingLLM(), 'openai:gpt', { deadlineMs: 60_000 });

    const pending = track(provider.decide(request, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const { error, elapsed } = await pending.finish();

    expect(error).toMatchObject({ code: 'DECISION_CANCELLED' });
    expect(elapsed).toBe(100);
  });

  it('applies the same input budget before calling the LLM', async () => {
    const llm = hangingLLM();
    const provider = new LLMDecisionProvider(llm, 'openai:gpt', { maxInputTokens: 300 });

    await expect(provider.decide({ ...request, state: 'Tiếng Việt '.repeat(200) })).rejects.toMatchObject({
      code: 'DECISION_INPUT_TOO_LARGE',
    });
    expect(llm.chat).not.toHaveBeenCalled();
  });
});

describe('configuration', () => {
  it('reads bounds from env and falls back on invalid values', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      decisionLimitsFromEnv({
        DECISION_TIMEOUT_MS: '15000',
        DECISION_ATTEMPT_TIMEOUT_MS: '5000',
        DECISION_MAX_RETRIES: '1',
        DECISION_MAX_INPUT_BYTES: '65536',
        DECISION_MAX_INPUT_TOKENS: '12000',
      }),
    ).toEqual({ deadlineMs: 15_000, attemptTimeoutMs: 5_000, maxRetries: 1, maxInputBytes: 65_536, maxInputTokens: 12_000 });

    expect(
      decisionLimitsFromEnv({ DECISION_TIMEOUT_MS: 'soon', DECISION_MAX_RETRIES: '99', DECISION_MAX_INPUT_BYTES: '' }),
    ).toEqual(DEFAULT_DECISION_LIMITS);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('wires env bounds into the configured provider', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const configured = createDecisionProvider({
      DECISION_PROVIDER: 'typesafe',
      TYPESAFE_API_KEY: 'k',
      DECISION_TIMEOUT_MS: '3000',
      DECISION_ATTEMPT_TIMEOUT_MS: '1000',
      DECISION_MAX_RETRIES: '0',
    });

    const { error, elapsed } = await settle(configured!.provider.decide(request));

    expect(error).toMatchObject({ code: 'DECISION_TIMEOUT' });
    expect(elapsed).toBe(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = Date.parse('2026-10-10T00:00:00Z');
    expect(parseRetryAfter('7', now)).toBe(7_000);
    expect(parseRetryAfter('Sat, 10 Oct 2026 00:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfter('Fri, 09 Oct 2026 23:59:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});
