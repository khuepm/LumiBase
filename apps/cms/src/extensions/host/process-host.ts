/**
 * Out-of-process extension host — parent side (#990, ADR-015).
 *
 * On Node, an extension bundle can run in its own child process instead of
 * inside the CMS process (`child.ts`). The child starts with:
 *
 *   - an EMPTY environment: no `DATABASE_URL`, `JWT_SECRET`, provider keys or
 *     anything else from the CMS process;
 *   - Node's permission model (`--permission`): no file writes, no child
 *     processes, no worker threads, no native addons; file reads limited to
 *     the host script's directory;
 *   - a heap cap (`--max-old-space-size`, default 128 MB);
 *   - no database connection and no CMS module state.
 *
 * Its only way to the host is `ctx`, and every `ctx` call is answered here by
 * the same capability-checked ctx the in-process sandbox builds, bound to the
 * request that made the call. Capability checks, SSRF guards, the
 * service-account audit and actor-scoped item permissions therefore all stay
 * in the host, where the extension cannot patch them.
 *
 * One child per (site, extension, bundle URL): two tenants never share an
 * extension's module state. Children are reused across requests, and killed
 * on a load failure, an invocation timeout, an update (`evictExtensionProcesses`)
 * or process exit.
 *
 * Not covered: the permission model does not restrict the network, so code in
 * the child can open its own connections (without any credential to use).
 * Network egress control belongs to the container (network policy / egress
 * proxy). Cloudflare Workers keep the in-process sandbox: an isolate per
 * request is already the platform's isolation, and Workers cannot fork.
 *
 * Node built-ins are imported by a variable specifier, so the Workers bundle
 * never pulls in `node:child_process`.
 */
import type { ChildMessage, Invocation, ModuleShape, ParentMessage, SerializedResponse } from './protocol';

export type ExtensionRuntimeKind = 'in-process' | 'process';
export const EXTENSION_RUNTIME_ENV = 'EXTENSION_RUNTIME';
const DEFAULT_INVOKE_TIMEOUT_MS = 10_000;
const MAX_FETCH_BODY_BYTES = 5 * 1024 * 1024;

/** True when running on Cloudflare Workers. */
function isWorkersRuntime(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
}

/**
 * Where extension code runs.
 *   - Cloudflare Workers: always `in-process` (an isolate; no fork).
 *   - Node: `EXTENSION_RUNTIME=process` or `in-process` decides; unset, it is
 *     `process` in production (`LUMIBASE_ENV` / `NODE_ENV`) and `in-process`
 *     elsewhere, so local development and tests keep a single process.
 */
export function resolveExtensionRuntime(env?: Readonly<Record<string, unknown>>): ExtensionRuntimeKind {
  if (isWorkersRuntime()) return 'in-process';
  const read = (key: string) => env?.[key] ?? (typeof process !== 'undefined' ? process.env[key] : undefined);
  const explicit = read(EXTENSION_RUNTIME_ENV);
  if (explicit === 'process') return 'process';
  if (explicit === 'in-process') return 'in-process';
  return read('LUMIBASE_ENV') === 'production' || read('NODE_ENV') === 'production' ? 'process' : 'in-process';
}

/** Set by the Helm chart when `networkPolicy.egress.restrict` is on (#1009). */
export const EGRESS_RESTRICTED_ENV = 'LUMIBASE_EGRESS_RESTRICTED';

/**
 * Startup warning for #1009 (accepted risk, ADR-015): extension code, in
 * process or in its child, can open connections outside `ctx.fetch`. In
 * production with extensions configured, the operator is expected to restrict
 * egress at the network level and say so with `LUMIBASE_EGRESS_RESTRICTED`.
 */
export function extensionEgressWarning(env: Readonly<Record<string, unknown>>): string | null {
  const read = (key: string) => env[key] ?? (typeof process !== 'undefined' ? process.env[key] : undefined);
  const production = read('LUMIBASE_ENV') === 'production' || read('NODE_ENV') === 'production';
  const extensions = typeof read('EXTENSION_BUNDLE_ORIGINS') === 'string' && String(read('EXTENSION_BUNDLE_ORIGINS')).trim() !== '';
  const restricted = ['true', '1', 'yes'].includes(String(read(EGRESS_RESTRICTED_ENV) ?? ''));
  if (!production || !extensions || restricted) return null;
  return `[lumibase-cms] extensions are enabled (EXTENSION_BUNDLE_ORIGINS) but egress is not restricted: extension code can reach cloud metadata and private networks outside ctx.fetch. Restrict egress (Helm networkPolicy.egress.restrict=true, or Docker/firewall rules) and set ${EGRESS_RESTRICTED_ENV}=true.`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeImport = (id: string): Promise<any> => import(/* @vite-ignore */ id);

let builtScript: Promise<string> | null = null;

/**
 * The child entry script: `LUMIBASE_EXTENSION_HOST_SCRIPT`, else the
 * `extension-host.cjs` built next to `serve.cjs` (`build:node`), else (source
 * checkout: `tsx`, tests) `child.ts` bundled on demand into the temp dir.
 * The child is always a self-contained bundle: under `--permission` it cannot
 * spawn a TypeScript loader.
 */
export async function resolveHostScript(): Promise<string> {
  const override = typeof process !== 'undefined' ? process.env.LUMIBASE_EXTENSION_HOST_SCRIPT : undefined;
  if (override) return override;
  const { existsSync } = await nodeImport('node:fs');
  const { join } = await nodeImport('node:path');
  if (typeof __dirname === 'string') {
    const candidate = join(__dirname, 'extension-host.cjs');
    if (existsSync(candidate)) return candidate;
  }
  builtScript ??= (async () => {
    const { fileURLToPath } = await nodeImport('node:url');
    const { tmpdir } = await nodeImport('node:os');
    const { mkdtempSync } = await nodeImport('node:fs');
    const esbuild = await nodeImport('esbuild');
    const outdir = mkdtempSync(join(tmpdir(), 'lumibase-extension-host-'));
    const outfile = join(outdir, 'extension-host.cjs');
    await esbuild.build({
      entryPoints: [fileURLToPath(new URL('./child.ts', import.meta.url))],
      bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
    });
    return outfile;
  })();
  return builtScript;
}

/** Answers one `ctx` call for one invocation. */
export type CtxDispatch = (path: string, args: unknown[]) => Promise<unknown>;

/**
 * Dispatch a child's `ctx` call to the host ctx built by the sandbox
 * (`ExtensionSandbox.buildCtx`), which performs every capability check.
 */
export function ctxDispatcher(ctx: {
  items: Record<string, (...a: never[]) => Promise<unknown>>;
  db: Record<string, (...a: never[]) => Promise<unknown>>;
  fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  kv: Record<string, (...a: never[]) => Promise<unknown>>;
  env: Record<string, unknown>;
}): CtxDispatch {
  return async (path, args) => {
    const [group, method] = path.split('.') as [string, string | undefined];
    if (group === 'fetch') {
      const [url, init] = args as [string, RequestInit | undefined];
      const res = await ctx.fetch(url, init);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_FETCH_BODY_BYTES) throw new Error('Response body is too large for an out-of-process extension.');
      const out: SerializedResponse = { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: buf };
      return out;
    }
    if (group === 'env' && method === 'get') return ctx.env[String(args[0])];
    if ((group === 'items' || group === 'db' || group === 'kv') && method) {
      const fn = (ctx[group] as Record<string, unknown>)[method];
      if (typeof fn === 'function') return (fn as (...a: unknown[]) => Promise<unknown>)(...args);
    }
    throw new Error(`Unknown ctx call "${path}".`);
  };
}

interface ChildProcessLike {
  send(message: ParentMessage): boolean;
  on(event: 'message', fn: (m: ChildMessage) => void): unknown;
  on(event: 'exit', fn: (code: number | null) => void): unknown;
  kill(signal?: string): boolean;
  connected: boolean;
}

export class ExtensionProcess {
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; dispatch: CtxDispatch }>();
  private seq = 0;
  private loadDispatch: CtxDispatch | null = null;
  private exited = false;
  shape: ModuleShape = { hooks: [], tools: [], handler: false, cdc: false };

  private constructor(private readonly child: ChildProcessLike, private readonly onExit: () => void) {
    child.on('message', (m) => this.onMessage(m));
    child.on('exit', () => {
      this.exited = true;
      for (const p of this.pending.values()) p.reject(new Error('Extension process exited.'));
      this.pending.clear();
      this.onExit();
    });
  }

  static async spawn(opts: { heapMb?: number; onExit: () => void }): Promise<ExtensionProcess> {
    const script = await resolveHostScript();
    const { fork } = await nodeImport('node:child_process');
    const { dirname } = await nodeImport('node:path');
    const child = fork(script, [], {
      env: {},
      execArgv: ['--permission', `--allow-fs-read=${dirname(script)}`, `--max-old-space-size=${opts.heapMb ?? 128}`],
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }) as ChildProcessLike;
    return new ExtensionProcess(child, opts.onExit);
  }

  get alive(): boolean {
    return !this.exited && this.child.connected;
  }

  load(url: string, name: string, dispatch: CtxDispatch, timeoutMs: number): Promise<ModuleShape> {
    this.loadDispatch = dispatch;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kill();
        reject(new Error(`load timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const listener = (m: ChildMessage) => {
        if (m.t === 'loaded') {
          clearTimeout(timer);
          // ctx calls outside an invocation (timers) get no request's authority.
          this.loadDispatch = null;
          this.shape = m.shape;
          resolve(m.shape);
        } else if (m.t === 'load-failed') {
          clearTimeout(timer);
          this.loadDispatch = null;
          this.kill();
          reject(new Error(m.error));
        }
      };
      this.child.on('message', listener);
      this.child.send({ t: 'load', url, name });
    });
  }

  invoke(invocation: Invocation, dispatch: CtxDispatch, timeoutMs = DEFAULT_INVOKE_TIMEOUT_MS): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error('Extension process is not running.'));
    const id = `i${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A hung extension is not trusted to recover: end it, the next call respawns.
        this.kill();
        reject(new Error(`Extension call timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        dispatch,
      });
      this.child.send({ t: 'invoke', id, ...invocation } as ParentMessage);
    });
  }

  kill(): void {
    if (!this.exited) this.child.kill('SIGKILL');
  }

  private onMessage(m: ChildMessage): void {
    if (m.t === 'result') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error));
      return;
    }
    if (m.t === 'ctx') {
      const dispatch = m.invocation === 'load' ? this.loadDispatch : this.pending.get(m.invocation)?.dispatch;
      const reply = (msg: ParentMessage) => { if (this.alive) this.child.send(msg); };
      if (!dispatch) {
        reply({ t: 'ctx-result', id: m.id, ok: false, error: 'No active invocation for this ctx call.' });
        return;
      }
      dispatch(m.path, m.args).then(
        (value) => reply({ t: 'ctx-result', id: m.id, ok: true, value }),
        (err: unknown) => reply({ t: 'ctx-result', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }
}

const pool = new Map<string, Promise<ExtensionProcess>>();

/**
 * Pool key: one child per site, extension, bundle URL and verified SHA-256 of
 * the bytes it runs. A different digest is a different child.
 */
export function processKey(siteId: string | null | undefined, name: string, bundleUrl: string, digest: string): string {
  return `${siteId ?? '-'}\u0000${name}\u0000${bundleUrl}\u0000${digest}`;
}

/** End children of the same site and extension that run other bytes than `key`. */
export async function evictOtherExtensionDigests(key: string): Promise<void> {
  const [site, name] = key.split('\u0000');
  for (const [other, entry] of [...pool]) {
    if (other === key) continue;
    const [otherSite, otherName] = other.split('\u0000');
    if (otherSite !== site || otherName !== name) continue;
    pool.delete(other);
    (await entry.catch(() => null))?.kill();
  }
}

/** A loaded child for this key, spawning (and loading) one when needed. */
export async function acquireExtensionProcess(input: {
  key: string;
  url: string;
  name: string;
  dispatch: CtxDispatch;
  timeoutMs: number;
}): Promise<ExtensionProcess> {
  const existing = pool.get(input.key);
  if (existing) {
    const proc = await existing.catch(() => null);
    if (proc?.alive) return proc;
    pool.delete(input.key);
  }
  const created = (async () => {
    const proc = await ExtensionProcess.spawn({ onExit: () => { if (pool.get(input.key) === created) pool.delete(input.key); } });
    await proc.load(input.url, input.name, input.dispatch, input.timeoutMs);
    return proc;
  })();
  pool.set(input.key, created);
  created.catch(() => { if (pool.get(input.key) === created) pool.delete(input.key); });
  return created;
}

/** End the children of one extension (all sites), or all of them. */
export async function evictExtensionProcesses(name?: string): Promise<void> {
  for (const [key, entry] of [...pool]) {
    if (name !== undefined && key.split('\u0000')[1] !== name) continue;
    pool.delete(key);
    (await entry.catch(() => null))?.kill();
  }
}

/** Number of live pool entries (tests, diagnostics). */
export function extensionProcessCount(): number {
  return pool.size;
}

/**
 * The `ExtensionModule` the sandbox returns for a child: hooks, MCP tools and
 * the endpoint handler are stubs that forward to the child, each call answering
 * `ctx` with `dispatch` (the calling sandbox's capability-checked ctx).
 */
export function remoteModule(proc: ExtensionProcess, dispatch: CtxDispatch) {
  const hooks: Record<string, (arg: unknown) => Promise<void | Record<string, unknown>>> = {};
  for (const event of proc.shape.hooks) {
    hooks[event] = async (arg) => (await proc.invoke({ kind: 'hook', event, arg }, dispatch)) as void | Record<string, unknown>;
  }
  const tools = proc.shape.tools.map((tool) => ({
    name: tool,
    handler: (args: Record<string, unknown>, ctx: { siteId: string; runId: string | null }) =>
      proc.invoke({ kind: 'mcp', tool, args, ctx }, dispatch),
  }));
  const handler = proc.shape.handler
    ? (app: unknown) => {
        (app as { all: (path: string, fn: (c: { req: { raw: Request } }) => Promise<Response>) => void }).all('*', async (c) => {
          const raw = c.req.raw;
          const body = raw.method === 'GET' || raw.method === 'HEAD' ? undefined : new Uint8Array(await raw.arrayBuffer());
          const res = (await proc.invoke(
            { kind: 'http', request: { method: raw.method, url: raw.url, headers: Object.fromEntries(raw.headers.entries()), body } },
            dispatch,
          )) as SerializedResponse;
          return new Response(res.body as BodyInit | null, { status: res.status, headers: res.headers });
        });
      }
    : undefined;
  const cdcSubscriber = proc.shape.cdc
    ? {
        // `logger` is a Console and cannot cross the boundary; the child supplies its own.
        handler: async (input: { events: unknown[]; ctx: { siteId: string; config: Record<string, unknown> } }) => {
          await proc.invoke({ kind: 'cdc', events: input.events, ctx: { siteId: input.ctx.siteId, config: input.ctx.config } }, dispatch);
        },
      }
    : undefined;
  return { hooks, mcp: { tools }, handler, cdcSubscriber };
}
