import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicProvider,
  EchoProvider,
  GeminiProvider,
  NvidiaProvider,
  OpenAIProvider,
  VertexProvider,
  WorkersAIProvider,
  createLLMProvider,
} from '../llm-provider';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createLLMProvider', () => {
  it('defaults to echo when no provider is configured', () => {
    expect(createLLMProvider({})).toBeInstanceOf(EchoProvider);
  });

  it('falls back to echo when a provider key is missing', () => {
    expect(createLLMProvider({ LLM_PROVIDER: 'openai' })).toBeInstanceOf(EchoProvider);
    expect(createLLMProvider({ LLM_PROVIDER: 'anthropic' })).toBeInstanceOf(EchoProvider);
    expect(createLLMProvider({ LLM_PROVIDER: 'gemini' })).toBeInstanceOf(EchoProvider);
  });

  it('supports Claude as an alias for Anthropic', () => {
    expect(
      createLLMProvider({
        LLM_PROVIDER: 'claude',
        ANTHROPIC_API_KEY: 'test-key',
      }),
    ).toBeInstanceOf(AnthropicProvider);
  });

  it('creates a Gemini provider when GEMINI_API_KEY is configured', () => {
    expect(
      createLLMProvider({
        LLM_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'test-key',
      }),
    ).toBeInstanceOf(GeminiProvider);
  });

  it('creates an NVIDIA provider when NVIDIA_API_KEY is configured', () => {
    const provider = createLLMProvider({
      LLM_PROVIDER: 'nvidia',
      NVIDIA_API_KEY: 'test-key',
    });
    expect(provider).toBeInstanceOf(NvidiaProvider);
    // NVIDIA reuses the OpenAI-compatible surface.
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it('falls back to echo when the NVIDIA key is missing', () => {
    expect(createLLMProvider({ LLM_PROVIDER: 'nvidia' })).toBeInstanceOf(EchoProvider);
  });

  it('creates a Vertex provider when token and project are configured', () => {
    expect(
      createLLMProvider({
        LLM_PROVIDER: 'vertex',
        VERTEX_ACCESS_TOKEN: 'ya29.token',
        VERTEX_PROJECT_ID: 'my-project',
      }),
    ).toBeInstanceOf(VertexProvider);
  });

  it('falls back to echo when Vertex is missing token or project', () => {
    expect(
      createLLMProvider({ LLM_PROVIDER: 'vertex', VERTEX_ACCESS_TOKEN: 'ya29.token' }),
    ).toBeInstanceOf(EchoProvider);
    expect(
      createLLMProvider({ LLM_PROVIDER: 'vertex', VERTEX_PROJECT_ID: 'my-project' }),
    ).toBeInstanceOf(EchoProvider);
  });
});

describe('provider model overrides', () => {
  it('passes LLM_MODEL to OpenAI requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = createLLMProvider({
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'gpt-4.1-nano',
      OPENAI_API_KEY: 'test-key',
    });

    await provider.chat([{ role: 'user', content: 'list collections' }]);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { model: string };
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(body.model).toBe('gpt-4.1-nano');
  });

  it('passes LLM_MODEL to Anthropic requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = createLLMProvider({
      LLM_PROVIDER: 'anthropic',
      LLM_MODEL: 'claude-3-5-haiku-latest',
      ANTHROPIC_API_KEY: 'test-key',
    });

    await provider.chat([{ role: 'user', content: 'list collections' }]);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { model: string };
    expect(body.model).toBe('claude-3-5-haiku-latest');
  });

  it('passes LLM_MODEL to Gemini requests and parses function calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'listCollections',
                      args: {},
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = createLLMProvider({
      LLM_PROVIDER: 'gemini',
      LLM_MODEL: 'gemini-3.5-flash',
      GEMINI_API_KEY: 'test-key',
    });

    const result = await provider.chat([{ role: 'user', content: 'list collections' }]);

    expect(fetchMock.mock.calls[0]![0]).toContain('/models/gemini-3.5-flash:generateContent');
    expect(result.toolCalls).toEqual([{ name: 'listCollections', arguments: {} }]);
  });
});

describe('NvidiaProvider', () => {
  it('calls the NVIDIA endpoint with a bearer key and the OpenAI schema', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [{ function: { name: 'listCollections', arguments: '{}' } }],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NvidiaProvider('nvapi-test', 'meta/llama-3.1-70b-instruct');
    const result = await provider.chat([{ role: 'user', content: 'list collections' }]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer nvapi-test');
    const body = JSON.parse(init!.body as string) as { model: string };
    expect(body.model).toBe('meta/llama-3.1-70b-instruct');
    expect(result.toolCalls).toEqual([{ name: 'listCollections', arguments: {} }]);
  });

  it('honors a self-hosted NIM base URL override', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = createLLMProvider({
      LLM_PROVIDER: 'nvidia',
      NVIDIA_API_KEY: 'nvapi-test',
      NVIDIA_BASE_URL: 'http://nim.internal:8000/v1/',
    });
    await provider.chat([{ role: 'user', content: 'hi' }]);

    // Trailing slash is trimmed before appending the path.
    expect(fetchMock.mock.calls[0]![0]).toBe('http://nim.internal:8000/v1/chat/completions');
  });
});

describe('VertexProvider', () => {
  it('targets the region/project endpoint with an OAuth bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'listCollections', args: {} } }],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new VertexProvider({
      accessToken: 'ya29.token',
      projectId: 'my-project',
      location: 'asia-southeast1',
      model: 'gemini-3.5-flash',
    });
    const result = await provider.chat([{ role: 'user', content: 'list collections' }]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://asia-southeast1-aiplatform.googleapis.com/v1/projects/my-project/' +
        'locations/asia-southeast1/publishers/google/models/gemini-3.5-flash:generateContent',
    );
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer ya29.token');
    expect(result.toolCalls).toEqual([{ name: 'listCollections', arguments: {} }]);
  });

  it('defaults the location to us-central1', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new VertexProvider({ accessToken: 'ya29.token', projectId: 'p' });
    await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(fetchMock.mock.calls[0]![0]).toContain('us-central1-aiplatform.googleapis.com');
  });
});

describe('specialized LLM callers', () => {
  it.each([
    ['openai', () => new OpenAIProvider('key'), { choices: [{ message: { content: 'ok' } }] }],
    ['nvidia', () => new NvidiaProvider('key'), { choices: [{ message: { content: 'ok' } }] }],
    ['anthropic', () => new AnthropicProvider('key'), { content: [{ type: 'text', text: 'ok' }] }],
    ['gemini', () => new GeminiProvider('key'), { candidates: [] }],
    [
      'vertex',
      () => new VertexProvider({ accessToken: 'key', projectId: 'project' }),
      { candidates: [] },
    ],
    [
      'workers-ai',
      () => new WorkersAIProvider({ accountId: 'account', apiToken: 'key' }),
      { result: { response: 'ok' } },
    ],
  ] as const)('%s replaces the system prompt and omits tools', async (_name, create, response) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetchMock);
    await create().chat([{ role: 'user', content: 'state' }], {
      systemPrompt: 'Return decision JSON only.',
      tools: false,
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.toolConfig).toBeUndefined();
    const system =
      body.system ?? body.systemInstruction?.parts[0]?.text ?? body.messages[0]?.content;
    expect(system).toBe('Return decision JSON only.');
    expect(JSON.stringify(body)).not.toContain('LumiBase AI Copilot');
  });
});
