# Anti-Abuse Mechanisms & Best Practices

## Overview

This document is the single reference for how LumiBase defends against abuse —
brute-force, credential stuffing, enumeration, resource exhaustion, SSRF,
cross-tenant access, and runaway AI agents. LumiBase already ships a range of
controls, but they are spread across middleware, modules, and services. The
goals here are to (1) map what exists and where, (2) state the best practice
each control embodies so new code follows the same pattern, and (3) list the
known gaps so they are chosen deliberately, not by accident.

The guiding principle is **defense-in-depth**: no single layer is trusted to be
sufficient. Each layer assumes the one in front of it can be bypassed.

## Layered model

```
┌─ Upstream (CDN / WAF) ──────── DDoS, IP reputation, bot mitigation (Cloudflare, etc.)
│
├─ Middleware ───────────────── file-upload policy, request guards
│    apps/cms/src/middleware/
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

The application layer owns brute-force, anomaly, business-level abuse. Generic
volumetric/DDoS and bot mitigation are expected upstream (see [Gaps](#gaps--recommendations)).

## Existing mechanisms (registry)

### 1. Rate limiting & brute-force defense

**Best practice:** limit on multiple keys (IP *and* account), use a sliding
window, return `429`/`423` with `Retry-After`, and never let a denied request
extend the window.

- **Per-IP login limiter** — `apps/cms/src/modules/login-guard/counter.ts`
  counts `result='fail'` rows in `login_attempts` over the configured
  `lockoutWindowSeconds`. The threshold has a hard floor of 3
  (`Math.max(3, policy.ipMaxFailedAttempts)`, see
  `login-guard/middleware.ts` and `hooks.ts`); crossing it returns
  `429 IP_BLOCKED` with a `Retry-After` bounded by `ipLockoutDurationSeconds`.
- **Account lockout** — `apps/cms/src/modules/login-guard/middleware.ts` blocks
  login while `users.lockedUntil > now()` and returns `423 ACCOUNT_LOCKED`.
- **Recovery limiter** — `apps/cms/src/modules/recovery/rate-limit.ts` enforces
  a **shared** 3 requests / IP / hour budget across *both* `/recover` and
  `/forgot-path` (keyed by IP alone, never IP+endpoint, so an attacker cannot
  double the budget by splitting across the two paths). Fixed window;
  `Retry-After` shrinks monotonically toward the original deadline.
- **Policy** — thresholds live in the `settings` table (`login_security_policy`)
  with a `STANDARD_LOCKOUT_POLICY` fallback, so operators tune limits without
  redeploying.

> **Deployment caveat (verified in code):** the login counter and the recovery
> limiter are **in-memory per process**. They are correct for a single Node
> process but are **not** shared across Cloudflare Workers isolates or multiple
> Node processes behind a load balancer. See [Gaps](#gaps--recommendations).

### 2. Enumeration & timing hardening

**Best practice:** identical response shape and timing whether or not the
account exists; normalize identifiers before lookup.

- `apps/cms/src/modules/login-guard/email-normalize.ts` trims and lowercases the
  email so `Foo@Bar` and `foo@bar` share one counter and one lookup path.
- The login guard keeps query timing uniform regardless of email existence.

### 3. Anomaly detection

**Best practice:** score behaviour on several independent axes, gate on a
**warmup** period to avoid false positives on sparse data, and let operators
disable any axis.

- `apps/cms/src/modules/anomaly/detector.ts` aggregates
  `max(geo, time, device)` (rounded to 2 decimals) and applies a warmup OR-fold:
  if *any* axis is still warming up, threshold actions are skipped.
- `geo.ts` (MaxMind lookup, 2-second timeout, skips private/loopback IPs),
  `time.ts` (UTC-hour histogram), `device.ts` (User-Agent fingerprint).
- `private-ip.ts` classifies non-routable IPs (RFC 1918, loopback, link-local,
  ULA) by cheap prefix matching — reused by the SSRF guard.
- Results persist to `login_attempts` (`anomalyScore`, `anomalyTriggered`,
  `baselineWarmup`); baselines live in `login_baselines`.

### 4. Tenant isolation at the database layer

**Best practice:** do not rely only on application-level `site_id` filters —
enforce isolation in the database so a missing `.where()` cannot leak data.

- `packages/database/migrations/rls-policies.sql` applies RESTRICTIVE
  row-level-security policies (`site_id = app_site_id()`) to 30+ tables, with
  `WITH CHECK` on writes. The request binds `SET LOCAL app.site_id` per request.
- The application layer additionally scopes every query by `siteId`
  (`CLAUDE.md` non-negotiable rule #2) — defense-in-depth on top of RLS.
- See **[idor-testing.md](./idor-testing.md)** for the cross-tenant (IDOR) test
  matrix that exercises this.

### 5. Request resource limits

**Best practice:** cap complexity and size *before* doing work.

- **GraphQL depth** — `apps/cms/src/graphql/yoga.ts` sets `MAX_QUERY_DEPTH = 12`
  via `depthLimitRule`, and disables schema introspection when
  `LUMIBASE_ENV === 'production'`.
- **File uploads** — `apps/cms/src/middleware/file-upload-policy.ts` enforces a
  10 MB default cap (`FILE_UPLOAD_MAX_BYTES`), a MIME allowlist
  (`FILE_UPLOAD_ALLOWED_MIME_TYPES`), magic-byte content validation, and
  extension/MIME mismatch rejection (`413 UPLOAD_TOO_LARGE`,
  `415 UPLOAD_EXTENSION_MISMATCH`). Every denial is audited.

### 6. SSRF & open-redirect prevention

**Best practice:** validate every user-supplied outbound URL; block
private/loopback/metadata targets; whitelist protocols; reject embedded
credentials.

- `apps/cms/src/services/ssrf-guard.ts` exposes `validateOutboundUrl()` and the
  `guardedFetch()` wrapper. It blocks `localhost`/`.localhost`, RFC 1918 &
  link-local & loopback ranges, cloud metadata endpoints (`169.254.169.254`,
  `100.100.100.200`, `metadata.google.internal`), `user:pass@` URLs, and any
  protocol other than `http`/`https`.
- **Rule:** any feature that fetches a user-provided URL (imports, webhooks,
  avatar fetch, etc.) must route through `guardedFetch()` / `validateOutboundUrl()`.

### 7. AI agent governance

**Best practice:** bound what autonomous agents can do — write budgets,
coalescing, backpressure, and human approval for dangerous actions.

- `apps/cms/src/services/load-guard-service.ts` provides a per-intent
  `WriteRateLimiter` (writes/minute, sliding window), write coalescing (many
  writes → one cache invalidation), and backpressure that pauses
  reconciler-origin runs under event-loop overload — while never auto-pausing
  human-triggered work.
- **HITL** — per `CLAUDE.md` rule #4, any skill with `schema:write` capability
  or a name starting with `delete` must create an `ai_approvals` row first.

### 8. Audit logging

**Best practice:** record every security decision, mask secrets, never throw,
and bound the write latency.

- `apps/cms/src/modules/audit/logger.ts` is a synchronous, secret-masking,
  never-throwing writer to `audit_log`, racing the INSERT against
  `DEFAULT_BUDGET_MS = 1000`; on timeout it emits a structured fallback to
  `console.error`. It masks `passwordHash`/token fields and covers event codes
  like `login_failed`, `user_locked`, `ip_blocked`, `anomaly_triggered`,
  `recovery_initiated`.
- `apps/cms/src/modules/audit/routes.ts` provides a cursor-paginated read API
  and an NDJSON export capped at `EXPORT_MAX_ROWS = 100_000`
  (`413 EXPORT_TOO_LARGE` pre-flight), admin-gated.

## General best practices (checklist for new code)

When adding a new endpoint, skill, or fetch feature, apply:

1. **Rate-limit on the right keys.** Public/auth-sensitive endpoints limit on IP
   *and* the target identity. Reuse the `login-guard`/`recovery` patterns; do
   not invent a new limiter shape.
2. **Return `429`/`423` with `Retry-After`**, and never extend the window on a
   denied request.
3. **Uniform responses** for existence checks (login, recovery, invites) to
   prevent enumeration; normalize identifiers first.
4. **Always scope by `site_id`** and rely on RLS as the backstop. New domain
   tables get RLS policies in `rls-policies.sql`.
5. **HITL for dangerous AI actions** (`schema:write` / `delete*`) → `ai_approvals`.
6. **Audit every denial/lock/block** via the `audit` logger — never `throw` from
   the audit path.
7. **Route outbound fetches through `guardedFetch()`** — never call `fetch()`
   directly on a user-supplied URL.
8. **Cap complexity/size before work** (depth, body size, page size).

## Gaps & recommendations

These are current limitations, roughly by priority. They are documented so the
trade-offs are explicit — not all are bugs; several are deliberately delegated
upstream.

| Priority | Gap | Recommendation |
|---|---|---|
| High | Login & recovery limiters are **in-memory per process** — not shared across CF Workers isolates / multiple Node processes | Back with a shared store; the `CounterStoreEnv` + `RedisCounterStore` scaffold already exists in `login-guard/` for this |
| High | No global request **body-size** cap, **pagination `limit`** cap, or **search complexity** cap | Add middleware bounding body size and a hard max on `limit`; add a complexity cap for full-text search |
| Medium | No IP allowlist/blocklist, no CAPTCHA / bot detection | Delegate to upstream WAF (Cloudflare) in production; consider CAPTCHA on the most sensitive endpoints |
| Medium | API keys have no forced rotation/expiry | Add expiry + rotation policy |
| Low | Realtime channels are not rate-limited per client | Add a per-connection limiter to the realtime layer |

> **Deployment note (inference, based on the dual-runtime architecture):** on
> Cloudflare Workers, volumetric DDoS, generic bot mitigation, and IP reputation
> are best handled at the edge (Cloudflare) rather than in application code. The
> application layer focuses on brute-force, anomaly, and business-level abuse.
> This reflects the intended architecture; confirm the actual edge configuration
> for your deployment.

## Testing & verification

- **Brute-force load test:** `apps/cms/k6/login-brute-force.js` (k6 script
  exercising the login limiter / lockout path).
- **Cross-tenant isolation:**
  `apps/cms/src/__tests__/idor-tenant-isolation.integration.test.ts`
  (see [idor-testing.md](./idor-testing.md)).
- **Run the CMS test suite:** `pnpm -F @lumibase/cms test`.

## Related docs

- [idor-testing.md](./idor-testing.md) — cross-tenant (IDOR) testing guidelines.
- [dependency-overrides.md](./dependency-overrides.md) — supply-chain / dependency hardening.
- [../features/permissions-rbac.md](../features/permissions-rbac.md) — RBAC / field-level policy engine.
- [../features/extensions-system.md](../features/extensions-system.md) — extension sandbox permissions.
