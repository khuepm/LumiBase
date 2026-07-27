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
  /** Semver package/application version for the deployed LumiBase build. */
  LUMIBASE_VERSION?: string;
  /** Source-control revision used for this build. */
  LUMIBASE_GIT_SHA?: string;
  /** ISO-8601 timestamp for when this build artifact was produced. */
  LUMIBASE_BUILD_TIME?: string;
  /** Release track for the artifact, e.g. development, staging, production. */
  LUMIBASE_RELEASE_CHANNEL?: string;
  /** Runtime mode: `'cloudflare'` or `'docker'`. Defaults to `'docker'`. */
  LUMIBASE_RUNTIME?: string;
  // ── Email service (services/email/*) ────────────────────────────────────
  /** SMTP connection string (nodemailer format) for the Docker/Node runtime. */
  LUMIBASE_SMTP_URL?: string;
  /** Default envelope sender for all outbound mail. Falls back to no-reply@lumibase.local. */
  LUMIBASE_MAIL_FROM?: string;
  /** Optional default Reply-To applied to outbound mail. */
  LUMIBASE_MAIL_REPLY_TO?: string;
  /** Operator kill switch: set to `"false"` to disable all email sending. */
  LUMIBASE_MAIL_ENABLED?: string;
  /** Comma-separated cc list for security notifications (legacy name kept). */
  LUMIBASE_SECURITY_RECIPIENTS?: string;
  // ── Web Push / VAPID (push-noti feature) ────────────────────────────────
  /** VAPID application server public key (base64url, raw 65-byte P-256 point). */
  VAPID_PUBLIC_KEY?: string;
  /** VAPID application server private scalar `d` (base64url, 32 bytes). */
  VAPID_PRIVATE_KEY?: string;
  /** VAPID contact `sub` claim — a `mailto:` or `https:` URI. */
  VAPID_SUBJECT?: string;
  /**
   * Max concurrent audience (public-plane) realtime sessions per subject on the
   * Node WebSocket hub. `0`/unset disables the cap. (realtime-audience-channels)
   */
  LUMIBASE_REALTIME_MAX_CONNECTIONS_PER_SUBJECT?: string;
  /** Direct Postgres connection string (used in local development). */
  DATABASE_URL?: string;
  /** Cloudflare Access Certificates URL (JWKS format) */
  CF_ACCESS_CERTS_URL?: string;
  /** Cloudflare Access Application Audience (AUD) */
  CF_ACCESS_AUDIENCE?: string;
  /** Secret key for signing internal Custom JWTs (for frontend users) */
  JWT_SECRET?: string;
  /**
   * Session-token TTL for the `studio` realm (staff/CMS). Accepts a
   * compact duration (`12h`, `30m`, `7d`) or a number of seconds.
   * Defaults to `12h`. Invalid values fall back to the default.
   */
  STUDIO_SESSION_TTL?: string;
  /**
   * Session-token TTL for the `frontend` realm (subscribers). Accepts a
   * compact duration (`30d`, `12h`) or a number of seconds. Defaults to
   * `30d`. Invalid values fall back to the default.
   */
  FRONTEND_SESSION_TTL?: string;
  /**
   * Refresh-token TTL for the `studio` realm — the "stay logged in"
   * horizon over which a short access token is silently renewed. Defaults
   * to `30d`. Invalid values fall back to the default.
   */
  STUDIO_REFRESH_TTL?: string;
  /** Refresh-token TTL for the `frontend` realm. Defaults to `90d`. */
  FRONTEND_REFRESH_TTL?: string;
  /**
   * Refresh cookie `SameSite`: `Lax` (default) | `Strict` | `None`. Use
   * `None` when the frontend is on a different site/domain than the API
   * (cross-site) — browsers then also require `Secure`, which is forced.
   */
  REFRESH_COOKIE_SAMESITE?: string;
  /** Refresh cookie `Domain`, e.g. `.example.com` to share across subdomains. */
  REFRESH_COOKIE_DOMAIN?: string;
  /** `"false"` allows the refresh cookie over plain http (local dev only). */
  REFRESH_COOKIE_SECURE?: string;
  /** When set to `"true"`, withAuth allows dev tokens (skip JWKS verify). */
  LUMIBASE_DEV_AUTH?: string;
  /** Secret key for AES-GCM per-field encryption (base64 encoded). */
  ENCRYPTION_KEY?: string;
  /** Comma-separated trusted origins for executable extension bundles. */
  EXTENSION_BUNDLE_ORIGINS?: string;
  /** JSON map `{ keyId: pem }` of publisher public keys (merged with the DB registry). */
  MARKETPLACE_PUBLIC_KEYS?: string;
  /** Signature enforcement for third-party extensions: `'require'` (default) | `'warn'`. */
  LUMIBASE_EXT_SIGNATURE_POLICY?: string;
  /** Comma-separated frontend origins allowed by CORS. */
  CORS_ALLOWED_ORIGINS?: string;
  /** Data-retention horizon (days) for the `activity` log. 0/unset = disabled. */
  LUMIBASE_ACTIVITY_RETENTION_DAYS?: string;
  /** Data-retention horizon (days) for read/archived `notifications`. 0/unset = disabled. */
  LUMIBASE_NOTIFICATION_RETENTION_DAYS?: string;
  /** Maximum bytes accepted by the file upload policy. Defaults to 10 MiB. */
  FILE_UPLOAD_MAX_BYTES?: string;
  /** Comma-separated MIME allowlist accepted by the file upload policy. */
  FILE_UPLOAD_ALLOWED_MIME_TYPES?: string;
  /** Bearer token required to read Prometheus metrics in production. */
  METRICS_TOKEN?: string;
  /** Delivery API shared-cache lifetime in seconds (`0` disables public caching). Default 60. */
  LUMIBASE_DELIVER_SMAXAGE?: string;
  /** Delivery API stale-while-revalidate window in seconds. Default 300. */
  LUMIBASE_DELIVER_SWR?: string;
  /** Debounce window (seconds) for API-key `lastUsedAt` writes. Default 60; `0` = touch every request. */
  LUMIBASE_APIKEY_TOUCH_INTERVAL?: string;
  /** Max JSON request body in bytes for the app-level guard. Default 1 MiB. */
  LUMIBASE_MAX_JSON_BODY?: string;
  /** Set to 'true' to disable the general API rate limiter (CWE-400). */
  LUMIBASE_RATE_LIMIT_DISABLED?: string;
  /** Max requests per window for the general API rate limiter (default 300). */
  LUMIBASE_RATE_LIMIT_MAX?: string;
  /** Window length in seconds for the general API rate limiter (default 60). */
  LUMIBASE_RATE_LIMIT_WINDOW_S?: string;
  /**
   * Set to 'true' to make the general API rate limiter fail CLOSED (503) when
   * the runtime cache is missing or errors, instead of the default fail-open
   * behaviour. Use in hardened deployments where the throttle is load-bearing.
   */
  LUMIBASE_RATE_LIMIT_FAIL_CLOSED?: string;
  /** Max static cost accepted per GraphQL operation (default 1000). */
  LUMIBASE_GQL_MAX_COST?: string;
  /** List multiplier for GraphQL list fields lacking a literal pagination arg (default 20). */
  LUMIBASE_GQL_DEFAULT_LIST_SIZE?: string;
  /** Upper clamp on a GraphQL list field's cost multiplier (default 100). */
  LUMIBASE_GQL_MAX_LIST_MULTIPLIER?: string;
  /**
   * Sentry DSN for the Cloudflare Workers build. When unset, `withSentry`
   * in `cloudflare.ts` initializes with an empty DSN and Sentry becomes a
   * no-op — so local dev / Docker / tests stay clean. Set per environment
   * with `wrangler secret put SENTRY_DSN --env <environment>`.
   */
  SENTRY_DSN?: string;
  /**
   * Trace sampling ratio (0–1) for Sentry on the Workers build. Defaults
   * to 1.0 (capture every transaction) when unset or unparseable.
   */
  SENTRY_TRACES_SAMPLE_RATE?: string;
  // ── LLM Provider (POST-GA Task #1) ──────────────────────────────────────
  /**
   * `'openai'` | `'anthropic'` | `'claude'` | `'gemini'` | `'nvidia'`
   * | `'vertex'` | `'workers-ai'` | `'echo'` (default).
   */
  LLM_PROVIDER?: string;
  /** Provider-specific model override. */
  LLM_MODEL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  /** NVIDIA hosted inference (build.nvidia.com / NIM) API key. */
  NVIDIA_API_KEY?: string;
  /** Optional NVIDIA endpoint override (e.g. a self-hosted NIM container). */
  NVIDIA_BASE_URL?: string;
  /** OAuth 2.0 bearer for Vertex AI (e.g. `gcloud auth print-access-token`). Billed to GCP, not AWS. */
  VERTEX_ACCESS_TOKEN?: string;
  /** Google Cloud project id that owns the Vertex AI models. */
  VERTEX_PROJECT_ID?: string;
  /** Vertex AI region. Defaults to `us-central1`. */
  VERTEX_LOCATION?: string;
  WORKERS_AI_ACCOUNT_ID?: string;
  WORKERS_AI_API_TOKEN?: string;
  /** Optional Workers AI gateway URL override. */
  WORKERS_AI_GATEWAY?: string;
  // ── Custom domains / Cloudflare for SaaS (services/domains/*) ───────────
  /** API token with `SSL and Certificates: Edit` on the SaaS zone. */
  CLOUDFLARE_API_TOKEN?: string;
  /** Zone id that owns the Custom Hostnames + fallback origin. */
  CLOUDFLARE_ZONE_ID?: string;
  /** Hostname operators CNAME to (proxied fallback origin), e.g. `cname.lumibase.dev`. */
  LUMIBASE_SAAS_FALLBACK?: string;
  /** Reserved suffix offered for free subdomains. Defaults to `lumibase.dev`. */
  LUMIBASE_FREE_DOMAIN_SUFFIX?: string;
  // ── Git integration (modules/git-integration) ───────────────────────────
  /** Public origin used to build operator-facing webhook URLs (e.g. https://api.example.com). */
  LUMIBASE_PUBLIC_URL?: string;
  /** GitHub OAuth app client id (for PAT/OAuth connect flow). */
  GITHUB_CLIENT_ID?: string;
  /** GitHub OAuth app client secret. */
  GITHUB_CLIENT_SECRET?: string;
  /** GitHub App id (for installation-token minting). */
  GITHUB_APP_ID?: string;
  /** GitHub App private key, PKCS#8 PEM. */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** GitLab OAuth application id. */
  GITLAB_CLIENT_ID?: string;
  /** GitLab OAuth application secret. */
  GITLAB_CLIENT_SECRET?: string;
}

/**
 * Authenticated principal resolved by `withAuth`.
 */
export interface AuthPrincipal {
  /** Principal kind. Defaults to `user` when omitted for legacy callers. */
  type?: 'user' | 'api_key' | 'anonymous';
  /** Users.external_id (resolved from CF Access or OAuth). */
  externalId?: string;
  /** Internal users.id in PostgreSQL database. */
  userId?: string;
  /**
   * Role bound directly to the principal rather than through a membership.
   * Set for `anonymous` principals, which resolve to the site's `public`
   * role — `PermissionService` reads it as `ctx.roleId`.
   */
  roleId?: string;
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
  /**
   * Test-only injection seam for the public setup routes. When set via
   * `c.set('setupServiceOverride', stub)` *before* the setup router runs,
   * `modules/setup/routes.ts` uses the stub instead of constructing a real
   * `SetupService` — so `POST /setup/complete` can be exercised without a
   * live Postgres. Declared structurally (only the `complete` method the
   * route calls) to keep `env.ts` free of route/service imports, mirroring
   * `recoveryServiceOverride`. The real `SetupService` satisfies this shape.
   */
  setupServiceOverride?: {
    complete(
      input: unknown,
      ctx: unknown,
    ): Promise<
      | { readonly ok: true; readonly value: unknown }
      | { readonly ok: false; readonly error: unknown }
    >;
  };
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
