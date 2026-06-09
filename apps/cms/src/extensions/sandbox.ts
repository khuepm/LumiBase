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
import { validateOutboundUrl } from '../services/ssrf-guard';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExtensionCapability =
  | 'db:read'
  | 'db:write'
  | 'service-account'
  | 'http:fetch'
  | 'kv:read'
  | 'kv:write'
  | 'env:read'
  | 'queue:enqueue';

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
  }>;
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

interface SandboxLoadOptions {
  /** Extension identifier (for logging). */
  name: string;
  /** URL to the extension ESM bundle. */
  bundleUrl: string;
  /** Declared capabilities from the manifest. */
  capabilities: string[];
  /** Timeout in ms before the load is aborted. Default: 5000. */
  timeoutMs?: number;
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

    if (!this.isTrustedBundleUrl(opts.bundleUrl)) {
      console.error(
        `[extension-sandbox] refused to load "${opts.name}" from an untrusted bundle URL`,
      );
      return null;
    }

    const caps = new Set(opts.capabilities);

    // Build capability-checked proxy context passed to the extension.
    const ctx = this.buildCtx(caps, opts.name);

    try {
      const mod = await this.importWithTimeout(opts.bundleUrl, opts.timeoutMs ?? 5000);

      // The extension's default export must be a factory that receives ctx.
      const extensionMod: ExtensionModule =
        typeof mod.default === 'function' ? await mod.default(ctx) : mod;

      this.cache.set(opts.name, extensionMod);
      return extensionMod;
    } catch (err) {
      console.error(`[extension-sandbox] failed to load "${opts.name}"`, err);
      return null;
    }
  }

  /** Evict an extension from the cache (e.g. after update). */
  evict(name: string): void {
    this.cache.delete(name);
  }

  /** Evict all cached extensions. */
  evictAll(): void {
    this.cache.clear();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private buildCtx(caps: Set<string>, name: string) {
    const gate = (cap: ExtensionCapability) => {
      if (!caps.has(cap)) throw new CapabilityError(cap);
    };

    return {
      /**
       * Actor-scoped item access. This is the default extension data path:
       * calls are routed through the host ItemService, so row/field/action
       * permissions are evaluated for the request principal.
       */
      items: {
        list: (collection: string, params?: Record<string, unknown>) => {
          if (!this.actorDataAccess) throw new Error('Actor data access is not available in this context.');
          return this.actorDataAccess.list(collection, params);
        },
        detail: (collection: string, id: string, fields?: string[]) => {
          if (!this.actorDataAccess) throw new Error('Actor data access is not available in this context.');
          return this.actorDataAccess.detail(collection, id, fields);
        },
        create: (collection: string, payload: { data: Record<string, unknown>; status?: string; sort?: number }) => {
          if (!this.actorDataAccess) throw new Error('Actor data access is not available in this context.');
          return this.actorDataAccess.create(collection, payload);
        },
        patch: (collection: string, id: string, patch: { data?: Record<string, unknown>; status?: string; sort?: number }) => {
          if (!this.actorDataAccess) throw new Error('Actor data access is not available in this context.');
          return this.actorDataAccess.patch(collection, id, patch);
        },
        delete: (collection: string, id: string) => {
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
