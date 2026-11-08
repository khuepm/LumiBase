import { describe, expect, it, vi, afterEach } from 'vitest';
import { boundLLMContext, createConfiguredLLMProvider, createLLMProvider, LLMContextLimitError } from '../llm-provider';

describe('#582 context input and output budget', () => {
  afterEach(() => vi.unstubAllGlobals());
  const options = { tools: false, systemPrompt: 'Policy must remain intact', contextWindowTokens: 2048, maxOutputTokens: 256 };
  it('drops old turns while keeping policy messages and the complete newest user turn', () => {
    const messages = [
      { role: 'user' as const, content: 'old'.repeat(600) },
      { role: 'assistant' as const, content: 'old reply' },
      { role: 'system' as const, content: 'tenant policy' },
      { role: 'user' as const, content: 'newest exact request' },
    ];
    const result = boundLLMContext(messages, options);
    expect(result).toContainEqual(messages[2]);
    expect(result.at(-1)).toEqual(messages[3]);
    expect(result).not.toContainEqual(messages[0]);
    expect(messages).toHaveLength(4);
  });
  it.each(['a'.repeat(2048), '越南語'.repeat(400), '😀'.repeat(600)])('rejects oversized single messages before network I/O', async (content) => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const provider = createLLMProvider({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic', LLM_CONTEXT_WINDOW_TOKENS: '2048' });
    await expect(provider.chat([{ role: 'user', content }], options)).rejects.toBeInstanceOf(LLMContextLimitError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('never drops oversized system policy or tool definitions to make a request fit', () => {
    expect(() => boundLLMContext([{ role: 'user', content: 'hi' }], { ...options, systemPrompt: 'p'.repeat(3000) })).toThrow(LLMContextLimitError);
    expect(() => boundLLMContext([{ role: 'user', content: 'hi' }], { ...options, tools: true })).toThrow(LLMContextLimitError);
  });
  it.each([0, -1, 2048, Infinity, 2.5])('rejects invalid output reserve %s', (maxOutputTokens) => {
    expect(() => boundLLMContext([], { ...options, maxOutputTokens })).toThrow(LLMContextLimitError);
  });
  it.each([
    { LLM_MODEL: 'private-small-model' },
    { LLM_CONTEXT_WINDOW_TOKENS: 'not-a-number' },
    { LLM_CONTEXT_WINDOW_TOKENS: '0' },
  ])('refuses model calls without a usable window (%o) before network I/O', async (extra) => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const provider = createLLMProvider({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic', ...extra });
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(LLMContextLimitError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('builds providers eagerly without throwing, so routes that never call a model keep working', () => {
    const env = { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic', LLM_MODEL: 'private-small-model' };
    expect(() => createLLMProvider(env)).not.toThrow();
    expect(createConfiguredLLMProvider(env)).not.toBeNull();
  });
  it.each(['', '   '])('treats a blank window (%j, as compose passes it) as unset for a known model', async (blank) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })));
    vi.stubGlobal('fetch', fetcher);
    const provider = createLLMProvider({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic', LLM_MODEL: '', LLM_CONTEXT_WINDOW_TOKENS: blank });
    await expect(provider.chat([{ role: 'user', content: 'hi' }], { tools: false })).resolves.toMatchObject({ content: 'ok' });
  });
  it('accepts a custom model name once its window is configured', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })));
    vi.stubGlobal('fetch', fetcher);
    const provider = createLLMProvider({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic', LLM_MODEL: 'private-small-model', LLM_CONTEXT_WINDOW_TOKENS: '16384' });
    await expect(provider.chat([{ role: 'user', content: 'hi' }], { tools: false })).resolves.toMatchObject({ content: 'ok' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('actionable provider failures', () => {
  it('classifies failures without exposing provider response bodies', async () => {
    const { publicLLMFailure, LLMHttpError, LLMNetworkError, LLMResponseError } = await import('../llm-provider');
    for (const [error, code] of [
      [new LLMHttpError(429, 'private prompt'), 'LLM_RATE_LIMIT'],
      [new LLMHttpError(401, 'private prompt'), 'LLM_PROVIDER_ERROR'],
      [new LLMNetworkError('private prompt'), 'LLM_UNAVAILABLE'],
      [new LLMResponseError('private prompt'), 'LLM_INVALID_RESPONSE'],
    ] as const) {
      const result = publicLLMFailure(error);
      expect(result?.code).toBe(code);
      expect(result?.message).not.toContain('private prompt');
    }
  });
});
