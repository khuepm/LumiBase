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
 * The sandbox uses dynamic import() to load the bundle. Workers/Browsers
 * require the bundle to be a valid ESM module served from a trusted URL.
 *
 * Usage:
 *   const sandbox = new ExtensionSandbox(env, db);
 *   const ext = await sandbox.load({ bundleUrl, capabilities, name });
 *   // ext is typed as ExtensionModule
 *   await ext?.hooks?.['items.create.before']?.({ item, collection });
 */

import type { Database } from '@lumibase/database';

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

  private importWithTimeout(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
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
