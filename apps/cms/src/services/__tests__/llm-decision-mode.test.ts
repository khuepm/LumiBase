import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LLMDecisionProvider,
  SystemOneDecisionProvider,
  weightedScore,
  type DecisionRequest,
} from '../decision-provider';
import {
  AnthropicProvider,
  GeminiProvider,
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
