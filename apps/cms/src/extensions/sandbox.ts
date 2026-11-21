/**
 * ExtensionSandbox — isolated execution environment for CMS extensions.
 *
 * Loads an extension bundle from a URL and wraps it in a capability-checked
 * proxy context. Only capabilities declared in the extension manifest are
 * accessible; any other access throws a CapabilityError.
 *
 * Supported capabilities:
 *  - "db:read"       — read-only DB queries (SELECT)
 *  - "db:write"      — insert/update/delete on items
 *  - "http:fetch"    — outbound HTTP requests
 *  - "kv:read"       — KV namespace reads
 *  - "kv:write"      — KV namespace writes
 *  - "env:read"      — access to declared env vars
 *  - "queue:enqueue" — enqueue jobs to a queue
 *  - "items:read" / "items:read:<collection>" — actor-scoped item reads
 *  - "items:write" / "items:write:<collection>" — actor-scoped item writes
 *
 * The sandbox uses dynamic import() to load the bundle only after the
 * bundle URL passes the trusted-origin policy configured by the operator.
 *
 * Usage:
 *   const sandbox = new ExtensionSandbox(env, db);
 *   const ext = await sandbox.load({ bundleUrl, capabilities, name });
 *   // ext is typed as ExtensionModule
 *   await ext?.hooks?.['items.create.before']?.({ item, collection });
 */

import type { Database } from '@lumibase/database';
import { guardedFetch, validateOutboundUrl } from '../services/ssrf-guard';
import { formatSafeError } from '@lumibase/contracts/utils';
import {
  acquireExtensionProcess, ctxDispatcher, evictExtensionProcesses, processKey, remoteModule, resolveExtensionRuntime,
} from './host/process-host';
import {
  devBuildAppliesToSite,
  devExtensionRegistry,
  type DevExtensionBuild,
  type DevExtensionSnapshot,
} from './dev-reload/registry';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExtensionCapability =
  | 'db:read'
  | 'db:write'
  | 'service-account'
  | 'http:fetch'
  | 'kv:read'
  | 'kv:write'
  | 'env:read'
  | 'queue:enqueue'
  | 'items:read'
  | 'items:write'
  | `items:read:${string}`
  | `items:write:${string}`;

export interface ExtensionHookContext {
  collection: string;
  item?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  itemId?: string;
  userId?: string | null;
  siteId?: string;
}

export type HookFn = (ctx: ExtensionHookContext) => Promise<void | Record<string, unknown>>;

export interface ExtensionActorDataAccess {
  list: (collection: string, params?: Record<string, unknown>) => Promise<unknown>;
  detail: (collection: string, id: string, fields?: string[]) => Promise<unknown>;
  create: (collection: string, payload: { data: Record<string, unknown>; status?: string; sort?: number }) => Promise<unknown>;
  patch: (collection: string, id: string, patch: { data?: Record<string, unknown>; status?: string; sort?: number }) => Promise<unknown>;
  delete: (collection: string, id: string) => Promise<unknown>;
}

export type ExtensionServiceAccountAudit = (event: {
  extensionName: string;
  operation: 'query' | 'execute';
  statement: string;
}) => Promise<void>;

export interface ExtensionModule {
  /** Lifecycle hooks for item mutations. */
  hooks?: Partial<{
    'items.create.before': HookFn;
    'items.create.after': HookFn;
    'items.update.before': HookFn;
    'items.update.after': HookFn;
    'items.delete.before': HookFn;
    'items.delete.after': HookFn;
    'items.export.before': HookFn;
  }>;
  /**
   * MCP tool handlers (#715), matched by name against the manifest's
   * `mcp.tools`. Only `handler` is read from the bundle; everything that is
   * listed comes from the manifest.
   */
  mcp?: {
    tools?: Array<{
      name: string;
      handler: (args: Record<string, unknown>, ctx: { siteId: string; runId: string | null }) => Promise<unknown>;
    }>;
  };
  /** Endpoint handler — called when a request hits /extensions/:name/* */
  handler?: (app: unknown) => void;
  /** Interface / Display / Layout / Panel for Studio */
  ui?: {
    component?: unknown; // React component
    type?: 'interface' | 'display' | 'layout' | 'panel' | 'module';
  };
}

export class CapabilityError extends Error {
  constructor(capability: string) {
    super(`Extension does not have capability: "${capability}"`);
    this.name = 'CapabilityError';
  }
}

export class SandboxLoadError extends Error {
  constructor(bundleUrl: string, cause?: unknown) {
    super(`Failed to load extension from "${bundleUrl}": ${String(cause)}`);
    this.name = 'SandboxLoadError';
  }
}

/**
 * Signature-verification gate for the load path. Returns whether the bundle is
 * trusted; the caller (route) supplies this so the sandbox stays free of DB and
 * `@lumibase/contracts/extensions` imports. Resolves `true` to allow load.
 */
export type SandboxVerify = () => Promise<boolean>;

interface SandboxLoadOptions {
  /** Extension identifier (for logging). */
  name: string;
  /** URL to the extension ESM bundle. */
  bundleUrl: string;
  /** Declared capabilities from the manifest. */
  capabilities: string[];
  /** Timeout in ms before the load is aborted. Default: 5000. */
  timeoutMs?: number;
  /** Server-derived official flag — official extensions MUST verify (fail-closed). */
  isOfficial?: boolean;
  /** Force signature verification even for third-party (site policy). */
  requireSignature?: boolean;
  /**
   * Verifier invoked when `isOfficial || requireSignature`. Must return true to
   * allow the load. If required but not supplied, the load fails closed.
   */
  verify?: SandboxVerify;
  /**
   * Site of the request. Only used to decide whether a dev hot-reload build
   * (`lumibase-ext dev --site`) applies; ignored outside local development.
   */
  siteId?: string | null;
}

interface SandboxEnv {
  /** Cloudflare KV binding (optional). */
  CONFIG_CACHE?: KVNamespace;
  /**
   * Comma-separated list of trusted extension bundle origins. Extension
   * execution is disabled unless this allowlist is explicitly configured.
   */
  EXTENSION_BUNDLE_ORIGINS?: string;
  /** Extension-accessible env vars. */
  [key: string]: unknown;
}

// ─── Sandbox ─────────────────────────────────────────────────────────────────

export class ExtensionSandbox {
  private readonly cache = new Map<string, ExtensionModule>();
  /**
   * Dev hot-reload generation pinned for this sandbox's lifetime (one request):
   * a reload that lands mid-request never mixes versions within it. Always
   * empty unless the guarded Node dev client activated the registry (#754).
   */
  private readonly devSnapshot: DevExtensionSnapshot = devExtensionRegistry.snapshot();

  constructor(
    private readonly env: SandboxEnv,
    private readonly db?: Database,
    private readonly actorDataAccess?: ExtensionActorDataAccess,
    private readonly serviceAccountAudit?: ExtensionServiceAccountAudit,
  ) {}

  /**
   * Load and cache an extension module.
   * Returns null if the bundle cannot be loaded (error is logged).
   */
  async load(opts: SandboxLoadOptions): Promise<ExtensionModule | null> {
    if (this.cache.has(opts.name)) {
      return this.cache.get(opts.name)!;
    }

    // Local-development hot reload (#754): a build pushed by `lumibase-ext dev`
    // replaces the installed bundle. The snapshot is empty in production (the
    // registry refuses to activate there), so this branch is dev-only.
    const devBuild = this.devSnapshot.get(opts.name);
    if (devBuild && devBuildAppliesToSite(devBuild, opts.siteId)) {
      return this.loadDevBuild(opts, devBuild);
    }

    if (!this.isTrustedBundleUrl(opts.bundleUrl)) {
      console.error(
        `[extension-sandbox] refused to load "${opts.name}" from an untrusted bundle URL`,
      );
      return null;
    }

    // Signature gate (fail-closed for official / when signature is required).
    // Runs BEFORE import + cache so an unverifiable official bundle never
    // executes and is never cached. A missing verifier when one is required is
    // treated as a failure, not a bypass.
    if (opts.isOfficial || opts.requireSignature) {
      const ok = opts.verify ? await opts.verify() : false;
      if (!ok) {
        console.error(
          `[extension-sandbox] refused to load "${opts.name}": signature verification failed (official=${Boolean(
            opts.isOfficial,
          )})`,
        );
        return null;
      }
    }

    const caps = new Set(opts.capabilities);

    // Build capability-checked proxy context passed to the extension.
    const ctx = this.buildCtx(caps, opts.name);

    // Out-of-process host on Node (#990): same gates above, same ctx below,
    // but the bundle runs in a child process with no env and no host state.
    if (resolveExtensionRuntime(this.env as unknown as Record<string, unknown>) === 'process') {
      return this.loadInProcessHost(opts, ctx);
    }

    try {
      const mod = await this.importWithTimeout(opts.bundleUrl, opts.timeoutMs ?? 5000);

      // The extension's default export must be a factory that receives ctx.
      const extensionMod: ExtensionModule =
        typeof mod.default === 'function' ? await mod.default(ctx) : mod;

      this.cache.set(opts.name, extensionMod);
      return extensionMod;
    } catch (err) {
      console.error(`[extension-sandbox] failed to load "${opts.name}"`, formatSafeError(err));
      return null;
    }
  }

  /**
   * Hook extensions hot-reloaded for `siteId` (dev only) — lets a dispatcher
   * run an extension under development before it is installed in the DB.
   */
  devHookBuilds(siteId: string | null | undefined): DevExtensionBuild[] {
    return [...this.devSnapshot.values()].filter(
      (b) => b.type === 'hook' && devBuildAppliesToSite(b, siteId),
    );
  }

  private async loadDevBuild(opts: SandboxLoadOptions, build: DevExtensionBuild): Promise<ExtensionModule | null> {
    const ctx = this.buildCtx(new Set(opts.capabilities), opts.name);
    try {
      const mod = build.module;
      const extensionMod: ExtensionModule =
        typeof mod.default === 'function'
          ? await (mod.default as (c: typeof ctx) => ExtensionModule | Promise<ExtensionModule>)(ctx)
          : (mod as ExtensionModule);
      this.cache.set(opts.name, extensionMod);
      return extensionMod;
    } catch (err) {
      console.error(`[extension-sandbox] dev build of "${opts.name}" v${build.version} failed to initialise`, formatSafeError(err));
      return null;
    }
  }

  private async loadInProcessHost(opts: SandboxLoadOptions, ctx: ReturnType<ExtensionSandbox['buildCtx']>): Promise<ExtensionModule | null> {
    const bundleGuard = validateExtensionBundleUrl(opts.bundleUrl);
    if (!bundleGuard.allowed) {
      console.error(`[extension-sandbox] refused to load "${opts.name}": ${bundleGuard.reason ?? 'bundle URL not allowed'}`);
      return null;
    }
    const dispatch = ctxDispatcher(ctx as unknown as Parameters<typeof ctxDispatcher>[0]);
    try {
      const key = processKey(opts.siteId, opts.name, opts.bundleUrl);
      const proc = await acquireExtensionProcess({
        key,
        // The child has no network authority of ours and Node cannot import
        // an https URL: the host downloads the (trusted, verified) bundle and
        // hands the child its source — only when a child is spawned, not on
        // every load of an extension whose child is already running.
        url: () => this.fetchBundleSource(opts.bundleUrl),
        name: opts.name,
        dispatch,
        timeoutMs: opts.timeoutMs ?? 5000,
      });
      const mod = remoteModule(proc, dispatch) as unknown as ExtensionModule;
      this.cache.set(opts.name, mod);
      return mod;
    } catch (err) {
      console.error(`[extension-sandbox] failed to load "${opts.name}" out of process`, formatSafeError(err));
      return null;
    }
  }

  /**
   * The bundle as a `data:` URL for the out-of-process host: downloaded
   * through the SSRF guard (DNS re-checked), redirects refused, at most 5 MB.
   */
  protected async fetchBundleSource(bundleUrl: string): Promise<string> {
    if (bundleUrl.startsWith('data:')) return bundleUrl;
    const res = await guardedFetch(bundleUrl, { redirect: 'error' }, { allowLocalhost: isLoopbackUrl(bundleUrl), allowPrivateNetwork: isLoopbackUrl(bundleUrl) });
    if (!res.ok) throw new SandboxLoadError(bundleUrl, `bundle download failed with HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_REMOTE_BUNDLE_BYTES) throw new SandboxLoadError(bundleUrl, 'bundle is larger than 5 MB');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:text/javascript;base64,${btoa(binary)}`;
  }

  /** Evict an extension from the cache (e.g. after update), and end its host processes. */
  evict(name: string): void {
    this.cache.delete(name);
    void evictExtensionProcesses(name);
  }

  /** Evict all cached extensions, and end every host process. */
  evictAll(): void {
    this.cache.clear();
    void evictExtensionProcesses();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private buildCtx(caps: Set<string>, name: string) {
    const gate = (cap: ExtensionCapability) => {
      if (!caps.has(cap)) throw new CapabilityError(cap);
    };
    const gateItems = (access: 'read' | 'write', collection: string) => {
      const baseCap = `items:${access}` as const;
      const collectionCap = `${baseCap}:${collection}` as const;
      if (!caps.has(baseCap) && !caps.has(collectionCap)) {
        throw new CapabilityError(collectionCap);
      }
    };

    return {
      /**
       * Actor-scoped item access. Calls are routed through the host ItemService,
       * so row/field/action permissions are evaluated for the request principal.
       * Extensions must also be granted items:read/items:write, or a
       * collection-scoped variant such as items:read:posts.
       */
      items: {
        list: async (collection: string, params?: Record<string, unknown>) => {
          gateItems('read', collection);
          if (!this.actorDataAccess) throw new Error('Actor data access is not available in this context.');
          return this.actorDataAccess.list(collection, params);
        },
        detail: async (collection: string, id: string, fields?: string[]) => {
          gateItems('read', collection);
          if (!this.actorDataAccess) throw new Error('Actor data access is not available in this context.');
          return this.actorDataAccess.detail(collection, id, fields);
        },
        create: async (collection: string, payload: { data: Record<string, unknown>; status?: string; sort?: number }) => {
          gateItems('write', collection);
          if (!this.actorDataAccess) throw new Error('Actor data access is not available in this context.');
          return this.actorDataAccess.create(collection, payload);
        },
        patch: async (collection: string, id: string, patch: { data?: Record<string, unknown>; status?: string; sort?: number }) => {
          gateItems('write', collection);
          if (!this.actorDataAccess) throw new Error('Actor data access is not available in this context.');
          return this.actorDataAccess.patch(collection, id, patch);
        },
        delete: async (collection: string, id: string) => {
          gateItems('write', collection);
          if (!this.actorDataAccess) throw new Error('Actor data access is not available in this context.');
          return this.actorDataAccess.delete(collection, id);
        },
      },

      /** Read-only DB helper — SELECT only. */
      db: {
        query: async (sqlStr: string, _params?: unknown[]) => {
          gate('db:read');
          gate('service-account');
          if (!this.db) throw new Error('DB not available in this environment.');
          // Safety: allow only SELECT statements.
          const trimmed = sqlStr.trim().toUpperCase();
          if (!trimmed.startsWith('SELECT')) {
            throw new CapabilityError('db:read (non-SELECT query blocked)');
          }
          await this.serviceAccountAudit?.({ extensionName: name, operation: 'query', statement: sqlStr });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (this.db as any).execute(sqlStr);
        },
        /** Write access — INSERT / UPDATE / DELETE. */
        execute: async (sqlStr: string, _params?: unknown[]) => {
          gate('db:write');
          gate('service-account');
          if (!this.db) throw new Error('DB not available in this environment.');
          await this.serviceAccountAudit?.({ extensionName: name, operation: 'execute', statement: sqlStr });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (this.db as any).execute(sqlStr);
        },
      },

      /** Outbound HTTP — guarded by http:fetch capability. */
      fetch: async (input: RequestInfo, init?: RequestInit) => {
        gate('http:fetch');
        const guarded = validateOutboundUrl(requestInfoToUrl(input));
        if (!guarded.allowed) {
          throw new Error(guarded.reason ?? 'Outbound URL is not allowed.');
        }
        return globalThis.fetch(input, init);
      },

      /** KV store — read and write guarded separately. */
      kv: {
        get: async (key: string) => {
          gate('kv:read');
          return this.env.CONFIG_CACHE?.get(key) ?? null;
        },
        put: async (key: string, value: string, opts?: KVNamespacePutOptions) => {
          gate('kv:write');
          return this.env.CONFIG_CACHE?.put(key, value, opts);
        },
        delete: async (key: string) => {
          gate('kv:write');
          return this.env.CONFIG_CACHE?.delete(key);
        },
      },

      /** Env vars — only EXTENSION_* prefixed keys are exposed. */
      env: new Proxy(
        {},
        {
          get: (_: object, prop: string) => {
            gate('env:read');
            const key = String(prop);
            if (!key.startsWith('EXTENSION_')) {
              throw new CapabilityError(`env:read (key "${key}" not allowed; must start with EXTENSION_)`);
            }
            return this.env[key];
          },
        },
      ),

      /** Extension metadata — always available. */
      meta: { name },
    };
  }

  private isTrustedBundleUrl(bundleUrl: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(bundleUrl);
    } catch {
      return false;
    }

    if (!['https:', 'http:'].includes(parsed.protocol)) {
      return false;
    }

    if (
      parsed.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
    ) {
      return false;
    }

    const trustedOrigins = String(
      this.env.EXTENSION_BUNDLE_ORIGINS ??
        (typeof process !== 'undefined' ? process.env.EXTENSION_BUNDLE_ORIGINS : '') ??
        '',
    )
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);

    if (trustedOrigins.length === 0) {
      return false;
    }

    return trustedOrigins.includes(parsed.origin);
  }

  private importWithTimeout(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const bundleGuard = validateExtensionBundleUrl(url);
    if (!bundleGuard.allowed) {
      return Promise.reject(new SandboxLoadError(url, bundleGuard.reason));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SandboxLoadError(url, `load timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );

      // Dynamic import — works in both Workers (from R2/CDN URL) and browsers.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      import(/* @vite-ignore */ url)
        .then((mod) => {
          clearTimeout(timer);
          resolve(mod as Record<string, unknown>);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(new SandboxLoadError(url, err));
        });
    });
  }
}


const MAX_REMOTE_BUNDLE_BYTES = 5 * 1024 * 1024;

/** `http://localhost` bundles are allowed by the trust policy (local development). */
function isLoopbackUrl(raw: string): boolean {
  try {
    const { protocol, hostname } = new URL(raw);
    return protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

function requestInfoToUrl(input: RequestInfo): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function validateExtensionBundleUrl(raw: string): { allowed: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: 'Extension bundle URL is invalid.' };
  }

  if (url.protocol === 'data:') {
    return { allowed: url.pathname.startsWith('text/javascript'), reason: 'Only JavaScript data URLs are allowed.' };
  }

  return validateOutboundUrl(raw);
}
