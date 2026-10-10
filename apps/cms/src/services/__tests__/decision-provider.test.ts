import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DecisionProviderError,
  LLMDecisionProvider,
  SystemOneDecisionProvider,
  createDecisionProvider,
  type DecisionRequest,
} from '../decision-provider';
import type { LLMProvider } from '../llm-provider';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const request: DecisionRequest = {
  state: { title: 'Summer sale', body: 'Buy now!!!' },
  questions: {
    spam: {
      type: 'noul',
      instructions: 'Is this post spam?',
      criteria: { true: 'spam', false: 'legitimate' },
    },
    topic: {
      type: 'choice',
      instructions: 'Pick the topic',
      criteria: { promo: 'Promotion', news: null },
    },
    quality: {
      type: 'score',
      instructions: 'Rate editorial quality',
      criteria: ['poor', 'ok', 'great'],
    },
  },
};

const upstreamBody = {
  model: 'jev-1.13',
  answers: {
    spam: { type: 'noul', noul: 0.12 },
    topic: { type: 'choice', choice: 'promo', probabilities: { promo: 0.9, news: 0.1 }, confidence: 0.9 },
    quality: { type: 'score', score: 1.4, legend: { '0': 'poor' }, probabilities: { '1': 0.6 }, confidence: 0.6 },
  },
  usage: { input_tokens: 120, output_tokens: 0 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createDecisionProvider', () => {
  it('is disabled when DECISION_PROVIDER is unset or unknown', () => {
    expect(createDecisionProvider({})).toBeNull();
    expect(createDecisionProvider({ DECISION_PROVIDER: 'nope' })).toBeNull();
  });

  it('is disabled when the selected provider has no credentials', () => {
    expect(createDecisionProvider({ DECISION_PROVIDER: 'typesafe' })).toBeNull();
    expect(createDecisionProvider({ DECISION_PROVIDER: 'openrouter' })).toBeNull();
    expect(createDecisionProvider({ DECISION_PROVIDER: 'llm' })).toBeNull();
    expect(createDecisionProvider({ DECISION_PROVIDER: 'llm', LLM_PROVIDER: 'echo' })).toBeNull();
  });

  it('resolves TypeSafe Jev with the jev-latest default', () => {
    const configured = createDecisionProvider({
      DECISION_PROVIDER: 'typesafe',
      TYPESAFE_API_KEY: 'ts-key',
    });
    expect(configured?.name).toBe('typesafe');
    expect(configured?.model).toBe('jev-latest');
    expect(configured?.provider).toBeInstanceOf(SystemOneDecisionProvider);
  });

  it('resolves OpenRouter with the OpenRouter model id', () => {
    const configured = createDecisionProvider({
      DECISION_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'or-key',
    });
    expect(configured?.model).toBe('~typesafe/jev-latest');
  });

  it('honours DECISION_MODEL', () => {
    const configured = createDecisionProvider({
      DECISION_PROVIDER: 'typesafe',
      TYPESAFE_API_KEY: 'ts-key',
      DECISION_MODEL: 'jev-1.13',
    });
    expect(configured?.model).toBe('jev-1.13');
  });

  it('treats empty compose passthrough values as unset', () => {
    const configured = createDecisionProvider({
      DECISION_PROVIDER: 'typesafe',
      TYPESAFE_API_KEY: 'ts-key',
      DECISION_MODEL: '',
      TYPESAFE_BASE_URL: '',
    });
    expect(configured?.model).toBe('jev-latest');
  });

  it('wraps the configured LLM for the llm fallback', () => {
    const configured = createDecisionProvider({
      DECISION_PROVIDER: 'llm',
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(configured?.provider).toBeInstanceOf(LLMDecisionProvider);
    expect(configured?.model).toBe('openai:gpt-4o-mini');
  });
});

describe('SystemOneDecisionProvider', () => {
  it('posts state + questions to /systemone and normalises answers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(upstreamBody));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new SystemOneDecisionProvider({ apiKey: 'ts-key' });
    const result = await provider.decide(request);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ts-key');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'jev-latest',
      state: request.state,
      questions: request.questions,
    });

    expect(result).toEqual({
      provider: 'typesafe',
      model: 'jev-1.13',
      calibrated: true,
      answers: {
        spam: { type: 'noul', noul: 0.12 },
        topic: { type: 'choice', choice: 'promo', probabilities: { promo: 0.9, news: 0.1 }, confidence: 0.9 },
        quality: {
          type: 'score',
          score: 1.4,
          legend: { '0': 'poor' },
          probabilities: { '1': 0.6 },
          confidence: 0.6,
        },
      },
      usage: { inputTokens: 120, outputTokens: 0 },
    });
  });

  it.each([null, {}, { noul: 'bad' }, { type: 'score', score: 2 }])(
    'rejects malformed noul answers: %j',
    async (spam) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse({
            ...upstreamBody,
            answers: { ...upstreamBody.answers, spam },
          }),
        ),
      );
      await expect(
        new SystemOneDecisionProvider({ apiKey: 'k' }).decide(request),
      ).rejects.toMatchObject({ code: 'DECISION_PARSE_FAILED' });
    },
  );

  it.each([null, {}, { score: 'bad' }, { type: 'noul', noul: 0.5 }])(
    'rejects malformed score answers: %j',
    async (quality) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse({
            ...upstreamBody,
            answers: { ...upstreamBody.answers, quality },
          }),
        ),
      );
      await expect(
        new SystemOneDecisionProvider({ apiKey: 'k' }).decide(request),
      ).rejects.toMatchObject({ code: 'DECISION_PARSE_FAILED' });
    },
  );

  it.each(['constructor', 'toString', '__proto__'])(
    'rejects inherited option %s',
    async (choice) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse({
            ...upstreamBody,
            answers: { ...upstreamBody.answers, topic: { choice } },
          }),
        ),
      );
      await expect(
        new SystemOneDecisionProvider({ apiKey: 'k' }).decide(request),
      ).rejects.toMatchObject({ code: 'DECISION_PARSE_FAILED' });
    },
  );

  it('accepts an explicitly declared constructor option with finite confidence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          answers: { topic: { choice: 'constructor' } },
        }),
      ),
    );
    const result = await new SystemOneDecisionProvider({ apiKey: 'k' }).decide({
      state: 'x',
      questions: {
        topic: {
          type: 'choice',
          instructions: 'Pick',
          criteria: { constructor: null, news: null },
        },
      },
    });
    expect(result.answers.topic).toEqual({
      type: 'choice',
      choice: 'constructor',
      probabilities: {},
      confidence: 0,
    });
  });

  it('rejects missing answers even when their key exists on Object.prototype', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ answers: {} })));
    await expect(
      new SystemOneDecisionProvider({ apiKey: 'k' }).decide({
        state: 'x',
        questions: { constructor: request.questions.spam! },
      }),
    ).rejects.toMatchObject({ code: 'DECISION_PARSE_FAILED' });
  });

  it('uses the OpenRouter base URL without a trailing slash', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(upstreamBody));
    vi.stubGlobal('fetch', fetchMock);

    await new SystemOneDecisionProvider({
      apiKey: 'or-key',
      baseUrl: 'https://openrouter.ai/api/v1/',
      name: 'openrouter',
    }).decide(request);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/systemone');
  });

  it('retries 429/529 with exponential backoff, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(new Response('overloaded', { status: 529 }))
      .mockResolvedValueOnce(jsonResponse(upstreamBody));
    vi.stubGlobal('fetch', fetchMock);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await new SystemOneDecisionProvider({ apiKey: 'k', retryBaseMs: 100, sleep }).decide(request);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
  });

  it('gives up after maxRetries with DECISION_RATE_LIMITED', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('', { status: 429 })));
    const provider = new SystemOneDecisionProvider({ apiKey: 'k', maxRetries: 1, sleep: async () => {} });

    await expect(provider.decide(request)).rejects.toMatchObject({
      code: 'DECISION_RATE_LIMITED',
      status: 429,
    });
  });

  it('maps 401 to DECISION_AUTH without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad key', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new SystemOneDecisionProvider({ apiKey: 'k', sleep: async () => {} }).decide(request),
    ).rejects.toMatchObject({ code: 'DECISION_AUTH' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a response missing an answer', async () => {
    const { quality: _quality, ...partial } = upstreamBody.answers;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...upstreamBody, answers: partial })));

    await expect(new SystemOneDecisionProvider({ apiKey: 'k' }).decide(request)).rejects.toMatchObject({
      code: 'DECISION_PARSE_FAILED',
    });
  });

  it('rejects a choice outside the declared options', async () => {
    const answers = { ...upstreamBody.answers, topic: { type: 'choice', choice: 'sports' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...upstreamBody, answers })));

    await expect(new SystemOneDecisionProvider({ apiKey: 'k' }).decide(request)).rejects.toBeInstanceOf(
      DecisionProviderError,
    );
  });
});

describe('LLMDecisionProvider', () => {
  function llmReturning(content: string | null): LLMProvider {
    return { chat: vi.fn().mockResolvedValue({ content, toolCalls: [] }) };
  }

  it('uses decision instructions without exposing Copilot tools', async () => {
    const llm = llmReturning(JSON.stringify(upstreamBody));
    await new LLMDecisionProvider(llm, 'm').decide(request);
    expect(llm.chat).toHaveBeenCalledWith([expect.objectContaining({ role: 'user' })], {
      systemPrompt: expect.stringContaining('structured decision engine'),
      tools: false,
    });
  });

  it('parses fenced JSON, clamps scores to rubric levels and fills the legend', async () => {
    const content =
      'Here you go:\n```json\n' +
      JSON.stringify({
        answers: {
          spam: { noul: 1.7 },
          topic: { choice: 'news', probabilities: { news: 0.7, promo: 0.3 } },
          quality: { score: 7, confidence: 0.5 },
        },
      }) +
      '\n```';
    const result = await new LLMDecisionProvider(llmReturning(content), 'openai:gpt-4o-mini').decide(request);

    expect(result.calibrated).toBe(false);
    expect(result.provider).toBe('llm');
    expect(result.answers.spam).toEqual({ type: 'noul', noul: 1 });
    expect(result.answers.topic).toMatchObject({ choice: 'news', confidence: 0.7 });
    expect(result.answers.quality).toMatchObject({
      score: 2,
      legend: { '0': 'poor', '1': 'ok', '2': 'great' },
    });
  });

  it('fails loudly when the LLM returns no JSON', async () => {
    await expect(
      new LLMDecisionProvider(llmReturning('I think it is spam.'), 'm').decide(request),
    ).rejects.toMatchObject({ code: 'DECISION_PARSE_FAILED' });
    await expect(new LLMDecisionProvider(llmReturning(null), 'm').decide(request)).rejects.toMatchObject({
      code: 'DECISION_PARSE_FAILED',
    });
  });
});
