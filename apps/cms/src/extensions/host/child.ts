/**
 * Out-of-process extension host — child side (#990).
 *
 * Runs ONE extension bundle in its own Node process, started by
 * `process-host.ts` with an empty environment, Node's permission model
 * (`--permission`: no file writes, no child processes, no workers, no native
 * addons; reads limited to this script's directory) and a heap cap. The
 * process holds no secrets, no database connection and no host module state:
 * everything the extension may reach goes through `ctx`, whose every call is
 * sent to the parent and checked there against the extension's declared
 * capabilities and the calling request's principal.
 *
 * Protocol (structured-clone IPC, see `protocol.ts`):
 *   parent → child  { t: 'load', url }                 import + factory(ctx)
 *                   { t: 'invoke', id, kind, … }        hook / mcp / http
 *                   { t: 'ctx-result', id, ok, value }   answer to a ctx call
 *   child → parent  { t: 'loaded', shape } | { t: 'load-failed', error }
 *                   { t: 'result', id, ok, value }
 *                   { t: 'ctx', id, invocation, path, args }
 *
 * Each invocation runs inside an AsyncLocalStorage scope holding its id, so a
 * ctx call made while serving request A is answered with request A's ctx,
 * even when invocations overlap.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Hono } from 'hono';
import type { ChildMessage, ParentMessage, ModuleShape, SerializedResponse } from './protocol';

const scope = new AsyncLocalStorage<string>();
const pendingCtx = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let ctxSeq = 0;
let loaded: Record<string, unknown> | null = null;
let app: Hono | null = null;

function send(message: ChildMessage): void {
  process.send?.(message);
}

function callHost(path: string, args: unknown[]): Promise<unknown> {
  const invocation = scope.getStore() ?? 'load';
  const id = `c${++ctxSeq}`;
  return new Promise((resolve, reject) => {
    pendingCtx.set(id, { resolve, reject });
    send({ t: 'ctx', id, invocation, path, args });
  });
}

/** `fetch` crosses the boundary as data: the parent returns status, headers and body. */
async function remoteFetch(input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as { url?: string }).url);
  const res = (await callHost('fetch', [url, init ? { method: init.method, headers: init.headers, body: init.body } : undefined])) as SerializedResponse;
  return new Response(res.body as BodyInit | null, { status: res.status, headers: res.headers });
}

function buildCtx(name: string) {
  const call = (path: string) => (...args: unknown[]) => callHost(path, args);
  return {
    items: { list: call('items.list'), detail: call('items.detail'), create: call('items.create'), patch: call('items.patch'), delete: call('items.delete') },
    db: { query: call('db.query'), execute: call('db.execute') },
    fetch: remoteFetch,
    kv: { get: call('kv.get'), put: call('kv.put'), delete: call('kv.delete') },
    /** Env reads are async out of process: `await ctx.env.EXTENSION_X`. */
    env: new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' && prop !== 'then' ? callHost('env.get', [prop]) : undefined) }),
    meta: { name },
  };
}

function shapeOf(mod: Record<string, unknown>): ModuleShape {
  const hooks = mod.hooks && typeof mod.hooks === 'object' ? Object.keys(mod.hooks).filter((k) => typeof (mod.hooks as Record<string, unknown>)[k] === 'function') : [];
  const tools = Array.isArray((mod.mcp as { tools?: unknown } | undefined)?.tools)
    ? ((mod.mcp as { tools: Array<{ name?: unknown; handler?: unknown }> }).tools)
        .filter((t) => typeof t?.name === 'string' && typeof t.handler === 'function')
        .map((t) => t.name as string)
    : [];
  const cdc = typeof (mod.cdcSubscriber as { handler?: unknown } | undefined)?.handler === 'function';
  return { hooks, tools, handler: typeof mod.handler === 'function', cdc };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function invoke(message: Extract<ParentMessage, { t: 'invoke' }>): Promise<unknown> {
  if (!loaded) throw new Error('Extension is not loaded.');
  if (message.kind === 'hook') {
    const fn = (loaded.hooks as Record<string, (arg: unknown) => unknown> | undefined)?.[message.event];
    if (typeof fn !== 'function') return undefined;
    return fn(message.arg);
  }
  if (message.kind === 'mcp') {
    const tool = (loaded.mcp as { tools?: Array<{ name: string; handler: (a: unknown, c: unknown) => unknown }> } | undefined)
      ?.tools?.find((t) => t.name === message.tool);
    if (!tool) throw new Error(`Tool "${message.tool}" is not exported.`);
    return tool.handler(message.args, message.ctx);
  }
  if (message.kind === 'cdc') {
    const handler = (loaded.cdcSubscriber as { handler?: (i: unknown) => unknown } | undefined)?.handler;
    if (typeof handler !== 'function') throw new Error('Extension does not export a CDC subscriber.');
    await handler({ events: message.events, ctx: { ...message.ctx, logger: console } });
    return undefined;
  }
  // http
  if (!app) {
    if (typeof loaded.handler !== 'function') throw new Error('Extension does not export a handler.');
    const next = new Hono();
    (loaded.handler as (a: Hono) => void)(next);
    app = next;
  }
  const req = message.request;
  const res = await app.fetch(new Request(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined && req.method !== "GET" && req.method !== "HEAD" ? { body: req.body as BodyInit } : {}),
  }));
  const out: SerializedResponse = { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: new Uint8Array(await res.arrayBuffer()) };
  return out;
}

process.on('message', (raw: unknown) => {
  const message = raw as ParentMessage;
  if (message.t === 'ctx-result') {
    const pending = pendingCtx.get(message.id);
    if (!pending) return;
    pendingCtx.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error));
    return;
  }
  if (message.t === 'load') {
    void (async () => {
      try {
        const mod = (await import(/* @vite-ignore */ message.url)) as Record<string, unknown>;
        const ctx = buildCtx(message.name);
        loaded = typeof mod.default === 'function'
          ? ((await scope.run('load', () => (mod.default as (c: unknown) => unknown)(ctx))) as Record<string, unknown>)
          : mod;
        send({ t: 'loaded', shape: shapeOf(loaded ?? {}) });
      } catch (err) {
        send({ t: 'load-failed', error: errorText(err) });
      }
    })();
    return;
  }
  if (message.t === 'invoke') {
    void scope.run(message.id, async () => {
      try {
        send({ t: 'result', id: message.id, ok: true, value: await invoke(message) });
      } catch (err) {
        send({ t: 'result', id: message.id, ok: false, error: errorText(err) });
      }
    });
  }
});

// The parent going away ends this process.
process.on('disconnect', () => process.exit(0));
