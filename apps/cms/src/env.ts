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
  /** Cloudflare Access Certificates URL (JWKS format) */
  CF_ACCESS_CERTS_URL?: string;
  /** Cloudflare Access Application Audience (AUD) */
  CF_ACCESS_AUDIENCE?: string;
  /** Secret key for signing internal Custom JWTs (for frontend users) */
  JWT_SECRET?: string;
  /** When set to `"true"`, withAuth allows dev tokens (skip JWKS verify). */
  LUMIBASE_DEV_AUTH?: string;
  /** Secret key for AES-GCM per-field encryption (base64 encoded). */
  ENCRYPTION_KEY?: string;
  // ── LLM Provider (POST-GA Task #1) ──────────────────────────────────────
  /** `'openai'` | `'anthropic'` | `'workers-ai'` | `'echo'` (default). */
  LLM_PROVIDER?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  WORKERS_AI_ACCOUNT_ID?: string;
  WORKERS_AI_API_TOKEN?: string;
  /** Optional Workers AI gateway URL override. */
  WORKERS_AI_GATEWAY?: string;
}

/**
 * Authenticated principal resolved by `withAuth`.
 */
export interface AuthPrincipal {
  /** Users.external_id (resolved from CF Access or OAuth). */
  externalId?: string;
  /** Internal users.id in PostgreSQL database. */
  userId?: string;
  email?: string;
  roles?: string[];
  /** Flag to identify if this principal is a frontend end-user (authenticated via Custom JWT) */
  isFrontendUser?: boolean;
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
