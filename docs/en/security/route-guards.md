---
version: 4
lastUpdated: 2026-09-28T20:04:25.222Z
sourceLang: en
contentHash: a419b13e68bdfcf4
codeVerified: 2026-09-28T20:04:25.222Z
codeVerifiedHash: a419b13e68bdfcf4
codeVerifiedClaims: 22
---

# Route guards — the `/api/v1` security chain

Every authenticated API request passes through a fixed middleware chain
mounted in `apps/cms/src/index.ts`:

```
withTenant → withDb → withAuth → withSiteMembership → requireSetupComplete
  → withStudioAccess → withControlPlaneAccessGuard → withFileUploadPolicy → withRls
```

Each layer answers one question, in order:

| Layer | Question | Failure |
| --- | --- | --- |
| `withTenant` | Which site is this request for? (`X-Lumi-Site`) | 400 |
| `withAuth` | Who is calling? (CF Access / custom JWT / API key / dev token) | 401 `UNAUTHENTICATED` |
| `withSiteMembership` | Is this principal allowed on **that** site? (`user_sites` membership; API keys already site-matched by `withAuth`) | 403 `TENANT_FORBIDDEN` |
| `withStudioAccess` | May this principal use the Studio surface? (`appAccess`, TFA) | 403 `APP_ACCESS_DENIED` / `TFA_REQUIRED` |
| `withControlPlaneAccessGuard` | Is this a system-administration path? Then require an admin principal even if the route forgets its own check. An admin principal is a role literally named `admin`/`administrator`, or a signed-in **user** whose role grants admin access in the active site (`access.admin`); API keys, anonymous and `frontend`-audience sessions never qualify through the bundle. One exception: `GET /api/v1/permissions/me` passes for any authenticated principal, because it only returns the caller's own permission bundle. | 403 `CONTROL_PLANE_FORBIDDEN` |
| `withRls` | Postgres row-level security as the last line. | — |

## Rules when adding or changing routes

1. **New `/api/v1` surface → classify it first.** Content plane (per-item
   permissions), Studio management plane (`STUDIO_ACCESS_PATH_PREFIXES` in
   `middleware/studio-access.ts`), or control plane (`CONTROL_PLANE_PATHS` in
   `middleware/control-plane-access-guard.ts`). Control-plane prefixes MUST be
   added to the guard list — per-route `adminOnly` alone is not enough,
   because a later refactor can drop it (that is exactly how the extensions
   regression happened).
2. **Never add a path to a bypass/public list without a test.** The bypass
   lists live in `middleware/auth.ts` (authentication), and the
   `PUBLIC_AUTH_PATHS` sets in `middleware/site-membership.ts` and
   `middleware/studio-access.ts`. A path that skips `withAuth` reaches its
   handler with **no principal at all** — the handler must not read
   `c.get('auth')` without handling `undefined`.
3. **Per-route guards compose with, never replace, the chain.** `adminOnly`,
   `requireSiteAdmin`, `requireSchemaPermission`, HITL approval checks etc.
   run *inside* routes; the chain above is the backstop.
4. **Dynamic dispatch surfaces (extensions, agent harness, flows) are
   control-plane.** Anything that loads and executes stored code or mutates
   agent state requires an admin principal before the handler runs.

## Tripwire tests

`apps/cms/src/__tests__/security-guards.wiring.test.ts` asserts, at source
level, that the chain stays mounted in order, that `/api/v1/auth/register` is
not on any bypass list, that the dynamic extension dispatch keeps `adminOnly`,
and that the control-plane path list covers the known admin prefixes. If one
of these assertions fails your build, you have either reintroduced a fixed
vulnerability or restructured a guard — in the latter case update the
assertion together with behavioural tests for the new shape.

Behavioural companions:

- `middleware/__tests__/site-membership.test.ts` — cross-tenant denial,
  dev/CF-Access carve-outs.
- `middleware/__tests__/control-plane-access-guard.test.ts` — admin backstop +
  audit events.
- `routes/extensions.test.ts` — admin gate on management and dynamic dispatch.
- `routes/__tests__/auth-register.test.ts` — register fails closed without a
  principal; binds the seeded member role id (never a literal role key).

## Incident history (why these rules exist)

| Fix | Vulnerability |
| --- | --- |
| PR #495 | The backstop also covered `GET /api/v1/permissions/me`, the caller's own permission bundle. Every user without the literal `admin` role got 403, so Studio showed "no read permission" on collections their role could read. The exemption is GET-only and requires a principal; the rest of `/permissions` stays admin-only. |
| PR #495 (B101) | The backstop recognised admins by role **name** only. Invited users carry their role **id**, so a user holding the Administrator role was refused by every control-plane route that `requireSiteAdmin` would have allowed. The backstop now also admits a signed-in user whose site permission bundle has `admin`; API keys are excluded pending #472. |
| PR #184 (ported) | No membership check between `withAuth` and handlers: any authenticated principal could pick an arbitrary `X-Lumi-Site` and operate on another tenant. |
| PR #152 (ported) | Refactor dropped `adminOnly` from `extensionsRouter.all('/:name/*')` — non-admins could execute endpoint bundles with host bindings. |
| PR #153/#154 | `/api/v1/agent` missing from `CONTROL_PLANE_PATHS` — low-privilege tokens could read/mutate Agent Harness state. |
| PR #150 | MCP server concatenated unvalidated `collection`/`id` into API paths — path traversal to sibling `/api/v1/*` endpoints with the operator token. |
| PR #130 (original bug, now superseded) | `/auth/register` had first crashed (handler read a principal on a `withAuth`-bypassed path) and bound users with a literal `'member'` role id. PR #190 locked it to admin-only as a stopgap; PR #130 replaces that with the intended **public self-service** design — safe because the role is resolved server-side to a zero-privilege `subscriber` and the account starts `invited` until email verification. Register is public again, but the security net is now the server-side role + verification, asserted by the tripwires above. |
