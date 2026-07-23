# Anti-Abuse Mechanisms & Best Practices

## Overview

This document is the single reference for how LumiBase defends against abuse —
brute-force, credential stuffing, enumeration, resource exhaustion, SSRF,
cross-tenant access, and runaway AI agents. LumiBase ships a range of controls
spread across middleware, modules, and services. The goals here are to (1) map
what exists and where, (2) state the best practice each control embodies so new
code follows the same pattern, and (3) list the known gaps so they are chosen
deliberately, not by accident.

For the deeper runtime-guard design and the CWE-mapped audit, see the companion
docs cross-linked in [Related docs](#related-docs) — this page stays at the
map/best-practice altitude and does not duplicate their detail.

The guiding principle is **defense-in-depth**: no single layer is trusted to be
sufficient. Each layer assumes the one in front of it can be bypassed.

## Layered model

```
┌─ Upstream (CDN / WAF) ──────── DDoS, IP reputation, bot mitigation (Cloudflare / Caddy)
│
├─ Middleware ───────────────── security headers, body limit, generic rate limit,
│    apps/cms/src/middleware/     control-plane guard, file-upload policy
│
├─ App logic ────────────────── login-guard, anomaly scoring, recovery limits,
│    apps/cms/src/modules/        AI load-guard, SSRF guard, GraphQL depth limit
│    apps/cms/src/services/
│
├─ Database (RLS) ───────────── per-tenant row isolation, WITH CHECK on writes
│    packages/database/migrations/rls-policies.sql
│
└─ Audit ────────────────────── secret-masked, non-throwing record of every
     apps/cms/src/modules/audit/    security decision (deny, lock, block, anomaly)
```

The application layer owns brute-force, anomaly, and business-level abuse.
Generic volumetric/DDoS and bot mitigation are expected upstream (see
[Gaps](#gaps--recommendations)).

## Existing mechanisms (registry)

### 1. Rate limiting & brute-force defense

**Best practice:** limit on multiple keys (IP *and* account), return `429`/`423`
with `Retry-After`, and never let a denied request extend the window.

- **Per-IP login limiter** — `apps/cms/src/modules/login-guard/counter.ts` counts
  `result='fail'` rows in `login_attempts` over `lockoutWindowSeconds`. It is
  **Postgres-backed** (`PostgresCounterStore`), so the sliding window is shared
  across processes and Workers isolates. Threshold has a hard floor of 3
  (`Math.max(3, policy.ipMaxFailedAttempts)`, see `login-guard/middleware.ts`);
  crossing it returns `429 IP_BLOCKED` with `Retry-After` bounded by
  `ipLockoutDurationSeconds`.
- **Account lockout** — `apps/cms/src/modules/login-guard/middleware.ts` blocks
  login while `users.lockedUntil > now()` and returns `423 ACCOUNT_LOCKED`.
- **Recovery limiter** — `apps/cms/src/modules/recovery/rate-limit.ts` enforces a
  **shared** 3 requests / IP / hour budget across *both* `/recover` and
  `/forgot-path` (keyed by IP alone, so an attacker cannot double the budget by
  splitting across the two paths). Fixed window; `Retry-After` shrinks
  monotonically. This limiter is **in-memory per process** (see
  [Gaps](#gaps--recommendations)).
- **Setup brakes** — the public setup surface (mounted *before* auth, reachable
  only while uninitialized) is throttled per IP in
  `apps/cms/src/modules/setup/routes.ts`: `GET /setup/state` at 60 req / 60 s,
  and `POST /setup/complete` at **10 req / 60 s** on its own bucket. The
  `/complete` brake runs *before* the body is parsed or a password is hashed, so
  it blunts `setupToken` brute-force and hashing-CPU spam in the bootstrap
  window at zero cost per blocked request. Returns `429 RATE_LIMITED` +
  `Retry-After`. The hard guard against a duplicate first admin remains the
  `SELECT … FOR UPDATE` on the `system_state` singleton plus a unique index —
  this brake is defence-in-depth. It is **in-memory per isolate** (see
  [Gaps](#gaps--recommendations)).
- **Generic API throttle** — `apps/cms/src/middleware/rate-limit.ts`
  (`withRateLimit`) is a coarse fixed-window safety net over the authenticated
  REST/GraphQL surface: default 300 req / 60 s (`LUMIBASE_RATE_LIMIT_MAX` /
  `_WINDOW_S`), keyed by principal (`userId`/`apiKeyId`) else IP, **scoped per
  site** so one tenant cannot exhaust another's budget. Returns `429 RATE_LIMITED`
  with `X-RateLimit-*` headers. Backed by the runtime cache (KV on Workers); it
  **fails open** and is not a precise quota.
- **Policy** — login thresholds live in the `settings` table
  (`login_security_policy`) with a `STANDARD_LOCKOUT_POLICY` fallback, so
  operators tune limits without redeploying.

### 2. Enumeration & timing hardening

**Best practice:** identical response shape and timing whether or not the account
exists; normalize identifiers before lookup.

- `apps/cms/src/modules/login-guard/email-normalize.ts` trims and lowercases the
  email so `Foo@Bar` and `foo@bar` share one counter and one lookup path.
- The login guard keeps query timing uniform regardless of email existence
  (see the `loginStallMs` policy field for a configurable stall).

### 3. Anomaly detection

**Best practice:** score behaviour on several independent axes, gate on a
**warmup** period to avoid false positives on sparse data, and let operators
disable any axis.

- `apps/cms/src/modules/anomaly/detector.ts` aggregates `max(geo, time, device)`
  (rounded to 2 decimals) with a warmup OR-fold: if *any* axis is still warming
  up, threshold actions are skipped.
- `geo.ts` (MaxMind lookup, 2-second timeout, skips private/loopback IPs),
  `time.ts` (UTC-hour histogram), `device.ts` (User-Agent fingerprint).
- `private-ip.ts` classifies non-routable IPs (RFC 1918, loopback, link-local,
  ULA) by cheap prefix matching — reused by the SSRF guard.
- Results persist to `login_attempts` (`anomalyScore`, `anomalyTriggered`,
  `baselineWarmup`); baselines live in `login_baselines`.

### 4. Control-plane & route guards

**Best practice:** gate administrative surfaces centrally so a route that forgets
its own role check still cannot be reached by a non-admin.

- `apps/cms/src/middleware/control-plane-access-guard.ts`
  (`withControlPlaneAccessGuard`) requires an admin principal for control-plane
  paths (`/settings`, `/roles`, `/policies`, `/permissions`, `/users`, `/teams`,
  `/api-keys`, `/admin`, `/agent`, `/cdc`, `/flows`, `/integrations/git`,
  `/materialize`), auditing `control_plane_access_denied` on refusal.
- `apps/cms/src/middleware/admin-path-guard.ts` enforces the private admin path;
  `apps/cms/src/routes/admin-security.ts` exposes the security-audit surface.
- **Settings hardening** — `apps/cms/src/routes/settings.ts` gates `POST`/`DELETE`
  with `requireSiteAdmin()` and redacts secret-looking fields (`redactSecrets`)
  on reads, so members cannot write arbitrary keys or read stored secrets.
- See **[route-guards.md](./route-guards.md)** and
  **[runtime-security-guards-plan.md](./runtime-security-guards-plan.md)** for the
  full guard catalogue and pipeline mount order.

### 5. Tenant isolation at the database layer

**Best practice:** do not rely only on application-level `site_id` filters —
enforce isolation in the database so a missing `.where()` cannot leak data.

- `packages/database/migrations/rls-policies.sql` applies RESTRICTIVE
  row-level-security policies (`site_id = app_site_id()`) with `WITH CHECK` on
  writes. The request binds `SET LOCAL app.site_id` per request.
- The application layer additionally scopes every query by `siteId`
  (`CLAUDE.md` non-negotiable rule #2) — defense-in-depth on top of RLS.
- See **[idor-testing.md](./idor-testing.md)** for the cross-tenant (IDOR) test
  matrix that exercises this.

### 6. Request resource limits

**Best practice:** cap size and complexity *before* doing work.

- **JSON body cap** — `apps/cms/src/middleware/body-limit.ts` (`withJsonBodyLimit`)
  rejects mutating JSON requests over 1 MiB (`LUMIBASE_MAX_JSON_BODY`) with
  `413 PAYLOAD_TOO_LARGE`, checked on `Content-Length` before the body is read.
  It is the belt to the upstream Caddy `request_body max_size` braces.
- **GraphQL depth & cost** — `apps/cms/src/graphql/yoga.ts` caps field nesting
  at `MAX_QUERY_DEPTH = 12` (`depthLimitRule`) *and* static query cost at
  `LUMIBASE_GQL_MAX_COST` (default 1000, `costLimitRule`). Cost catches the
  shallow-but-wide queries depth alone misses — many parallel fields, large
  `limit`s, or a field aliased repeatedly — scoring each field 1 and
  multiplying a list's subtree by its pagination argument
  (`LUMIBASE_GQL_DEFAULT_LIST_SIZE` when absent/variable, clamped to
  `LUMIBASE_GQL_MAX_LIST_MULTIPLIER`). Both run in every environment, validated
  before any resolver; introspection is disabled when `LUMIBASE_ENV` is
  `production`. See [`graphql-api-spec.md`](../api/graphql-api-spec.md#abuse-guards).
- **Pagination** — list queries clamp the page size (e.g.
  `Math.min(params.limit ?? 25, 200)` in `item-service.ts`; `PANEL_MAX_LIMIT`,
  CDC feed `max(500)`), so a caller cannot request an unbounded page.
- **File uploads** — `apps/cms/src/middleware/file-upload-policy.ts` covers both
  metadata create (`POST /files`) and raw-byte upload (`PUT /files/upload/*`,
  `POST /media/:key`). It enforces a 10 MB default cap on **actual** bytes, a MIME
  allowlist, magic-byte content validation, extension/MIME mismatch rejection,
  SVG active-content blocking, and a polyglot deep-scan
  (`imageHasEmbeddedActivePayload` → `UPLOAD_EMBEDDED_PAYLOAD`). Public principals
  are denied; every denial is audited. Limits are configurable **per-site** via
  the `upload_policy` settings key (Studio → Settings → Uploads), falling back to
  env then defaults.

### 7. Browser-surface headers

**Best practice:** ship conservative security headers by default on every
response.

- `apps/cms/src/middleware/security-headers.ts` (`withSecurityHeaders`) attaches a
  restrictive CSP (`default-src 'none'`, `frame-ancestors 'none'`, …),
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, a conservative `Permissions-Policy`, and
  `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy`.

### 8. SSRF & open-redirect prevention

**Best practice:** validate every user-supplied outbound URL; block
private/loopback/metadata targets; whitelist protocols; reject embedded
credentials.

- `apps/cms/src/services/ssrf-guard.ts` exposes `validateOutboundUrl()` (sync,
  literal-string checks), `resolveAndValidateOutboundUrl()` (adds DNS
  resolution), and the `guardedFetch()` wrapper. It blocks `localhost`/
  `.localhost`, RFC 1918 / link-local / loopback ranges, cloud metadata
  endpoints (`169.254.169.254`, `100.100.100.200`, `metadata.google.internal`),
  `user:pass@` URLs, and any protocol other than `http`/`https`.
- **DNS-rebinding defence:** `guardedFetch()` / `resolveAndValidateOutboundUrl()`
  additionally **resolve the hostname and re-check every resolved IP** against
  the private/loopback/metadata ranges, so a public name that points at
  `169.254.169.254` or `10.0.0.5` is rejected. Resolution uses a lazily-loaded
  `node:dns` resolver on Node and is skipped on Workers (best-effort by default;
  set `requireDnsResolution` to fail closed when resolution can't run). The
  resolver is injectable (`options.resolve`) for testing.
- **Rule:** any feature that fetches a user-provided URL (imports, webhooks,
  avatar fetch, …) must route through `guardedFetch()` / `validateOutboundUrl()`.

### 9. AI agent governance

**Best practice:** bound what autonomous agents can do — write budgets,
coalescing, backpressure, and human approval for dangerous actions.

- `apps/cms/src/services/load-guard-service.ts` provides a per-intent
  `WriteRateLimiter` (writes/minute), write coalescing (many writes → one cache
  invalidation), and backpressure that pauses reconciler-origin runs under
  event-loop overload — while never auto-pausing human-triggered work.
- **HITL** — per `CLAUDE.md` rule #4, any skill with `schema:write` capability or
  a name starting with `delete` must create an `ai_approvals` row first.

### 10. Audit logging

**Best practice:** record every security decision, mask secrets, never throw, and
bound the write latency.

- `apps/cms/src/modules/audit/logger.ts` is a synchronous, secret-masking,
  never-throwing writer to `audit_log`, racing the INSERT against
  `DEFAULT_BUDGET_MS = 1000`; on timeout it emits a structured fallback to
  `console.error`. It covers event codes like `login_failed`, `user_locked`,
  `ip_blocked`, `anomaly_triggered`, `control_plane_access_denied`,
  `file_upload_policy_denied`.
- `apps/cms/src/middleware/security-audit.ts` (`auditSecurityGuardDenied`) is the
  shared helper guards call on refusal; the Studio **Security audit** tab surfaces
  the trail.
- `apps/cms/src/modules/audit/routes.ts` provides a cursor-paginated read API and
  an NDJSON export capped at `EXPORT_MAX_ROWS = 100_000`
  (`413 EXPORT_TOO_LARGE` pre-flight), admin-gated.

## General best practices (checklist for new code)

When adding a new endpoint, skill, or fetch feature, apply:

1. **Rate-limit on the right keys.** Auth-sensitive endpoints limit on IP *and*
   identity. Reuse the `login-guard`/`recovery` patterns and the generic
   `withRateLimit` throttle; do not invent a new limiter shape.
2. **Return `429`/`423` with `Retry-After`**, and never extend the window on a
   denied request.
3. **Uniform responses** for existence checks (login, recovery, invites) to
   prevent enumeration; normalize identifiers first.
4. **Always scope by `site_id`** and rely on RLS as the backstop. New domain
   tables get RLS policies in `rls-policies.sql`.
5. **Put admin surfaces behind the control-plane guard** — do not rely on a
   route's own role check alone.
6. **HITL for dangerous AI actions** (`schema:write` / `delete*`) → `ai_approvals`.
7. **Audit every denial/lock/block** via `auditSecurityGuardDenied` / the `audit`
   logger — never `throw` from the audit path.
8. **Route outbound fetches through `guardedFetch()`** — never call `fetch()`
   directly on a user-supplied URL.
9. **Cap size and complexity before work** (body size, depth, page size).

## Gaps & recommendations

Current limitations, roughly by priority. Documented so the trade-offs are
explicit — not all are bugs; several are deliberately delegated upstream.

| Priority | Gap | Recommendation |
|---|---|---|
| Medium | The **recovery limiter** (`recovery/rate-limit.ts`) is in-memory per process — not shared across Workers isolates / multiple Node processes | Back it with a shared store (Redis via `LUMIBASE_REDIS_URL`, or a DB-backed counter like the Postgres-backed login limiter). The `CounterStore` interface exists; a `RedisCounterStore` is planned (Phase C+) |
| Medium | The generic API throttle is **coarse and non-atomic** (read-modify-write can undercount under high concurrency) | Acceptable as a safety net; for precise per-endpoint quotas use an atomic counter (Durable Object / Redis `INCR`). Fail mode is now configurable: it fails **open** by default (cache outage never downs the API), or **closed** (503 `RATE_LIMIT_UNAVAILABLE`) when `LUMIBASE_RATE_LIMIT_FAIL_CLOSED='true'` for hardened deployments where the throttle is load-bearing |
| Medium | No IP allowlist/blocklist, no CAPTCHA / bot detection | Delegate to the upstream WAF (Cloudflare) in production; consider CAPTCHA on the most sensitive endpoints |
| Low | API keys support expiry + revocation (`api_keys.expiresAt` / `revokedAt`) but there is **no enforced mandatory rotation** policy | Add a rotation policy / expiry-nudge if required by compliance |
| Low | Realtime channels have subscribe read-gating and field masking but **no per-connection rate limit** | Add a per-connection limiter to the realtime layer |

> **Deployment note (inference, based on the dual-runtime architecture):** on
> Cloudflare Workers, volumetric DDoS, generic bot mitigation, and IP reputation
> are best handled at the edge (Cloudflare); on Docker, the Caddy front door owns
> the request-body and connection limits. The application layer focuses on
> brute-force, anomaly, and business-level abuse. Confirm the actual edge
> configuration for your deployment.

## Testing & verification

- **Brute-force load test:** `apps/cms/k6/login-brute-force.js`.
- **Guard wiring:** `apps/cms/src/__tests__/security-guards.wiring.test.ts`,
  `apps/cms/src/middleware/__tests__/` (`rate-limit`, `body-limit`,
  `security-headers`, `control-plane-access-guard`, `file-upload-policy`, …).
- **Cross-tenant isolation:**
  `apps/cms/src/__tests__/idor-tenant-isolation.integration.test.ts`.
- **Run the CMS test suite:** `pnpm -F @lumibase/cms test`.

## Related docs

- [route-guards.md](./route-guards.md) — route/control-plane guard catalogue.
- [runtime-security-guards-plan.md](./runtime-security-guards-plan.md) — runtime
  security foundation (guard responsibilities + mount points).
- [cwe-top-100-audit.md](./cwe-top-100-audit.md) — CWE-mapped security audit.
- [idor-testing.md](./idor-testing.md) — cross-tenant (IDOR) testing guidelines.
- [external-jwt-auth.md](./external-jwt-auth.md) — external JWT issuer auth.
- [user-management.md](./user-management.md) — user management & auth realms (ADR-010).
- [dependency-overrides.md](./dependency-overrides.md) — supply-chain / dependency hardening.
- [../features/permissions-rbac.md](../features/permissions-rbac.md) — RBAC / field-level policy engine.
- [../features/extensions-system.md](../features/extensions-system.md) — extension sandbox permissions.
