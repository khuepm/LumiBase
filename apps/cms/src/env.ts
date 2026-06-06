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
  /** Direct Postgres connection string (used in local development). */
  DATABASE_URL?: string;
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
  /** Comma-separated frontend origins allowed by CORS. */
  CORS_ALLOWED_ORIGINS?: string;
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
  /** Principal kind. Defaults to `user` when omitted for legacy callers. */
  type?: 'user' | 'api_key';
  /** Users.external_id (resolved from CF Access or OAuth). */
  externalId?: string;
  /** Internal users.id in PostgreSQL database. */
  userId?: string;
  /** Internal api_keys.id for API-key principals. */
  apiKeyId?: string;
  /** Audit-safe API key metadata; never contains plaintext token or token hash. */
  apiKey?: Record<string, unknown>;
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
  /**
   * Resolved client IP for the current request (admin-setup-wizard
   * task 11.2; Req 15.1, 15.2; design §6.2). Populated by the
   * `audit-context` middleware (`withAuditContext`) via
   * {@link import('./modules/login-guard/ip-extract').extractClientIp}
   * so every downstream handler — and the AuditLogger callers — read
   * the SAME canonical IP form the LoginGuard writes into
   * `login_attempts.ip`. Optional: the middleware sets it on the global
   * chain, but a unit-test Hono app that doesn't mount the middleware
   * leaves it unset.
   */
  ip?: string;
  /**
   * Raw `User-Agent` header for the current request (admin-setup-wizard
   * task 11.2; Req 15.2). Populated by the `audit-context` middleware
   * alongside {@link Variables.ip} so audit entries can carry the UA
   * without each handler re-reading the header. `undefined` when the
   * header is absent or the middleware isn't mounted.
   */
  userAgent?: string;
  /** Runtime context providing cache, storage, database, search, queue, and media adapters. */
  runtime: RuntimeContext;
  /**
   * Internal response-type marker for observability/log enrichment.
   * Currently used by `adminPathGuard` (admin-setup-wizard Req 5.2) to
   * tag a request as serving the Studio HTML/asset bundle vs. a regular
   * API response. Optional — most requests leave it unset.
   */
  responseType?: 'STUDIO_HTML';
  /**
   * Test-only injection seam for the public recovery routes
   * (admin-setup-wizard task 10.7; design §4.7, §4.8). When set via
   * `c.set('recoveryServiceOverride', stub)` *before* the recovery
   * router runs, `modules/recovery/routes.ts` uses the stub instead of
   * constructing a real `RecoveryService` — so the route handlers can be
   * exercised without a live Postgres or the in-memory token stores.
   *
   * Declared structurally (rather than importing `RecoveryService`) to
   * keep `env.ts` free of route/service imports and avoid an import
   * cycle. The real `RecoveryService` satisfies this shape, mirroring
   * the `setupServiceOverride` convention referenced in
   * `modules/setup/routes.ts`.
   */
  recoveryServiceOverride?: {
    recover(
      email: string,
      backupCode: string,
      ip: string,
    ): Promise<{
      readonly adminPath: string;
      readonly oneTimeUnlockToken: string;
    } | null>;
    forgotPath(email: string, ip: string): Promise<void>;
    validateUnlockToken(token: string): Promise<{ readonly userId: string } | null>;
  };
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
