import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLLMProvider, LLM_REQUEST_TIMEOUT_MS } from '../llm-provider';

const environments = [
  { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'test' },
  { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test' },
  { LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'test' },
  { LLM_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'test' },
  { LLM_PROVIDER: 'vertex', VERTEX_ACCESS_TOKEN: 'test', VERTEX_PROJECT_ID: 'test' },
  { LLM_PROVIDER: 'workers-ai', WORKERS_AI_ACCOUNT_ID: 'test', WORKERS_AI_API_TOKEN: 'test' },
];
describe('#583 all network providers honor one bounded attempt', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it.each(environments)('$LLM_PROVIDER aborts an unresponsive upstream and never executes a fallback tool', async (env) => {
    const deadline = new AbortController();
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const fetcher = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const pending = createLLMProvider(env).chat([{ role: 'user', content: 'delete everything' }]);
    deadline.abort(new Error('synthetic deadline'));
    await expect(pending).rejects.toThrow();
    expect(timer).toHaveBeenCalledWith(LLM_REQUEST_TIMEOUT_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('caller cancellation takes precedence over the longer provider timer', async () => {
    const caller = new AbortController();
    const fetcher = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const pending = createLLMProvider(environments[0]!).chat([{ role: 'user', content: 'read' }], { signal: caller.signal });
    caller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
