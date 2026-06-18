# ADR-010: User Management Realms (single identity store, role-scoped realms, token audiences)

**Date:** 2026-06-18
**Status:** Accepted

## Context

LumiBase is a headless Content OS: the CMS backend serves a Studio admin
surface **and** public consumer frontends (e.g. a Next.js site where
visitors register, log in, and read articles). Two very different
populations therefore authenticate against the same backend:

1. **Staff / operators** — editors, admins, teammates who manage content
   in Studio. High privilege, small N, onboarded deliberately.
2. **Frontend end-users (subscribers)** — visitors who self-register on a
   consumer site. Low privilege, potentially very large N, self-service.

A recurring design question (and the trigger for this ADR) was: *should
self-registered frontend users land in the same `users` table as admins,
and is that dangerous?*

Two latent problems existed in the code before this ADR:

- `POST /api/v1/auth/register` read `c.get('auth')` and required an
  `admin` role, **but** `withAuth` bypasses that path entirely — so the
  principal was always `undefined` and the route threw. Self-service
  registration was effectively broken.
- The default role literal `roleId: 'member'` did not match any real
  `roles.id` (roles use `nanoid`/`system_key`), so even if reached the
  insert would violate the `user_sites.role_id` FK. And the `member`
  system role carries `appAccess: true` — it is a *Studio* role, not a
  least-privilege consumer role.

The crux: it is **not the shared table** that is dangerous; it is a weak
or missing **authorization boundary** between realms.

## Decision

### 1. Keep ONE global `users` identity store

A person is one identity (`users.email` unique-ish, global `users.id`).
Multi-tenancy and realm are expressed through `user_sites.role_id`, not
through separate user tables. This preserves the "one human, many
sites/roles" property (a staffer can also be a subscriber elsewhere) and
keeps the auth surface uniform.

### 2. Separate realms by ROLE, enforced at three layers

| Realm | Role | `appAccess` | Onboarding |
|-------|------|-------------|------------|
| Staff | `administrator`, `member` | `true` | Invite-only (`POST /users/invite`, admin-gated) |
| Frontend end-user | **`subscriber`** (new) | **`false`** | Public self-service (`POST /auth/register`) |

A dedicated least-privilege **`subscriber`** system role
(`system_key='subscriber'`, `adminAccess=false`, `appAccess=false`) is the
default for self-service registration. It grants nothing until an operator
attaches content policies/permissions to it. It is provisioned idempotently
on first registration (`ensureSubscriberRole`, mirroring the Setup Wizard's
lazy `upsertMemberRole`), so no setup-transaction change or backfill is
required.

### 3. Token audiences (`aud` claim) as a hard wall

`POST /auth/login` mints HS256 Custom JWTs for both realms through one
endpoint and one `JWT_SECRET`. We pin an `aud` claim at sign time:

- `studio` — bootstrap admin or any role with `appAccess`.
- `frontend` — everyone else (subscribers / appAccess-less roles).

`withStudioAccess` **rejects `frontend`-audience tokens outright**, before
any policy evaluation. This is defense-in-depth on top of the existing
`appAccess` bundle check: even if a future misconfiguration granted a
subscriber `appAccess`, their token still cannot be replayed against the
Studio management surface because its audience says `frontend`.

A third audience, `email-verify`, tags the registration verification
token so a verification link can never be used as a session token.

### 4. Self-service registration guardrails

The rewritten public `POST /auth/register`:

1. **Server-resolved role** — always `ensureSubscriberRole(...)`; the
   request body can never choose a role.
2. **Inactive until verified** — account is created `status: 'invited'`;
   `/auth/login` already gates on `status === 'active'`. A stateless
   `email-verify` JWT is emailed; `POST /auth/verify-email` flips the user
   to `active`. Single-use is enforced by the state transition.
3. **Per-IP rate limit** — a best-effort runtime-cache counter brakes
   scripted mass-registration (fails open on cache outage).
4. **Anti-enumeration** — an identical generic `202` is returned whether
   or not the email already exists.

Email verification is intentionally **stateless** (a signed JWT, no token
table) to stay edge-native and avoid a migration; the trade-off is the
loss of per-token revocation, acceptable for a 24h link.

## Consequences

**Positive**

- Self-registered visitors can never obtain Studio/admin access — enforced
  at role resolution (server-side), `appAccess`, and token audience.
- Registration is finally functional (the old route was dead code) and
  follows current best practice (verification, rate limit, no enumeration).
- One identity store keeps the model simple and supports dual-role humans.
- No schema migration and no backfill (subscriber role is lazy + data-only;
  audiences are additive JWT claims; verification is stateless).

**Negative / trade-offs**

- Email verification tokens cannot be individually revoked before expiry
  (mitigation: short TTL; rotate `JWT_SECRET` to invalidate all).
- The per-IP rate limit is best-effort (non-atomic cache); a hard quota
  needs an edge WAF rule or an atomic counter backend.
- `member` vs `subscriber` is a convention operators must respect: never
  attach Studio policies to `subscriber`.

**Security notes (Reality Filter)**

- The audience wall and `appAccess` check are *observed-in-code* controls
  verified by unit tests (`studio-access.test.ts`,
  `token-audience.test.ts`); they reduce — not provably eliminate —
  privilege-escalation risk. [Inference]

## MCP exposure (future) — feasibility

See `docs/en/security/user-management.md` § "Exposing user management over
MCP" for the full evaluation. Summary: the **management** surface
(`/users`, `/users/invite`, role assignment) is a reasonable candidate for
an MCP tool *server* gated by an API key bound to an admin policy; the
**public auth** surface (`register`/`login`/`verify-email`) should NOT be
exposed as MCP tools (it is an end-user credential flow, not an agent
capability). Any MCP tool that can mint or elevate users MUST route through
the existing HITL `ai_approvals` path (Strict Rule #4).

## References

- `apps/cms/src/routes/auth.ts` — register / verify-email / login
- `apps/cms/src/middleware/auth.ts`, `middleware/studio-access.ts`
- `apps/cms/src/services/auth/{frontend-role,token-audience,email-verification}.ts`
- `apps/cms/src/modules/auth/registration-guard.ts`
- ADR-007 (Logto for auth), ADR-008 (Policy DSL)
