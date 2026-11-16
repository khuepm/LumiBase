import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLLMProvider, LLM_REQUEST_TIMEOUT_MS, LLMNetworkError, LLMResponseError } from '../llm-provider';

/** Headers arrive at once; the body stalls until the request signal aborts. */
function stallingBodyFetch() {
  return vi.fn((_url: unknown, init: RequestInit) => Promise.resolve(new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"choices":'));
      init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
}

describe('#583 aborts while the body streams are transport outcomes', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it.each(environments)('$LLM_PROVIDER maps the provider deadline mid-body to a network failure', async (env) => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const fetcher = stallingBodyFetch();
    vi.stubGlobal('fetch', fetcher);
    const pending = createLLMProvider(env).chat([{ role: 'user', content: 'read' }]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    deadline.abort(new DOMException('synthetic deadline', 'TimeoutError'));
    await expect(pending).rejects.toBeInstanceOf(LLMNetworkError);
  });
  it('keeps caller cancellation mid-body on its original error path', async () => {
    const caller = new AbortController();
    const fetcher = stallingBodyFetch();
    vi.stubGlobal('fetch', fetcher);
    const pending = createLLMProvider(environments[0]!).chat([{ role: 'user', content: 'read' }], { signal: caller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const reason = new Error('caller cancelled');
    caller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
  it('still reports a truncated body without an abort as an unusable response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"choices":', { status: 200 })));
    await expect(createLLMProvider(environments[0]!).chat([{ role: 'user', content: 'read' }])).rejects.toBeInstanceOf(LLMResponseError);
  });
});

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
