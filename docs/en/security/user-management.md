# User Management Best Practices

> **Audience:** operators and integrators wiring a public frontend (e.g.
> Next.js) to a LumiBase site where visitors register, log in, and read
> content — while staff manage that content in Studio.
>
> **TL;DR:** One global `users` table is fine and intended. What keeps it
> safe is the **authorization boundary between realms**, not separate
> tables. Self-service visitors get a least-privilege `subscriber` role
> (`appAccess: false`); staff are invite-only with Studio roles; session
> tokens carry an `aud` claim so a frontend token can never reach Studio.
> See **ADR-010** for the decision record.

---

## 1. The core question: shared table vs. separate realms

A frequent question: *"If frontend visitors register into the same table
as admins, isn't that dangerous?"*

There are two readings:

| Interpretation | Verdict |
|----------------|---------|
| Give self-registered users an **admin role** | ❌ Never. Catastrophic. |
| Store them in the **same `users` table**, different role | ✅ Fine — *with* strict realm separation |

The risk lives in the **authorization boundary**, not the table. LumiBase
keeps a single identity store and separates *realms* by role + token
audience. Benefits of one store: a single human identity (one person can
be staff on one site and a subscriber on another), uniform auth, no
duplicate-account drift.

### Realms at a glance

| Realm | Who | Role | `appAccess` | Onboarding | Auth |
|-------|-----|------|-------------|------------|------|
| **Staff** | editors, admins, teammates | `administrator`, `member` | `true` | Invite-only (`POST /users/invite`) | CF Access JWT, or password `/login` (Studio token) |
| **Frontend end-user** | public visitors / subscribers | `subscriber` | `false` | Public self-service (`POST /auth/register`) | password `/login` (frontend token) |
| **Integration** | server-to-server (ISR, build) | n/a (API key) | per attached policy | Admin creates API key | `Authorization: Bearer lbk_…` |

---

## 2. Data model (single identity store)

```
users (global)                 ← one row per human identity
  ├─ id (nanoid), email, passwordHash?, status (active|invited|suspended)
  └─ isBootstrap
user_sites (membership N–N)     ← which sites + the PRIMARY role there
  └─ (userId, siteId) → roleId
roles (per site)                ← administrator | member | subscriber | custom
  └─ adminAccess, appAccess, systemKey
policies → permissions          ← what a role can actually do (Policy DSL, ADR-008)
api_keys → api_key_roles/policies  ← integration principals, scoped per site
```

- Domain rule: every domain table has `site_id` and every query filters by
  it (Strict Rule #2). RLS (`withRls`) is the defense-in-depth backstop.
- **`subscriber`** is the least-privilege frontend role. It grants nothing
  until you attach content permissions to it (e.g. `articles::read WHERE
  status = 'published'`). It is created idempotently on first registration
  (`ensureSubscriberRole`), so existing instances need no backfill.

> ⚠️ **Never attach Studio/admin policies to `subscriber`.** That role's
> entire purpose is to be the safe floor for self-service signups.

---

## 3. Authentication methods

`withAuth` (`apps/cms/src/middleware/auth.ts`) tries, in order:

1. **Dev token** (`Bearer dev:<email>:<role>`) — local dev only, triple-gated.
2. **Cloudflare Access JWT** (`cf-access-jwt-assertion` header) — the
   primary **staff/Studio** flow in production.
3. **API key** (`Authorization: Bearer lbk_…`) — integration principals.
4. **Custom JWT** (`Authorization: Bearer <HS256>`) — issued by
   `POST /auth/login` for both staff (when not using CF Access) and
   frontend subscribers.

### Token audiences (`aud`)

Custom JWTs carry an `aud` claim pinned at sign time
(`services/auth/token-audience.ts`):

| `aud` | Meaning | Can reach Studio? |
|-------|---------|-------------------|
| `studio` | bootstrap admin or a role with `appAccess` | ✅ (still subject to `appAccess`/TFA) |
| `frontend` | subscribers / appAccess-less roles | ❌ **hard-rejected by `withStudioAccess`** |
| `email-verify` | one-shot registration link token | n/a (not a session token) |

The audience wall is **defense-in-depth**: even if a role were
misconfigured to grant `appAccess`, a `frontend` token is rejected before
the policy bundle is consulted.

---

## 4. Self-service registration flow (frontend visitors)

```
Visitor (Next.js)            CMS                              Email
     │  POST /auth/register   │                                 │
     │ {email,password,name}  │  rate-limit per IP (cache)       │
     │───────────────────────▶│  create user status=invited     │
     │                        │  bind subscriber role (server)   │
     │                        │  sign email-verify JWT ──────────▶ verification link
     │   202 (generic)        │  audit: user_registered          │
     │◀───────────────────────│                                 │
     │                                                          │
     │  click link → frontend reads ?token=…                    │
     │  POST /auth/verify-email {token}                         │
     │───────────────────────▶│  verify JWT, status→active       │
     │   {status:'verified'}  │  audit: email_verified           │
     │◀───────────────────────│                                 │
     │  POST /auth/login {email,password}                       │
     │───────────────────────▶│  LoginGuard + anomaly checks     │
     │  {token (aud=frontend)} │  status must be 'active'         │
     │◀───────────────────────│                                 │
     │  GET /items/articles  (Authorization: Bearer <token>)    │
```

### Endpoints

| Endpoint | Auth | Notes |
|----------|------|-------|
| `POST /api/v1/auth/register` | public | Creates `subscriber`, `status=invited`. Per-IP rate-limited. Returns generic `202` (no enumeration). |
| `POST /api/v1/auth/verify-email` | public | Body `{token}` (or `?token=`). Flips `invited`→`active`. Idempotent (`already_verified`). |
| `POST /api/v1/auth/login` | public | Issues `frontend`/`studio` JWT. Gated on `status='active'`, LoginGuard, anomaly detector. |
| `POST /api/v1/auth/forgot-password` | public | Body `{email}`. Per-IP rate-limited. Generic `202` (no enumeration); emails a reset link only for an active, password-based account. |
| `POST /api/v1/auth/reset-password` | public | Body `{token,password}`. Consumes a stateless `password-reset` token (1h TTL) and sets the new password hash. |
| `GET /api/v1/auth/me` | bearer | Current principal incl. `isFrontendUser`. |

### Guardrails baked in

1. **Server-resolved role** — the request body cannot pick a role.
2. **Email verification** — inactive until verified; stateless `email-verify`
   JWT (24h), no token table, single-use via state transition.
3. **Per-IP rate limit** — `DEFAULT_REGISTRATION_RATE_LIMIT` (5/hour),
   best-effort, fails open on cache outage.
4. **Anti-enumeration** — identical `202` regardless of whether the email
   exists; password hashing only on the new-email path.

### Required configuration

| Env | Purpose |
|-----|---------|
| `JWT_SECRET` | Signs Custom JWTs **and** email-verify tokens. Required. |
| `LUMIBASE_SMTP_URL`, `LUMIBASE_MAIL_FROM` | Outbound verification email. Without it, the user stays `invited` (no link sent). |
| `CORS_ALLOWED_ORIGINS` | Must include your Next.js origin. |
| site `siteUrl` | Builds the `…/verify-email?token=` link in the email. |

---

## 4b. Granting subscribers read access to content

A freshly registered subscriber can log in but **sees nothing** — the
`subscriber` role is empty by design. Grant content read explicitly
(admin-only, `requireSiteAdmin`):

```
# Subscribers can read PUBLISHED articles (default publishedOnly=true)
POST /api/v1/users/subscriber-access
  { "collection": "articles" }

# All rows, only some fields:
POST /api/v1/users/subscriber-access
  { "collection": "pages", "publishedOnly": false, "fields": ["title","body"] }

GET    /api/v1/users/subscriber-access            # list current grants
DELETE /api/v1/users/subscriber-access/articles   # revoke
```

This attaches `read` permissions (Policy DSL) to a shared `subscriber`
policy bound to the role — `publishedOnly: true` compiles to the row-level
filter `{ status: { _eq: 'published' } }`. Grants take effect within ~60s
for already-authenticated subscribers (PermissionService bundle cache TTL).

> Use this instead of hand-editing policies in Studio when you just want
> "subscribers can read published X" — it is the minimal, audited primitive.

## 4c. Forgot / reset password (end-users)

Self-service password recovery (distinct from the admin backup-code
recovery in the Setup Wizard):

```
POST /auth/forgot-password { email }      → generic 202; emails a 1h reset link
   (link → frontend /reset-password?token=…)
POST /auth/reset-password  { token, password }  → sets new password hash
```

The reset token is a stateless `password-reset` JWT (same pattern as
email verification). Trade-off: no per-token revocation and the link stays
valid for its 1h TTL; rotate `JWT_SECRET` to invalidate all outstanding
links. Stateless reset does not force-expire existing sessions — acceptable
for the current 24h session TTL.

## 5. Staff onboarding (do NOT use self-service)

Staff are created **invite-only**:

```
POST /api/v1/users/invite     (requireSiteAdmin)
  { "email": "editor@acme.com", "roleId": "<member|administrator role id>" }
```

This creates/links the user with a Studio role (`appAccess: true`) and
sends a best-effort invite email. Enforce TFA on admin roles via a policy
with `enforceTfa: true` (`withStudioAccess` then requires a TFA-verified
session).

---

## 6. Frontend (Next.js) integration notes

- **Store the token** as an httpOnly, `Secure`, `SameSite` cookie set by
  your Next.js route handler — not in `localStorage` (XSS exfiltration).
- **Send the tenant**: include `X-Lumi-Site: <siteId>` (or rely on
  subdomain resolution) on every CMS call.
- **Never call Studio APIs** (`/collections`, `/roles`, `/users`, …) from
  the public frontend — those require a `studio` token and `appAccess`; a
  `frontend` token is rejected by design.
- **Use an API key for build-time/ISR** server-to-server reads, not a user
  token; scope it to a read-only policy.
- **Token lifetime** is 24h; implement a refresh/re-login UX.

---

## 7. Exposing user management over MCP (future feasibility)

> Can this surface later be exposed via **MCP** (Model Context Protocol)?
> Evaluation below. [Inference] — a design assessment, not a shipped
> capability.

**Grounding:** LumiBase already ships an MCP server —
`packages/mcp-server` (`name: 'lumibase'`, stdio transport). It exposes
**items / collections / fields** tools today and authenticates exactly the
way this evaluation recommends: a `LumiBaseClient` carrying
`Authorization: Bearer <api key>` + `X-Lumi-Site: <siteId>`
(`packages/mcp-server/src/client.ts`). So "exposing user management over
MCP" concretely means **adding a `tools/users.ts` alongside the existing
tool modules**, reusing the same API-key client — not building new infra.

**What MCP would be here:** an MCP *server* exposing user/role operations
as tools an AI agent (or external MCP client) can call.

### Recommended split

| Surface | MCP-exposable? | Rationale |
|---------|----------------|-----------|
| **Read** — list users, read roles/policies, audit queries | ✅ Low risk | Read-only, already admin-gated; maps cleanly to MCP tools. |
| **Management** — invite user, assign/revoke role, suspend, rotate API key | ⚠️ With strong gating | High-impact. Expose only behind an API key bound to an explicit admin policy, per-site scoped, and route privilege-changing calls through the HITL `ai_approvals` path. |
| **Public auth** — `register`, `login`, `verify-email` | ❌ Do not expose | These are *end-user credential flows*, not agent capabilities. An agent should never self-register accounts or handle user passwords. |

### Why it fits LumiBase cleanly

- **Capability + HITL already exist.** Strict Rule #4 requires skills with
  `schema:write`-class capability or `delete*` to go through `ai_approvals`
  first. User-mutation tools (assign admin role, delete user) are exactly
  the dangerous class — reuse that gate; do not invent a side channel.
- **Per-site scoping is native.** Every table is `site_id`-scoped and API
  keys are bound to one site, so an MCP tool inherits tenant isolation.
- **Audit is native.** `audit_log` already records `user_registered`,
  `email_verified`, `api_key_*`, role changes — MCP-initiated actions get
  the same provenance for free (set `actorEmail`/metadata to the agent).
- **Earned autonomy (L0–L4).** MCP user-management tools map onto the
  Content OS autonomy ladder: start at L1 (propose → human approves),
  promote to veto-window/autopilot only for low-risk ops (e.g. read,
  resend invite), never for role elevation.

### Hard constraints if/when implemented

1. **Never mint or elevate a principal without HITL.** Any tool that can
   grant `appAccess`/`adminAccess`, create an admin, or issue an API key
   MUST create an `ai_approvals` row first.
2. **Audience integrity.** MCP tools authenticate as an API-key principal
   (or `studio`), never by forging a user JWT; the `frontend` audience wall
   stays intact.
3. **No password handling.** MCP tools must not accept, store, or relay
   end-user passwords; verification/login stay HTTP-only.
4. **Rate + scope.** Bind the MCP server's API key to a narrow policy
   (e.g. `users::read` + `users::update` on `status`/`roleId` only) rather
   than admin bypass.

**Bottom line:** the *management* surface is a good future MCP candidate
because the safety primitives (capability gating, HITL, per-site scope,
audit, autonomy levels) are already in place — and the delivery vehicle
(`packages/mcp-server` + its API-key client) already exists, so the work is
a new `tools/users.ts` module plus an admin-scoped key, not new
infrastructure. The *public auth* surface should remain ordinary HTTP and
never become an agent tool.

---

## 8. Quick reference — files

| Concern | File |
|---------|------|
| Register / verify-email / login / forgot+reset password | `apps/cms/src/routes/auth.ts` |
| Subscriber content access endpoints | `apps/cms/src/routes/users.ts` |
| Auth methods + audience parsing | `apps/cms/src/middleware/auth.ts` |
| Studio access + frontend wall | `apps/cms/src/middleware/studio-access.ts` |
| Subscriber role provisioning | `apps/cms/src/services/auth/frontend-role.ts` |
| Subscriber content-read grants | `apps/cms/src/services/auth/subscriber-access.ts` |
| Token audiences | `apps/cms/src/services/auth/token-audience.ts` |
| Email-verify / password-reset tokens | `apps/cms/src/services/auth/{email-verification,password-reset}.ts` |
| Per-IP rate limit (register/forgot) | `apps/cms/src/modules/auth/registration-guard.ts` |
| Verification / reset emails | `apps/cms/src/modules/email/{verify-email,password-reset}.ts` |
| Decision record | `docs/en/architecture/decisions/adr-010-user-management-realms.md` |
