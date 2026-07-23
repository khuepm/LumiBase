# OWASP API Security Top 10 (2023) — LumiBase Audit

> **Scope.** This document maps the LumiBase CMS API surface against the
> [OWASP API Security Top 10 (2023)](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)
> with concrete `file:line` evidence, an assessed score per category, and the
> remediation applied for the gaps found.
>
> **Status of assessment.** The presence of each control below is verifiable
> from the cited code. The per-category **scores are an assessment**, not a
> figure issued by OWASP or an external audit tool. Items marked
> **[Inference]** are extrapolations from the code, not statements the code
> makes directly.

## Middleware chain (the backbone of most controls)

Per-request chain (`apps/cms/src/index.ts:213`):

```
withTenant → withDb → withAuth → withSiteMembership → withRateLimit
  → requireSetupComplete → withStudioAccess → withControlPlaneAccessGuard
  → withFileUploadPolicy → withRls
```

Global (pre-chain): `withLogger, withTracing, withSecurityHeaders, withMetrics,
withRuntime, cors, withJsonBodyLimit, withAuditContext, adminPathGuard`
(`index.ts:104-153`).

## Scorecard

| # | Category | Status | Score |
|---|----------|--------|:-----:|
| API1 | Broken Object Level Authorization (BOLA) | Addressed (defense-in-depth) | 9/10 |
| API2 | Broken Authentication | Addressed | 9/10 |
| API3 | Broken Object Property Level Authorization | Addressed | 8.5/10 |
| API4 | Unrestricted Resource Consumption | Addressed | 8/10 |
| API5 | Broken Function Level Authorization | Addressed (centralized) | 9/10 |
| API6 | Unrestricted Access to Sensitive Business Flows | Partial | 6.5/10 |
| API7 | Server-Side Request Forgery (SSRF) | Addressed | 9/10 |
| API8 | Security Misconfiguration | Addressed | 9/10 |
| API9 | Improper Inventory Management | Addressed (improved) | 7.5/10 |
| API10 | Unsafe Consumption of APIs | Addressed | 8/10 |

**Assessed total: ~83.5 / 100 (Grade A−, "Strong").** API4, API7, and API9 rose
after the remediations in this changeset (see [Remediations](#remediations-applied-in-this-changeset)).

---

## API1:2023 — Broken Object Level Authorization (BOLA)

**Status: Addressed (strong, defense-in-depth). Score 9/10.**

- **`site_id` scoping at the query layer** — every list/read builds its `where`
  with `scopeSite(items.siteId, siteId)` (`services/item-service.ts:654-665`,
  `:642-651`); `scopeSite` is used pervasively across services.
- **Postgres RLS backstop, fail-closed** — `middleware/rls.ts:35-81` sets
  `app.site_id` per request and returns `503 RLS_UNAVAILABLE` if the scope
  can't be set (`:54-76`). RESTRICTIVE policies in
  `packages/database/migrations/rls-policies.sql`.
- **Membership binding prevents tenant hopping** — `middleware/site-membership.ts:86-98`
  requires a `user_sites` row for the requested site, else `403 TENANT_FORBIDDEN`;
  API keys are site-matched in `withAuth` (`middleware/auth.ts:276-282`).
- **Row-level rules on read/write** — `permission-service.ts` `whereFor(perm)`
  injects a permission WHERE clause (`item-service.ts:657`); `matches()`
  validates create/patch snapshots (`item-service.ts:779-781`).
- **Tests** — `apps/cms/src/__tests__/idor-tenant-isolation.integration.test.ts`;
  matrix in `docs/en/security/idor-testing.md`.

Residual: RLS is skipped in development (`rls.ts:43-45`), so dev-only paths lack
the DB backstop. [Inference] non-`ItemService` services must apply `scopeSite`
themselves; RLS is the production backstop for any miss.

## API2:2023 — Broken Authentication

**Status: Addressed (strong). Score 9/10.**

- **Multiple verified schemes** — Cloudflare Access RS256 verified against remote
  JWKS then **re-mapped to a DB user + site role** rather than trusting the edge
  assertion (`middleware/auth.ts:187-245`, CWE-302); custom HS256 with audience
  pinning to `studio`/`frontend` realms (`:53-61`); API-key via SHA-256 hash
  lookup (`:262-268`).
- **Token revocation** — `tokenVersion` in the JWT must match
  `users.tokenVersion`; password change/reset bumps it (`auth.ts:408-417`,
  `routes/auth.ts:216-217`).
- **Password handling** — PBKDF2-SHA256, 100k iterations, 16-byte salt
  (`services/auth/password.ts:19-22`); 12+ char policy via shared
  `PasswordSchema` (`packages/shared/src/schemas/password.ts:12-28`).
- **Brute-force/lockout** — Postgres-backed per-IP limiter + account lockout
  (`modules/login-guard/`), enumeration hardening via email normalization +
  uniform timing.
- **Dev-auth bypass is triple-gated** to a development runtime (`auth.ts:145-156`).
- **External JWT issuers** — `modules/external-auth/verifier.ts` rejects
  `alg:none`/HS*, enforces an issuer algorithm allowlist before verify (`:142-152`).

Residual: recovery limiter is in-memory per process; no CAPTCHA (see API6).

## API3:2023 — Broken Object Property Level Authorization

**Status: Addressed (strong). Score 8.5/10.**

- **Mass-assignment protection** — `assertWritablePermissionFields`
  (`item-service.ts:2017-2040`) throws `403` for any field outside the
  permission's allowed set; called in `create` (`:765`) and `patch` (`:860`).
- **Field-level read masking** — `permission-service.ts:209-217` `maskItem` /
  `applyFieldMask`; used on list (`item-service.ts:691-692`), get one (`:740`),
  and relation expansion (`:1438-1442`).
- **Realtime/CDC respects masking** — subscribers re-read through the masked
  path, never `row.data` (`item-service.ts:1531-1551`).
- **Input validation** — Zod against the compiled schema (`services/validation.ts`,
  `item-service.ts:1038`); settings secret redaction on read (`routes/settings.ts`).

Residual (accepted): for a full-access role (`perm.fields = ['*']`),
`assertWritablePermissionFields` short-circuits (`item-service.ts:2023`) and the
Zod layer does not `.strict()`-reject unknown keys, so arbitrary keys land in the
JSON `data` column. This is intentional — the `data` column is schema-flexible by
design and the field-mask allowlist governs all non-`*` roles.

## API4:2023 — Unrestricted Resource Consumption

**Status: Addressed. Score 8/10 (was 7.5 — see remediation).**

- **Generic API rate limit** — `middleware/rate-limit.ts`, fixed window default
  300 req/60s, keyed by principal else IP, **scoped per site**, `429` +
  `X-RateLimit-*`/`Retry-After`.
- **JSON body cap** — `middleware/body-limit.ts`, 1 MiB default, `413`.
- **Pagination clamp** — `item-service.ts:667` `min(limit ?? 25, 200)`; filter
  clauses ≤100, path depth ≤8.
- **GraphQL depth + cost limits** — depth ≤12 + static cost limit (default 1000),
  introspection disabled in prod (`graphql/yoga.ts`).
- **File upload caps** — `middleware/file-upload-policy.ts` (10 MiB default).
- **AI write budgets/backpressure** — `services/load-guard-service.ts`.

Remediation applied: the generic throttle previously **failed open**
unconditionally on cache unavailability. It now supports a fail-closed mode
(`LUMIBASE_RATE_LIMIT_FAIL_CLOSED='true'` → `503 RATE_LIMIT_UNAVAILABLE`) for
hardened deployments, while keeping fail-open as the safe default so a cache
outage never downs the API.

Residual: the throttle remains non-atomic (read-modify-write); precise
per-endpoint quotas need an atomic counter (Durable Object / Redis `INCR`).

## API5:2023 — Broken Function Level Authorization

**Status: Addressed (strong, centralized). Score 9/10.**

- **Central control-plane guard** — `middleware/control-plane-access-guard.ts:5-24`
  requires an admin principal for an explicit `CONTROL_PLANE_PATHS` list
  (`/access`, `/api-keys`, `/admin`, `/agent`, `/cdc`, `/flows`, …) even if a
  route forgets its own check; denials audited (`control_plane_access_denied`).
- **Studio-access wall** — `middleware/studio-access.ts`; a `frontend`
  (subscriber) token can never reach the Studio surface (`:75-80`, ADR-011).
- **RBAC engine** — `services/permission-service.ts:184-199,406-422` compiles
  per-(collection, action) permissions with cache invalidation.
- **Per-route guards compose on top** — `requireSiteAdmin`,
  `requireSchemaPermission`, `adminOnly`.
- **Tripwire test** — `apps/cms/src/__tests__/security-guards.wiring.test.ts`
  asserts chain order + control-plane coverage.

Residual: [Inference] `isAdminPrincipal` matches role keys `'admin'`/
`'administrator'` (`control-plane-access-guard.ts:65`); a custom admin-equivalent
role with a different key relies on the route's own permission check.

## API6:2023 — Unrestricted Access to Sensitive Business Flows

**Status: Partial. Score 6.5/10.**

Strong for AI/agent flows:

- **HITL approvals** — `services/ai-harness.ts` forces write/delete and
  control-plane skills through approval (`:202-215`); `pending_approval` status
  (`:53-62`).
- **Irreversible-action cap** — `IRREVERSIBLE_SKILLS` hard-capped at autonomy L2
  (`ai-harness.ts:222-230`).
- **Autonomy gradient + kill switch + veto window** — `AutonomyService`,
  `KillSwitchService`, `VetoService`, `load-guard-service`.
- **Setup-flow brakes** — 10 req/60s on `/setup/complete` + `SELECT … FOR UPDATE`
  singleton for the first admin.
- **Admin-path guard** — byte/timing-indistinguishable 404 (`admin-path-guard.ts:248-292`).

Residual (accepted, delegated upstream): **no CAPTCHA / bot detection / device
fingerprint**. This is a deliberate architectural decision — on Cloudflare
Workers, volumetric/bot mitigation is owned by the Cloudflare edge (WAF, Turnstile,
Bot Management); on Docker, the Caddy front door owns connection limits. The
application layer focuses on brute-force, anomaly (`modules/anomaly/detector.ts`),
and business-level abuse. There is no generalized per-flow abuse limiter beyond
the coarse `withRateLimit`.

## API7:2023 — Server-Side Request Forgery (SSRF)

**Status: Addressed (strong). Score 9/10 (was 8 — see remediation).**

- **Central guard** — `services/ssrf-guard.ts` `validateOutboundUrl` blocks
  non-http(s) protocols, embedded credentials, `localhost`/`.localhost`, explicit
  blocked hosts + metadata IPs (`169.254.169.254`, `100.100.100.200`,
  `metadata.google.internal`), and RFC1918/loopback/link-local via
  `isPrivateOrLoopback`.
- **Adopted at all user-URL sinks** — CDC webhook sender
  (`modules/cdc/change-feed/webhook-sender.ts`), `revalidation.ts`,
  `flow-service.ts`, `extension-verifier.ts`, `extensions/sandbox.ts`, deployment
  providers, `domains/cloudflare-saas.ts`.
- **Tests** — `services/__tests__/ssrf-guard.test.ts`.

Remediation applied: the guard previously validated the **hostname string only**
and could not catch DNS-rebinding (a public name resolving to a private IP). Added
`resolveAndValidateOutboundUrl()`, wired into `guardedFetch()`, which resolves the
hostname and re-checks **every resolved IP** against the blocked/private ranges.
Resolution uses a lazily-loaded `node:dns` resolver on Node and is skipped on
Workers (best-effort by default; `requireDnsResolution` fails closed when
resolution can't run). The resolver is injectable for testing.

Residual: on Workers, DNS resolution is unavailable at the app layer, so rebinding
defence there relies on the edge; the literal-string checks still apply everywhere.

## API8:2023 — Security Misconfiguration

**Status: Addressed (strong). Score 9/10.**

- **CORS is credentialed and never wildcard** — `config/cors.ts:37-55`
  `resolveCorsOrigin` honours an exact-match allowlist, ignores `*` for
  credentialed responses (`:43-45`, CWE-942); production with no match → denied.
- **Security headers on every response** — `middleware/security-headers.ts:23-32`
  restrictive CSP (`default-src 'none'`, `frame-ancestors 'none'`), `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP/CORP.
- **Safe error handling** — global `onError` returns generic `INTERNAL` +
  requestId (`index.ts:375-382`); auth failures return generic outward codes.
- **Prod hardening** — GraphQL introspection off in production; `METRICS_TOKEN`
  enforced when set; admin-path obfuscation with indistinguishable 404.

Residual: [Inference] no app-layer HSTS (likely terminated at Caddy/Cloudflare —
confirm per deployment); default CSP allows `style-src 'unsafe-inline'`.

## API9:2023 — Improper Inventory Management

**Status: Addressed (improved). Score 7.5/10 (was 6.5 — see remediation).**

- **Consistent versioning** — all surfaces under `/api/v1` (`index.ts:156-364`).
- **Specs/docs** — `docs/en/api/hono-api-spec.md`, `graphql-api-spec.md`; typegen
  service/route; on-demand OpenAPI 3.1.0 from the live schema
  (`ai-harness.ts:981-1054`).
- **Public vs authenticated surface is enumerated and commented** in `index.ts`
  (`:155-370`) — a de-facto inventory of unauthenticated endpoints.

Remediation applied:
1. **Debug endpoint no longer reachable in production** — the `/test-auth` auth
   playground now returns an indistinguishable `404` when the runtime is
   production (`routes/test-auth.ts`), closing a shadow/debug-endpoint exposure.
2. **Deprecation signalling mechanism** — `middleware/deprecation.ts`
   (`withDeprecation`) emits RFC 8594 `Deprecation`/`Sunset` headers plus a
   `Link rel="deprecation"`, so retiring an endpoint gives consumers a
   machine-readable warning window.

Residual: no single machine-readable OpenAPI/AsyncAPI artifact covering the whole
REST surface is checked into the repo (the OpenAPI is generated on demand). A
versioned committed spec would further strengthen inventory management.

## API10:2023 — Unsafe Consumption of APIs

**Status: Addressed. Score 8/10.**

- **Strict third-party JWT verification** — `modules/external-auth/verifier.ts`
  (public-JWKS verify, `alg:none`/HS* rejected, per-issuer algorithm allowlist
  before verify `:142-152`, audience + per-site issuer binding, fail-closed).
- **AI/LLM output treated as untrusted** — `ai-harness.ts` `extractJson`
  hard-fails `LLM_INVALID_JSON` on non-JSON (`:158-177`); generation skills
  validate/shape results before use (`:836-846`, `:894-897`, `:1093-1099`).
- **Outbound third-party calls route through `guardedFetch`** — same SSRF guard
  (now DNS-rebinding-aware) protects against malicious/redirecting hosts.
- **Config import validated with Zod** before apply (`config-import-service.ts`).
- **Extension bundles** — `EXTENSION_BUNDLE_ORIGINS` allowlist + SSRF guard +
  timeout, verified in sandbox.

Residual: [Inference] downstream shape checks on model output are per-skill and
vary in strictness; no single schema-level guarantee that every third-party/AI
response is validated against a declared response schema before persistence.

---

## Remediations applied in this changeset

| Category | Gap | Fix | Evidence |
|----------|-----|-----|----------|
| API4 | Throttle fails open unconditionally | Configurable fail-closed mode (`LUMIBASE_RATE_LIMIT_FAIL_CLOSED`) → `503 RATE_LIMIT_UNAVAILABLE` | `middleware/rate-limit.ts`, `env.ts`, `middleware/__tests__/rate-limit.test.ts` |
| API7 | SSRF guard validates hostname string only (no DNS-rebinding defence) | `resolveAndValidateOutboundUrl()` resolves DNS and re-checks every resolved IP; wired into `guardedFetch()` | `services/ssrf-guard.ts`, `services/__tests__/ssrf-guard.test.ts` |
| API9 | `/test-auth` debug surface mountable in production | Indistinguishable `404` in production | `routes/test-auth.ts` |
| API9 | No endpoint deprecation mechanism | `withDeprecation` middleware (RFC 8594 `Deprecation`/`Sunset`/`Link`) | `middleware/deprecation.ts`, `middleware/__tests__/deprecation.test.ts` |

## Accepted residuals (not fixed here — deliberate)

- **API6 — CAPTCHA / bot detection:** delegated to the Cloudflare edge (Workers)
  / Caddy front door (Docker); the app layer owns brute-force, anomaly, and
  business-flow controls. See `anti-abuse.md`.
- **API3 — unknown keys for `*`-field roles:** the JSON `data` column is
  schema-flexible by design; the field-mask allowlist governs all non-`*` roles.
- **API4 — non-atomic throttle counter:** acceptable for a defence-in-depth
  safety net; precise quotas need an atomic counter.
- **API9 — no committed OpenAPI artifact:** the spec is generated on demand from
  the live schema.

## Related documents

- `docs/en/security/anti-abuse.md` — control registry + gaps table
- `docs/en/security/route-guards.md` — guard chain + BFLA incident history
- `docs/en/security/idor-testing.md` — BOLA/IDOR test matrix
- `docs/en/security/cwe-top-100-audit.md` — CWE → `file:line` scorecard
- `docs/en/security/external-jwt-auth.md` — third-party issuer verification
