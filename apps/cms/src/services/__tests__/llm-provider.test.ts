import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicProvider,
  EchoProvider,
  GeminiProvider,
  OpenAIProvider,
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
