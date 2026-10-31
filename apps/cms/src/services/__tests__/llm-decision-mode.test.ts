import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DecisionProviderError,
  LLMDecisionProvider,
  SystemOneDecisionProvider,
  estimateDecisionAnswerTokens,
  weightedScore,
  type DecisionRequest,
} from '../decision-provider';
import {
  AnthropicProvider,
  GeminiProvider,
  LLMHttpError,
  LLMNetworkError,
  LLMResponseError,
  NvidiaProvider,
  OpenAIProvider,
  VertexProvider,
  WorkersAIProvider,
  type LLMProvider,
} from '../llm-provider';

/**
 * #510 (J03): the LLM decision provider drives each real adapter in structured
 * decision mode. Requests are inspected through a mocked fetch: decision system
 * prompt, no CORE_SKILLS / tool calling, and the abort signal forwarded.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const request: DecisionRequest = {
  state: { title: 'Khuyến mãi mùa hè' },
  questions: {
    spam: { type: 'noul', instructions: 'Is this spam?', criteria: { true: 'spam', false: 'ok' } },
    quality: { type: 'score', instructions: 'Rate quality', criteria: ['poor', 'ok', 'great'] },
  },
};

const decisionJson = JSON.stringify({
  answers: {
    spam: { noul: 0.25 },
    // The model's own `score` must be ignored in favour of the weighted one.
    quality: { score: 2, probabilities: { '0': 0.2, '1': 0.5, '2': 0.3 }, confidence: 0.5 },
  },
});

type Wire = (text: string, usage?: { input: number; output: number }) => unknown;

interface AdapterCase {
  name: string;
  make: () => LLMProvider;
  wire: Wire;
  systemOf: (body: Record<string, unknown>) => unknown;
  toolKeys: string[];
}

const adapters: AdapterCase[] = [
  {
    name: 'OpenAI',
    make: () => new OpenAIProvider('k'),
    wire: (text, usage) => ({
      choices: [{ message: { content: text } }],
      ...(usage ? { usage: { prompt_tokens: usage.input, completion_tokens: usage.output } } : {}),
    }),
    systemOf: (b) => (b.messages as Array<{ role: string; content: string }>)[0],
    toolKeys: ['tools', 'tool_choice'],
  },
  {
    name: 'NVIDIA (OpenAI-compatible)',
    make: () => new NvidiaProvider('k'),
    wire: (text) => ({ choices: [{ message: { content: text } }] }),
    systemOf: (b) => (b.messages as Array<{ role: string; content: string }>)[0],
    toolKeys: ['tools', 'tool_choice'],
  },
  {
    name: 'Anthropic',
    make: () => new AnthropicProvider('k'),
    wire: (text, usage) => ({
      content: [{ type: 'text', text }],
      ...(usage ? { usage: { input_tokens: usage.input, output_tokens: usage.output } } : {}),
    }),
    systemOf: (b) => b.system,
    toolKeys: ['tools'],
  },
  {
    name: 'Gemini',
    make: () => new GeminiProvider('k'),
    wire: (text, usage) => ({
      candidates: [{ content: { parts: [{ text }] } }],
      ...(usage ? { usageMetadata: { promptTokenCount: usage.input, candidatesTokenCount: usage.output } } : {}),
    }),
    systemOf: (b) => (b.systemInstruction as { parts: Array<{ text: string }> }).parts[0]?.text,
    toolKeys: ['tools', 'toolConfig'],
  },
  {
    name: 'Vertex',
    make: () => new VertexProvider({ accessToken: 't', projectId: 'p' }),
    wire: (text) => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    systemOf: (b) => (b.systemInstruction as { parts: Array<{ text: string }> }).parts[0]?.text,
    toolKeys: ['tools', 'toolConfig'],
  },
  {
    name: 'Workers AI',
    make: () => new WorkersAIProvider({ accountId: 'a', apiToken: 't' }),
    wire: (text, usage) => ({
      result: {
        response: text,
        ...(usage ? { usage: { prompt_tokens: usage.input, completion_tokens: usage.output } } : {}),
      },
    }),
    systemOf: (b) => (b.messages as Array<{ role: string; content: string }>)[0],
    toolKeys: ['tools'],
  },
];

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
}

function systemText(value: unknown): string {
  return typeof value === 'string' ? value : String((value as { content?: string })?.content ?? '');
}

describe.each(adapters)('$name adapter in decision mode', (adapter) => {
  it('sends the decision system prompt, no tools, and forwards the abort signal', async () => {
    const fetchMock = stubFetch(adapter.wire(decisionJson));

    const result = await new LLMDecisionProvider(adapter.make(), 'm').decide(request);

    const body = sentBody(fetchMock);
    expect(systemText(adapter.systemOf(body))).toContain('structured decision engine');
    expect(systemText(adapter.systemOf(body))).not.toContain('LumiBase AI Copilot');
    for (const key of adapter.toolKeys) expect(body).not.toHaveProperty(key);
    expect(JSON.stringify(body)).not.toContain('createCollection');
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(result.calibrated).toBe(false);
    expect(result.answers.quality).toMatchObject({ type: 'score', score: weightedScore({ '0': 0.2, '1': 0.5, '2': 0.3 }, 3) });
  });

  it('keeps the Copilot prompt and tools for ordinary chat (regression)', async () => {
    const fetchMock = stubFetch(adapter.wire('hello'));

    await adapter.make().chat([{ role: 'user', content: 'list collections' }]);

    const body = sentBody(fetchMock);
    expect(systemText(adapter.systemOf(body))).toContain('LumiBase AI Copilot');
    expect(body).toHaveProperty(adapter.toolKeys[0]!);
  });
});

describe('score semantics', () => {
  it('derives the weighted score Σ i·p(i) on the 0..N-1 scale, unrounded', () => {
    expect(weightedScore({ '0': 0.2, '1': 0.5, '2': 0.3 }, 3)).toBeCloseTo(1.1, 12);
    expect(weightedScore({ '0': 0, '1': 0, '2': 1 }, 3)).toBe(2);
    expect(weightedScore({ '0': 1, '1': 0 }, 2)).toBe(0);
  });

  it('produces the same score for the same distribution on two different adapters', async () => {
    stubFetch(adapters[0]!.wire(decisionJson));
    const viaOpenAI = await new LLMDecisionProvider(new OpenAIProvider('k'), 'm').decide(request);
    vi.unstubAllGlobals();
    stubFetch(adapters[2]!.wire(decisionJson));
    const viaAnthropic = await new LLMDecisionProvider(new AnthropicProvider('k'), 'm').decide(request);

    expect(viaOpenAI.answers.quality).toEqual(viaAnthropic.answers.quality);
    expect((viaOpenAI.answers.quality as { score: number }).score).toBeCloseTo(1.1, 12);
  });

  it('rejects a score answer without a usable distribution', async () => {
    const json = JSON.stringify({
      answers: { spam: { noul: 0.1 }, quality: { score: 1, probabilities: { '0': 'x', '1': 0.5, '2': 0.5 }, confidence: 0.4 } },
    });
    stubFetch(adapters[0]!.wire(json));

    await expect(new LLMDecisionProvider(new OpenAIProvider('k'), 'm').decide(request)).rejects.toMatchObject({
      code: 'DECISION_PARSE_FAILED',
    });
  });
});

describe('malformed and tool-only LLM replies', () => {
  it('rejects malformed JSON', async () => {
    stubFetch(adapters[0]!.wire('{"answers": {"spam": '));

    await expect(new LLMDecisionProvider(new OpenAIProvider('k'), 'm').decide(request)).rejects.toMatchObject({
      code: 'DECISION_PARSE_FAILED',
    });
  });

  it('rejects a tool-only reply', async () => {
    stubFetch({
      choices: [{ message: { content: null, tool_calls: [{ function: { name: 'listCollections', arguments: '{}' } }] } }],
    });

    await expect(new LLMDecisionProvider(new OpenAIProvider('k'), 'm').decide(request)).rejects.toMatchObject({
      code: 'DECISION_PARSE_FAILED',
    });
  });
});

describe('usage and calibration are reported honestly', () => {
  it('passes through usage the adapter reports', async () => {
    stubFetch(adapters[0]!.wire(decisionJson, { input: 321, output: 45 }));

    const result = await new LLMDecisionProvider(new OpenAIProvider('k'), 'm').decide(request);

    expect(result.usage).toEqual({ inputTokens: 321, outputTokens: 45 });
    expect(result.calibrated).toBe(false);
  });

  it.each([
    ['OpenAI', { choices: [{ message: { content: decisionJson } }], usage: { prompt_tokens: 321 } }, () => new OpenAIProvider('k'), { inputTokens: 321, outputTokens: null }],
    ['Anthropic', { content: [{ type: 'text', text: decisionJson }], usage: { output_tokens: 45 } }, () => new AnthropicProvider('k'), { inputTokens: null, outputTokens: 45 }],
    ['Gemini', { candidates: [{ content: { parts: [{ text: decisionJson }] } }], usageMetadata: { promptTokenCount: 77 } }, () => new GeminiProvider('k'), { inputTokens: 77, outputTokens: null }],
    ['Workers AI', { result: { response: decisionJson, usage: { completion_tokens: 9 } } }, () => new WorkersAIProvider({ accountId: 'a', apiToken: 't' }), { inputTokens: null, outputTokens: 9 }],
  ] as const)('keeps a partially reported usage field independently (%s)', async (_name, wire, make, expected) => {
    stubFetch(wire);

    const result = await new LLMDecisionProvider(make(), 'm').decide(request);

    expect(result.usage).toEqual(expected);
  });

  it('keeps a partially reported Jev usage field independently', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      answers: { spam: { type: 'noul', noul: 0.3 }, quality: {
        type: 'score', score: 1, legend: { '0': 'poor', '1': 'ok', '2': 'great' },
        probabilities: { '0': 0.2, '1': 0.6, '2': 0.2 }, confidence: 0.6,
      } },
      usage: { input_tokens: 120 },
    }), { status: 200 })));

    const result = await new SystemOneDecisionProvider({ apiKey: 'k' }).decide(request);

    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: null });
  });

  it.each([0, 2, 3, 5])('reports unknown usage as null, not zero (%s)', async (index) => {
    stubFetch(adapters[index]!.wire(decisionJson));

    const result = await new LLMDecisionProvider(adapters[index]!.make(), 'm').decide(request);

    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it('reports missing Jev usage as null, not zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      answers: { spam: { type: 'noul', noul: 0.3 }, quality: {
        type: 'score', score: 1, legend: { '0': 'poor', '1': 'ok', '2': 'great' },
        probabilities: { '0': 0.2, '1': 0.6, '2': 0.2 }, confidence: 0.6,
      } },
    }), { status: 200 })));

    const result = await new SystemOneDecisionProvider({ apiKey: 'k' }).decide(request);

    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null });
  });
});

describe('cancellation reaches the adapter request', () => {
  function hangingFetch() {
    return vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    );
  }

  it('aborts the upstream LLM request at the deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);

    const pending = new LLMDecisionProvider(new AnthropicProvider('k'), 'm', { deadlineMs: 4_000 })
      .decide(request)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(await pending).toMatchObject({ code: 'DECISION_TIMEOUT' });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('aborts the upstream LLM request when the caller cancels', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const pending = new LLMDecisionProvider(new GeminiProvider('k'), 'm')
      .decide(request, { signal: controller.signal })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();

    expect(await pending).toMatchObject({ code: 'DECISION_CANCELLED' });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #510 J03 follow-up: errors classified at the adapter, output budget, thinking usage
// ---------------------------------------------------------------------------

function respond(status: number, body: string) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const SENTINEL = 'SENTINEL_UPSTREAM_customer_jane@example.test';

describe('LLM upstream HTTP status maps to the Jev error codes', () => {
  const statusCases = [
    [401, 'DECISION_AUTH', 502],
    [429, 'DECISION_RATE_LIMITED', 429],
    [503, 'DECISION_UNAVAILABLE', 503],
    [500, 'DECISION_UPSTREAM', 500],
  ] as const;

  describe.each([
    ['OpenAI', () => new OpenAIProvider('k')],
    ['Gemini', () => new GeminiProvider('k')],
  ] as const)('%s', (_name, make) => {
    it.each(statusCases)('%i → %s', async (status, code) => {
      respond(status, `upstream said ${SENTINEL}`);

      const error = await new LLMDecisionProvider(make(), 'm').decide(request).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DecisionProviderError);
      expect(error).toMatchObject({ code, status });
      expect((error as Error).message).toBe(`LLM provider error ${status}.`);
      expect((error as Error).message).not.toContain('SENTINEL');
    });
  });
});

describe.each([
  ['OpenAI', () => new OpenAIProvider('k')],
  ['Anthropic', () => new AnthropicProvider('k')],
] as const)('%s transport and body classification', (_name, make) => {
  it('200 with a wrong envelope ({}) is DECISION_PARSE_FAILED, not a network error', async () => {
    respond(200, '{}');
    await expect(new LLMDecisionProvider(make(), 'm').decide(request)).rejects.toMatchObject({ code: 'DECISION_PARSE_FAILED' });
  });

  it('200 with a non-JSON body is DECISION_PARSE_FAILED', async () => {
    respond(200, 'not json');
    await expect(new LLMDecisionProvider(make(), 'm').decide(request)).rejects.toMatchObject({ code: 'DECISION_PARSE_FAILED' });
  });

  it('a rejected fetch (no abort) is DECISION_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(new LLMDecisionProvider(make(), 'm').decide(request)).rejects.toMatchObject({ code: 'DECISION_UNAVAILABLE' });
  });

  it('a fetch rejected after the caller aborted stays DECISION_CANCELLED', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort();
      throw new TypeError('fetch failed');
    }));
    await expect(new LLMDecisionProvider(make(), 'm').decide(request, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'DECISION_CANCELLED' });
  });

  it('fires onAttempt exactly once', async () => {
    stubFetch(_name === 'OpenAI' ? adapters[0]!.wire(decisionJson) : adapters[2]!.wire(decisionJson));
    const onAttempt = vi.fn();
    await new LLMDecisionProvider(make(), 'm').decide(request, { onAttempt });
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });
});

describe('a non-adapter failure from a custom LLMProvider', () => {
  // Not an LLMHttpError / LLMNetworkError / LLMResponseError: llmFailure's
  // final branch. The JS type (TypeError) must not be read as "network".
  it('is DECISION_UPSTREAM with a fixed message that does not echo the error', async () => {
    const llm: LLMProvider = { chat: vi.fn(async () => { throw new TypeError(`x ${SENTINEL}`); }) };

    const error = await new LLMDecisionProvider(llm, 'm').decide(request).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DecisionProviderError);
    expect(error).toMatchObject({ code: 'DECISION_UPSTREAM' });
    expect((error as Error).message).toBe('LLM provider request failed.');
    expect((error as Error).message).not.toContain('SENTINEL');
  });
});

describe('/ai/chat keeps its error contract (regression)', () => {
  it.each(adapters)('$name: non-2xx is still an Error with the original message', async (adapter) => {
    respond(500, 'boom');
    const error = await adapter.make().chat([{ role: 'user', content: 'hi' }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(LLMHttpError);
    expect((error as Error).message).toMatch(/error 500: boom$/);
  });

  it('a network failure keeps the fetch message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const error = await new OpenAIProvider('k').chat([{ role: 'user', content: 'hi' }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMNetworkError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('fetch failed');
  });

  it('an unusable body keeps the parser message', async () => {
    respond(200, 'not json');
    const error = await new OpenAIProvider('k').chat([{ role: 'user', content: 'hi' }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMResponseError);
    let original = '';
    try { JSON.parse('not json'); } catch (e) { original = (e as Error).message; }
    expect((error as Error).message).toBe(original);
  });

  it('Copilot still sends max 1024 on OpenAI/Anthropic/Gemini and nothing on Workers AI', async () => {
    for (const index of [0, 2, 3]) {
      const fetchMock = stubFetch(adapters[index]!.wire('hello'));
      await adapters[index]!.make().chat([{ role: 'user', content: 'hi' }]);
      const body = sentBody(fetchMock);
      const cap = index === 3 ? (body.generationConfig as { maxOutputTokens: number }).maxOutputTokens : body.max_tokens;
      expect(cap).toBe(1024);
      vi.unstubAllGlobals();
    }
    const fetchMock = stubFetch(adapters[5]!.wire('hello'));
    await adapters[5]!.make().chat([{ role: 'user', content: 'hi' }]);
    expect(sentBody(fetchMock)).not.toHaveProperty('max_tokens');
  });
});

describe('per-request output budget', () => {
  const yesNo = (n: number): DecisionRequest => ({
    state: 's',
    questions: Object.fromEntries(Array.from({ length: n }, (_, i) => [`question_${String(i).padStart(2, '0')}`, {
      type: 'choice' as const, instructions: 'x', criteria: { yes: null, no: null },
    }])),
  });
  const tenLevels = (n: number): DecisionRequest => ({
    state: 's',
    questions: Object.fromEntries(Array.from({ length: n }, (_, i) => [`question_${String(i).padStart(2, '0')}`, {
      type: 'score' as const, instructions: 'x', criteria: Array.from({ length: 10 }, (_, l) => `level ${l}`),
    }])),
  });
  const answerAll = (req: DecisionRequest) => JSON.stringify({
    answers: Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, q.type === 'choice'
      ? { choice: 'yes', probabilities: { yes: 0.5, no: 0.5 }, confidence: 0.5 }
      : { probabilities: Object.fromEntries(Array.from({ length: 10 }, (_, l) => [String(l), 0.1])), confidence: 0.5 }])),
  });

  it('OpenAI: 32 yes/no questions send max_tokens = the estimate', async () => {
    const req = yesNo(32);
    const fetchMock = stubFetch(adapters[0]!.wire(answerAll(req)));
    await new LLMDecisionProvider(new OpenAIProvider('k'), 'm').decide(req);
    expect(sentBody(fetchMock).max_tokens).toBe(estimateDecisionAnswerTokens(req.questions));
  });

  it('a single noul question gets the 256 floor', async () => {
    const req: DecisionRequest = { state: 's', questions: { q: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } } };
    expect(estimateDecisionAnswerTokens(req.questions)).toBeLessThan(256);
    const fetchMock = stubFetch(adapters[0]!.wire(JSON.stringify({ answers: { q: { noul: 0.4 } } })));
    await new LLMDecisionProvider(new OpenAIProvider('k'), 'm').decide(req);
    expect(sentBody(fetchMock).max_tokens).toBe(256);
  });

  it('Gemini: maxOutputTokens = max(need, 256) + thinking headroom', async () => {
    const req = yesNo(32);
    const fetchMock = stubFetch(adapters[3]!.wire(answerAll(req)));
    await new LLMDecisionProvider(new GeminiProvider('k'), 'm', {}, 1024).decide(req);
    const sent = (sentBody(fetchMock).generationConfig as { maxOutputTokens: number }).maxOutputTokens;
    expect(sent).toBe(Math.max(estimateDecisionAnswerTokens(req.questions), 256) + 1024);
  });

  it('Workers AI sends max_tokens in decision mode', async () => {
    const fetchMock = stubFetch(adapters[5]!.wire(decisionJson));
    await new LLMDecisionProvider(adapters[5]!.make(), 'm').decide(request);
    expect(sentBody(fetchMock).max_tokens).toBe(Math.max(estimateDecisionAnswerTokens(request.questions), 256));
  });

  it('cap − 1024 < need ≤ cap is accepted on OpenAI and on Gemini (thinking not part of the cap check)', async () => {
    const req = tenLevels(32);
    const need = estimateDecisionAnswerTokens(req.questions);
    expect(need).toBeGreaterThan(4096 - 1024);
    expect(need).toBeLessThanOrEqual(4096);

    stubFetch(adapters[0]!.wire(answerAll(req)));
    await expect(new LLMDecisionProvider(new OpenAIProvider('k'), 'm').decide(req)).resolves.toMatchObject({ provider: 'llm' });
    vi.unstubAllGlobals();

    const fetchMock = stubFetch(adapters[3]!.wire(answerAll(req)));
    await expect(new LLMDecisionProvider(new GeminiProvider('k'), 'm', {}, 1024).decide(req)).resolves.toMatchObject({ provider: 'llm' });
    expect((sentBody(fetchMock).generationConfig as { maxOutputTokens: number }).maxOutputTokens).toBe(need + 1024);
  });

  it('need > cap → 413 before fetch and before onAttempt', async () => {
    const req = tenLevels(32);
    const fetchMock = stubFetch(adapters[0]!.wire(answerAll(req)));
    const onAttempt = vi.fn();
    await expect(new LLMDecisionProvider(new OpenAIProvider('k'), 'm', { maxOutputTokens: 1024 }).decide(req, { onAttempt }))
      .rejects.toMatchObject({ code: 'DECISION_INPUT_TOO_LARGE' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onAttempt).not.toHaveBeenCalled();
  });
});

describe('Gemini/Vertex usage includes thinking tokens', () => {
  const withMeta = (usageMetadata: Record<string, unknown>) => ({
    candidates: [{ content: { parts: [{ text: decisionJson }] } }],
    usageMetadata,
  });

  describe.each([
    ['Gemini', () => new GeminiProvider('k')],
    ['Vertex', () => new VertexProvider({ accessToken: 't', projectId: 'p' })],
  ] as const)('%s', (_name, make) => {
    it('adds thoughtsTokenCount to the output count', async () => {
      stubFetch(withMeta({ promptTokenCount: 12, candidatesTokenCount: 40, thoughtsTokenCount: 300 }));
      const result = await new LLMDecisionProvider(make(), 'm').decide(request);
      expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 340 });
    });

    it('keeps candidatesTokenCount when no thinking count is reported', async () => {
      stubFetch(withMeta({ promptTokenCount: 12, candidatesTokenCount: 40 }));
      const result = await new LLMDecisionProvider(make(), 'm').decide(request);
      expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 40 });
    });

    it('a malformed thinking count makes output unknown, never an undercount', async () => {
      stubFetch(withMeta({ promptTokenCount: 12, candidatesTokenCount: 40, thoughtsTokenCount: 'x' }));
      const result = await new LLMDecisionProvider(make(), 'm').decide(request);
      expect(result.usage).toEqual({ inputTokens: 12, outputTokens: null });
    });
  });
});
