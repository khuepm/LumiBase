---
version: 2
sourceLang: en
lastUpdated: 2026-11-14T02:06:51.976Z
contentHash: 138d00f57a313844
codeVerified: 2026-11-14T02:06:51.976Z
codeVerifiedHash: 138d00f57a313844
codeVerifiedClaims: 52
---

# Bootstrap & single-use token audit — rate limits and race safety

> Issue #732 (epic #674, S03). Competitor evidence: Strapi #26494 (critical) —
> `register-admin` had no rate limit and a race that could mint two admins.
> This page records what LumiBase does on every public account-bootstrap
> endpoint, the gaps the audit found, and the tests that keep them closed.

## Scope

The unauthenticated endpoints that create an account, elevate one, or consume
a single-use link:

- first-admin registration — the setup wizard's `POST /api/v1/setup/complete`;
- self-service registration — `POST /api/v1/auth/register`;
- email verification — `POST /api/v1/auth/verify-email` and `POST /api/v1/auth/resend-verification`;
- password reset — `POST /api/v1/auth/forgot-password` and `POST /api/v1/auth/reset-password`;
- invite acceptance — staff invites (`POST /api/v1/users/invite`, the AI `inviteUser` skill, organization `invite_org_member`);
- break-glass recovery — `POST /api/v1/admin/security/recover` (backup codes) and `POST /api/v1/admin/security/reset-password` (recovery token).

## Results

| Endpoint | Rate limit | Race-safe | Evidence |
|---|---|---|---|
| `POST /setup/complete` | Yes, 10 req/min/IP, before body parse (existed) | Yes: `SELECT … FOR UPDATE` on the `system_state` singleton, state machine, partial unique index `users_is_bootstrap_unique`. **Fixed:** race losers now get `409`, not `404` | `setup-complete-race.db.integration.test.ts`, `setup-race-lost.test.ts`, `complete-rate-brake.test.ts` |
| `POST /auth/register` | Yes, 5/hour/IP. **Fixed:** the counter was a non-atomic `get` then `set`, so a parallel burst passed it; it now uses the runtime's atomic limiter | Yes: unique email indexes; account and membership commit in one transaction; conflicts fall through to the generic `202` (existed) | `auth-flow-rate.test.ts`, `security-guards.wiring.test.ts` |
| `POST /auth/verify-email` | **Added:** 20 per 15 min per IP, before any token work | **Fixed:** the `invited → active` flip is one conditional `UPDATE`; exactly one concurrent request returns `verified` | `auth-single-use-race.db.integration.test.ts`, `single-use-consume.test.ts`, `auth-token-brake.test.ts` |
| `POST /auth/resend-verification` | Yes, 5/hour/IP (now atomic) | n/a — mints a stateless link, writes nothing but audit | `auth-flow-rate.test.ts` |
| `POST /auth/forgot-password` | Yes, 5/hour/IP (now atomic) | n/a — mints a stateless link, writes nothing but audit | `auth-flow-rate.test.ts` |
| `POST /auth/reset-password` | **Added:** 20 per 15 min per IP, before body parse or hashing | **Fixed:** compare-and-swap on `users.token_version`; exactly one concurrent request sets the password, the rest get `400 INVALID_TOKEN` | `auth-single-use-race.db.integration.test.ts`, `single-use-consume.test.ts`, `auth-token-brake.test.ts` |
| Staff invite (`/users/invite`, `inviteUser`) | Admin-gated; the global API limiter applies | Yes: identity-aware lookup, insert and membership in one transaction, one retry on a unique conflict (existed) | `users-invite-validation.test.ts`, `email-identity.db.integration.test.ts` |
| Organization `invite_org_member` | Owner/admin-gated; the organization row is locked per mutation | **Fixed:** two concurrent invites of one new address (to different organizations) raised an unhandled `23505`; the insert is now `ON CONFLICT DO NOTHING` and the loser re-reads the winner's row | `orgs.db.integration.test.ts` |
| `POST /admin/security/recover`, `/admin/security/reset-password` | Yes, per-IP recovery limiter on the atomic runtime limiter (existed) | Yes: a backup code is spent with `UPDATE … WHERE used_at IS NULL RETURNING`; the recovery token store deletes on consume with no `await` between the read and the delete (existed) | `recovery-flow.integration.test.ts` |

There is no token-bearing "accept invite" endpoint: an invited teammate is a
`status: 'invited'` account bound to the site, and the invite email asks them to
sign in. There is therefore no invite token to replay.

## How first-admin registration stays single-winner

`SetupService.complete` (`apps/cms/src/modules/setup/service.ts`) runs the whole
bootstrap in one transaction:

1. `statement_timeout` is set for the transaction, so a request cannot wait on
   the lock forever. A timeout maps to `409 SETUP_IN_PROGRESS`.
2. The `system_state` singleton is locked with `SELECT … FOR UPDATE`. Concurrent
   requests queue here.
3. When the winner commits, `state` is `initialized`. Each queued request then
   compares its arrival time (`receivedAt`, taken when the handler starts, before
   it waits on the rate limiter, the connection pool or the lock) with
   `initialized_at`:
   - it arrived **before** setup finished → it lost a race → `409 SETUP_ALREADY_COMPLETED`;
   - it arrived **after** → `404 NOT_FOUND`, the same as any other unknown route,
     so an initialized instance does not reveal the endpoint.
4. Backstop: the partial unique index `users_is_bootstrap_unique` refuses a second
   `is_bootstrap = true` row whatever the state machine says. That `23505`
   (also when the driver error is wrapped in `cause`) maps to the same `409`.

No migration was needed: the partial unique index has existed since the initial
schema.

## How single-use links stay single-winner

The verification and reset links are stateless HS256 JWTs, so there is no token
row to delete. "Single use" is the account state the link moves, and the helpers
in `apps/cms/src/services/auth/single-use-consume.ts` re-check that state in the
`UPDATE` itself:

- **Verify:** `UPDATE users SET status = 'active' WHERE id = $1 AND status = 'invited' RETURNING id`.
  One request gets the row. The others re-read the account and answer
  `already_verified`, and only the winner writes the `email_verified` audit event.
- **Reset:** the handler reads `token_version` when it checks the link, then writes
  `… SET password_hash = $2, token_version = token_version + 1 … WHERE id = $1 AND token_version = $expected AND status <> 'suspended' RETURNING id`.
  The winner bumps the version, so every concurrent request updates zero rows and
  gets `400 INVALID_TOKEN`. A replay after the fact is still refused by the
  `password_changed_at` versus `iat` check (`isResetTokenStale`).

## Rate-limit behaviour

`checkAuthFlowRate` (`apps/cms/src/modules/auth/registration-guard.ts`) uses the
runtime's `RateLimiterProvider` (Redis `INCR`, the Cloudflare counter, or the
in-memory limiter), which counts in one atomic step: of a parallel burst from
one IP, exactly `maxPerWindow` requests get through. Without a limiter on the
runtime it falls back to the previous cache counter. Its policy is unchanged: a
request with no client IP cannot be keyed and is allowed, and a limiter outage
fails open, so the brake cannot take sign-up or recovery down.

| Scope | Budget |
|---|---|
| `reg-rate`, `resend-rate`, `forgot-rate` | 5 per hour per IP per site |
| `verify-rate`, `reset-rate` | 20 per 15 minutes per IP per site |
| setup `/complete` | 10 per minute per IP |

A throttled request gets `429` with `{ errors: [{ code: 'RATE_LIMITED' }] }` and a
`retry-after` header (verify and reset), before any database read.

## Tests

| Test | Proves |
|---|---|
| `apps/cms/src/modules/setup/__tests__/setup-complete-race.db.integration.test.ts` | 8 parallel `POST /setup/complete` requests (distinct and identical accounts) → one `201`, seven `409`, exactly one `is_bootstrap` row; a late request still gets `404` |
| `apps/cms/src/modules/setup/__tests__/setup-race-lost.test.ts` | Arrival classification, the lock branch, `23505` mapping (bare and wrapped), HTTP `409` mapping |
| `apps/cms/src/routes/__tests__/auth-single-use-race.db.integration.test.ts` | 6 parallel verifications → one `verified`; 6 parallel resets → one `200`, the stored hash is the winner's, `token_version` bumped once |
| `apps/cms/src/services/auth/__tests__/single-use-consume.test.ts` | The guard predicates are in the `UPDATE` itself; loser classification |
| `apps/cms/src/modules/auth/__tests__/auth-flow-rate.test.ts` | A parallel burst of 20 admits exactly 5; per-scope, per-site and per-IP keys; fail-open |
| `apps/cms/src/routes/__tests__/auth-token-brake.test.ts` | `429` on verify and reset before any database access, including under a parallel burst |

The `*.db.integration.test.ts` suites skip without `DATABASE_URL` and run in CI's
"DB integration suites" job against Postgres.

## Known limits

- With the in-memory limiter (no Redis or Cloudflare counter), budgets are per
  process or isolate, not global. Front the public auth routes with an edge WAF
  rule if you need an exact global quota.
- Arrival-time classification compares the request's clock with the clock of the
  replica that completed setup. Clock skew between replicas only moves the
  `409`/`404` boundary by that skew. It never allows a second admin.
