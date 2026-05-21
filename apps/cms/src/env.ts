import type { Database } from '@lumibase/database';
import type { RuntimeContext } from '@lumibase/runtime';

/**
 * Cloudflare Worker bindings. Configure in `wrangler.toml`.
 *
 * - HYPERDRIVE: pooled Postgres connection string via Cloudflare Hyperdrive.
 * - CONFIG_CACHE: KV namespace for config + permission caches (Strict Rule #4).
 * - MEDIA: R2 bucket for asset storage.
 */
export interface Bindings {
  HYPERDRIVE?: Hyperdrive;
  /** @deprecated Use `c.get('runtime').cache` (CacheProvider) instead of accessing KV directly. */
  CONFIG_CACHE?: KVNamespace;
  /** @deprecated Use `c.get('runtime').storage` (StorageProvider) instead of accessing R2 directly. */
  MEDIA?: R2Bucket;
  /** SiteRoom Durable Object namespace — one DO instance per siteId. */
  SITE_ROOM?: DurableObjectNamespace;
  LUMIBASE_ENV: string;
  /** Runtime mode: `'cloudflare'` or `'docker'`. Defaults to `'docker'`. */
  LUMIBASE_RUNTIME?: string;
  /** Logto OIDC issuer, e.g. https://auth.lumibase.dev/oidc */
  LOGTO_ISSUER?: string;
  /** Expected `aud` claim, e.g. https://api.lumibase.dev */
  LOGTO_AUDIENCE?: string;
  /** When set to `"true"`, withAuth allows dev tokens (skip JWKS verify). */
  LUMIBASE_DEV_AUTH?: string;
  /** Secret key for AES-GCM per-field encryption (base64 encoded). */
  ENCRYPTION_KEY?: string;
}

/**
 * Authenticated principal resolved by `withAuth`.
 */
export interface AuthPrincipal {
  /** `sub` claim from Logto (== users.logto_id). */
  logtoId: string;
  /** Internal users.id, resolved lazily. May be undefined on first login. */
  userId?: string;
  email?: string;
  roles?: string[];
  raw: Record<string, unknown>;
}

/**
 * Per-request variables hung off Hono's context.
 */
export interface Variables {
  db: Database;
  /** Active site id (Strict Rule #2). Set by `withTenant`. */
  siteId: string;
  /** Authenticated principal. Set by `withAuth`. */
  auth: AuthPrincipal;
  /** Correlation id for log lines. */
  requestId: string;
  /** Runtime context providing cache, storage, database, search, queue, and media adapters. */
  runtime: RuntimeContext;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
