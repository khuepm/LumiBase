---
version: 9
lastUpdated: 2026-11-12T18:39:23.133Z
sourceLang: en
contentHash: 8642aaaed806d710
codeVerified: 2026-11-12T18:39:23.133Z
codeVerifiedHash: 8642aaaed806d710
codeVerifiedClaims: 120
---

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
> See **ADR-011** for the decision record.

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
| **Organization key** | organization automation | fixed `admin` | inherited site administrator | Owner/admin creates via `/orgs/:orgId/keys` | `Authorization: Bearer lbo_…` |

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
organization_members (membership N–N)
  └─ (userId, organizationId) → owner | admin | billing | member
organizations → sites.organizationId
api_keys → site role/policy links OR fixed organization admin (scope=organization)
```

- Site-plane queries filter by `site_id`; organization-plane queries filter by `organization_id`. Postgres RLS is the defense-in-depth backstop when `LUMIBASE_DB_RLS=enforce` (B130; off by default).
- **`subscriber`** is the least-privilege frontend role. It grants nothing
  until you attach content permissions to it (e.g. `articles::read WHERE
  status = 'published'`). It is created idempotently on first registration
  (`ensureSubscriberRole`), so existing instances need no backfill.

> ⚠️ **Never attach Studio/admin policies to `subscriber`.** That role's
> entire purpose is to be the safe floor for self-service signups.

---

## 2b. Email identity policy (aliases)

`users` is identity-global, so "are these two addresses the same account?" is
an instance-wide question. Before #794 the only rule was `lower(email)`:
`test+a@gmail.com`, `test+b@gmail.com` and `t.est@gmail.com` were three
accounts delivering to one mailbox. The policy is now chosen explicitly, in
two tiers — and a site can only be **stricter** than the instance:

| Instance mode | Site `strict` | Result |
|---|---|---|
| `exact` (default) | off (default) | Pre-#794 behaviour: every distinct address is its own account |
| `exact` | on | Aliases exist globally, but the site admits one membership per root mailbox |
| `root` | any | One root mailbox = one account instance-wide; the site flag is a no-op |

Root mailbox: `+tag` is stripped from the local part on every domain (a
leading `+` is kept); for Gmail the local part also loses its dots and
`googlemail.com` folds to `gmail.com`.

> **This is a policy, not a delivery guarantee.** Sub-addressing (`+tag`) is a
> provider convention. On a domain that does not implement it, `a+b@example.com`
> can be a different mailbox from `a@example.com`, and `root` mode (or a strict
> site) will still treat them as one identity — so its holders compete for one
> account or one membership. Choose `root` / strict only when that trade-off is
> acceptable for your user base; the default `exact` mode never applies it. The rule lives twice, in `emailRoot()`
(`apps/cms/src/modules/email-identity/normalize.ts`) and in the SQL function
`lumibase_email_root()` (migration `0026`); an integration test pins both to
one fixture list. Database triggers write `users.email_canonical` /
`users.email_root` and `user_sites.identity_key`, so every writer — register,
invite, SCIM, setup, seeds — is keyed the same way, and unique indexes (not a
check-then-insert) enforce the result.

**Choosing and changing it.** The instance mode is picked in the Setup Wizard
(Security step, or the review step of quick setup); existing instances are
backfilled to `exact`, so upgrading changes nothing. Later, only the bootstrap
admin can change it (`PUT /api/v1/admin/email-identity/instance`); a site admin
toggles strict for their site (`PUT /api/v1/admin/email-identity/site`).
Tightening runs a check first and refuses with `409 IDENTITY_COLLISION` and the
list of colliding accounts — merge or rename them, then retry. Loosening always
succeeds. Both accept `dryRun: true`, and every applied change is audit-logged.

**Decisions.**

- **Login under `root` accepts any alias.** `POST /auth/login` (and
  forgot-password / resend-verification) resolves the typed address to the
  account by its root mailbox, so `test+anything@gmail.com` signs into the
  `test@gmail.com` account with that account's password. This follows from
  "one mailbox = one account": every alias delivers to the same inbox, so it
  grants no access the mailbox owner does not already have.
- **Lockout is per account row, not per typed address.** Failed attempts are
  counted against the resolved account's stored address and the lock is set on
  that row by primary key; the pre-check reads the lock through the same
  resolution. Rotating aliases neither resets the counter nor dodges a lock.
  Attempts against an address that matches no account are still counted on the
  typed address (and by IP), as before.
- **Anti-enumeration is unchanged.** `/register` answers the same generic
  `202` whether the address, one of its aliases, or a strict-site alias already
  exists; the account and its membership commit in one transaction, so a
  refused membership never leaves an orphan account.

Linking several external identities (social / SSO) to one account is a separate
follow-up (`user_identities`), not part of this policy.

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

| `aud` | Meaning | Can reach Studio? | Access TTL | Refresh TTL |
|-------|---------|-------------------|-----------|-------------|
| `studio` | bootstrap admin or a role with `appAccess` | ✅ (still subject to `appAccess`/TFA) | `12h` (`STUDIO_SESSION_TTL`) | `30d` (`STUDIO_REFRESH_TTL`) |
| `frontend` | subscribers / appAccess-less roles | ❌ **hard-rejected by `withStudioAccess`** | `30d` (`FRONTEND_SESSION_TTL`) | `90d` (`FRONTEND_REFRESH_TTL`) |
| `email-verify` | one-shot registration link token | n/a (not a session token) | 24h (link) | — |
| `password-reset` | one-shot password-reset link token | n/a (not a session token) | 1h (link) | — |
| `mfa-challenge` | one-shot step-up token between password and TOTP (§4f) | n/a (not a session token) | 5m | — |

**Per-realm TTL** (`sessionTtlFor` / `refreshTtlFor`): the two realms no
longer share one lifetime — staff sessions are short (higher-value target,
cheap to re-auth), subscriber sessions are long (better UX, low risk). The
access JWT is the working credential; the refresh token (§4d) silently
renews it up to the refresh horizon. Overrides accept a compact duration
(`12h`, `30d`) or a number of seconds; a malformed value falls back to the
default so a typo can't break login.

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
| `POST /api/v1/auth/resend-verification` | public | Body `{email}`. Per-IP rate-limited. Generic `202`; re-emails the activation link only for a not-yet-active, password-based account (lost-email recovery). |
| `POST /api/v1/auth/forgot-password` | public | Body `{email}`. Per-IP rate-limited. Generic `202` (no enumeration); emails a reset link only for an active, password-based account. |
| `POST /api/v1/auth/reset-password` | public | Body `{token,password}`. Consumes a stateless `password-reset` token (1h TTL), sets the new password hash, and revokes all refresh tokens. |
| `POST /api/v1/auth/refresh` | public | Rotates the presented refresh token (cookie or body `{refreshToken}`) → fresh access JWT + rotated refresh token. Reuse of a revoked token revokes the whole family. |
| `POST /api/v1/auth/logout` | public | Revokes the presented refresh token's family and clears the cookie. Idempotent. |
| `POST /api/v1/me/change-password` | bearer | Body `{currentPassword,newPassword}`. Verifies current password, sets new hash, revokes all refresh tokens. |
| `GET /api/v1/me/sessions` | bearer | The caller's active sessions (live refresh tokens), redacted. |
| `DELETE /api/v1/me/sessions/:id` | bearer | Revoke one of the caller's own sessions. |
| `DELETE /api/v1/me/sessions` | bearer | Revoke ALL of the caller's sessions (logout everywhere). |
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
| `JWT_SECRET` | Signs Custom JWTs **and** email-verify/reset tokens. Required. |
| `STUDIO_SESSION_TTL`, `FRONTEND_SESSION_TTL` | Optional per-realm access-token TTL (defaults `12h` / `30d`). |
| `STUDIO_REFRESH_TTL`, `FRONTEND_REFRESH_TTL` | Optional per-realm refresh-token TTL / login horizon (defaults `30d` / `90d`). |
| `REFRESH_COOKIE_SAMESITE`, `REFRESH_COOKIE_DOMAIN`, `REFRESH_COOKIE_SECURE` | Optional cross-domain refresh-cookie attributes (see §4d). |
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

### Email templates

The verification, resend, and reset emails render a site DB template when
one exists (and is enabled), else a built-in inline fallback — so the flows
work out of the box. To customize, add an enabled email template with key:

| Key | Used by | Vars |
| --- | --- | --- |
| `email_verification` | register + resend-verification | `email`, `siteName`, `siteUrl`, `verifyUrl`, `token` |
| `password_reset` | forgot-password | `email`, `siteName`, `siteUrl`, `resetUrl`, `token` |

`verifyUrl`/`resetUrl` are empty when the site has no `siteUrl`; the link is
otherwise `${siteUrl}/verify-email?token=…` / `${siteUrl}/reset-password?token=…`.

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
links. A successful reset **revokes all refresh tokens** for the user, so
existing sessions can no longer be silently renewed (any still-valid access
JWT survives only until its short TTL expires).

## 4d. Silent session renewal (refresh tokens)

The access JWT (`12h`/`30d`) is a short(er) working credential; a rotating,
server-tracked **refresh token** renews it without re-entering credentials,
up to the realm's refresh horizon (default `studio` 30d / `frontend` 90d,
env `STUDIO_REFRESH_TTL` / `FRONTEND_REFRESH_TTL`).

```
POST /auth/login    → { token, refreshToken, refreshTokenExpiresAt }  (+ httpOnly cookie)
POST /auth/refresh  → { token, refreshToken, refreshTokenExpiresAt }  (rotates; cookie or body)
POST /auth/logout   → revokes the family + clears the cookie
```

Security model (`services/auth/refresh-token.ts`, table `lumibase_refresh_tokens`):

- **Hashed at rest** — only `sha256(plaintext)` is stored; plaintext is
  returned once per login/refresh.
- **Rotation** — every refresh revokes the presented row and issues a
  successor in the same `familyId` (one-time use).
- **Reuse detection** — presenting an already-revoked token (theft signal)
  revokes the entire family, forcing a fresh login. A benign double-submit
  trips this too — the accepted cost of strict rotation.

**Transport — both:** the token is set as an `httpOnly` cookie (path-scoped
to `/api/v1/auth`) **and** returned in the body. Cookie suits browser apps;
the body value suits cross-origin SPAs/SDKs where the cookie may be dropped.

Cookie attributes are env-configurable for cross-domain setups
(`refreshCookieSettings`):

| Env | Default | Notes |
| --- | --- | --- |
| `REFRESH_COOKIE_SAMESITE` | `Lax` | Set `None` when the frontend is on a **different site** than the API (cross-site). `None` forces `Secure`. `Strict` also accepted. |
| `REFRESH_COOKIE_DOMAIN` | _(host-only)_ | e.g. `.example.com` to share the cookie across subdomains (`app.` ↔ `api.`). |
| `REFRESH_COOKIE_SECURE` | `true` | Set `false` only for local `http` dev. Ignored (forced `true`) when SameSite=`None`. |

For a cross-site browser frontend you must also: serve both over HTTPS, set
`CORS_ALLOWED_ORIGINS` to the exact frontend origin (no `*`), and have the
client send `credentials: 'include'`.

**CSRF:** because the cookie is ambient (auto-sent under `SameSite=None`),
`/refresh` and `/logout` require a custom **`X-LumiBase-Refresh`** header
when the token comes from the cookie. A cross-site simple request cannot set
a custom header (and doing so from JS triggers a CORS preflight the server
gates), so this neutralises CSRF for the cookie path. Body-token callers are
exempt. The header is allow-listed in CORS; cross-site clients must send it
(any non-empty value).

## 4e. Account self-service (authenticated)

For a logged-in user (`bearer`, under `/api/v1/me`):

- **Change password** — `POST /me/change-password` verifies the current
  password, sets the new hash, and revokes all refresh tokens so other
  sessions can't be silently renewed. SSO/passwordless accounts get
  `NO_PASSWORD`.
- **Session management** — now that refresh tokens are tracked,
  `GET /me/sessions` lists the caller's active sessions (no token material),
  `DELETE /me/sessions/:id` revokes one, and `DELETE /me/sessions` revokes
  all (logout everywhere). Expired/revoked rows are swept by the hourly
  prune (§4d).

## 4f. Two-factor authentication (TOTP)

Native, per-user, **opt-in**. Enrollment lives in Studio under
**Settings → Security**; there is no wizard step and no tenant-wide switch
(the existing `enforceTfa` policy flag is what makes 2FA mandatory for a
role). Only the `studio` realm is challenged — subscriber (`frontend`)
logins are unaffected.

**Login becomes two legs.** `POST /auth/login` verifies the password as
before, then, if the user has a verified TOTP credential, returns
`{ status: 'mfa_required', challengeToken, expiresIn }` instead of a session.
The client posts that token plus a code to `POST /auth/verify-totp`, which
returns the normal login payload with `amr: ["pwd", "totp"]`.

The challenge token is a 5-minute HS256 JWT on the `mfa-challenge` audience,
so `withAuth` will never accept it as a session; its `jti` is recorded in the
cache provider on use, so a captured token cannot be replayed. `verify-totp`
is a public path (the caller has no session yet) and is therefore listed in
the `withAuth`, `site-membership`, and `studio-access` public sets — the
handler derives `userId`/`siteId` from the signed challenge, never from
client input, and re-checks the challenge's `siteId` against the resolved
tenant. Attempts are rate-limited per user (10) and per IP (30) per 15 min.

**Where secrets live.** The base32 seed is written only as a KeyProvider AEAD
envelope (`lumibase_user_totp_credentials.secret_ciphertext` +
`secret_key_id`), so production enrollment requires `ENCRYPTION_KEY`. The
plaintext seed is returned exactly once, by `POST /me/tfa/setup`, and is not
readable afterwards. The eight recovery codes are shown once and persisted as
PBKDF2 hashes (`lumibase_user_totp_recovery_codes`), single-use, with the
consuming IP recorded. Replay inside the verify window is blocked by
`last_used_step`. `users.tfa` holds only non-secret enrollment state.

**Mutating 2FA needs step-up.** Setup, recovery-code regeneration, and
disable all require the current password; the latter two also require a second
factor — a live TOTP code, or, for disable only, a recovery code, so that a
user whose seed can no longer be decrypted can still remove the dead factor. Disabling bumps `tokenVersion` and revokes refresh tokens, so a
stolen session cannot quietly downgrade the account's protection. Enroll and
disable both write audit events (`mfa_enrolled` / `mfa_disabled`); failed
verifies write `mfa_verify_failed`. TOTP codes, seeds, recovery codes, and
challenge tokens are on the audit logger's drop list, so none of them can
reach the audit trail.

**Key lifecycle.** The seed is wrapped by whichever key was active at
enrollment, and the row pins that version in `secret_key_id`; decryption
resolves the key from the envelope. Two consequences operators get wrong: the
envelope migration (`POST /admin/encryption/envelope/migrate`) re-wraps item
fields only and never touches this table, so **an old key must stay configured
for as long as any seed references it**; and because one deployment-wide key
wraps every seed, **rotating after a key leak does not protect existing
enrollments** — those users must re-enroll. The AAD (`totp-secret|<userId>`)
prevents replaying one user's ciphertext under another id; it is not a
confidentiality boundary. Full procedures in
[Encryption key operations](../operations/encryption-keys.md).

**Multi-tenancy.** A TOTP credential belongs to the **identity**, not to a
site — the tables are keyed by `user_id` only, matching the single identity
store (§2) and the existing `lumibase_admin_backup_codes`. Enrolling once
protects the user's login on every site they belong to, which is the intended
behaviour; there is no per-site enrollment and nothing to isolate by
`site_id`. Tenant-scoped side effects still are: the audit events are written
with the request's `siteId`, and disable revokes refresh tokens for the
current site. Env knobs are deployment-wide: `ENCRYPTION_KEY` (required to
enroll) and `LUMIBASE_TOTP_ISSUER` (label in authenticator apps, default
`LumiBase`).

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

## 7. User and organization management over MCP

The stdio server in `packages/mcp-server` already exposes site user/team management, including `list_users`, `get_user`, `invite_user`, `update_user`, and `remove_user`. ADR-013 adds a separate organization plane; granting site administrator does not grant organization authority.

### Credential profiles

| Credential | Advertised tools | Site routing |
|---|---|---|
| `lbk_` | Existing site tool list | `LUMIBASE_SITE_ID` required |
| `lbo_` with a site pin | Site tools plus `get_organization`, `list_sites` | Pinned site |
| `lbo_` without a pin | Eight organization tools plus site tools | Each site tool requires `site`; organization calls omit the site header |

`LUMIBASE_READ_ONLY=true` hides mutation tools for every profile. Organization roles are fixed: owner/admin manage the organization, billing/member have no inherited site authority. An organization key is always admin, never owner, and cannot change who holds authority: member, organization-key and organization-settings writes require a user session, so a leaked key cannot add its holder as a human admin, mint replacement keys or enable its own MCP tools. It requests those changes through organization MCP for a human to approve; an approved `create_org_key` shows the new key once to the approver and the stored receipt keeps no plaintext. The same human must own both organizations to approve a transfer. Owners can rename the personal organization's `default` slug. Settings shows Organization to owner/admin even with one organization; only the switcher is hidden in that case.

### Mandatory organization approvals

Organization tools are gated by `contentOs.mcp.allowOrganizationTools` (off by default), overridden by `LUMIBASE_MCP_ORG_TOOLS=off`. Writes always use the organization harness and `ai_approvals`, regardless of the legacy site governance mode. `confirm=true` cannot grant approval and cannot trigger a REST fallback.

The requesting user/key is recorded and checked again before execution. A human owner/admin decides through the organization approval API or Studio. Owner-only changes still need an owner, and organization keys cannot read or decide human receipts. Domain changes and the receipt commit atomically, so retries cannot create duplicate sites or keys. A newly minted organization key appears only in the human receipt. Run audits carry `organizationId` and `runId`, including organization requests with zero sites.

### Site management and the auth boundary

Legacy site tools retain their existing governance modes. `LUMIBASE_MCP_GOVERNED=on` refuses a mutation without a canonical governed mapping; compatibility modes may use REST. Do not assume those site modes provide the mandatory organization approval contract. See [Governed tool contract](../mcp/governed-tool-contract.md).

Public registration, password login, verification, and reset remain HTTP authentication flows rather than MCP tools. Staff identity activation and organization membership remain separate operations. Use the existing invitation flow to activate a new staff account. See [Organization settings](../features/organizations.md) for the human workflow and the site-free recovery boundary.

---

## 8. Quick reference — files

| Concern | File |
|---------|------|
| Register / verify-email / resend-verification / login / forgot+reset password | `apps/cms/src/routes/auth.ts` |
| Subscriber content access endpoints | `apps/cms/src/routes/users.ts` |
| Auth methods + audience parsing | `apps/cms/src/middleware/auth.ts` |
| Studio access + frontend wall | `apps/cms/src/middleware/studio-access.ts` |
| Subscriber role provisioning | `apps/cms/src/services/auth/frontend-role.ts` |
| Subscriber content-read grants | `apps/cms/src/services/auth/subscriber-access.ts` |
| Token audiences + access/refresh TTL helpers | `apps/cms/src/services/auth/token-audience.ts` |
| Rotating refresh tokens (issue/rotate/revoke) | `apps/cms/src/services/auth/refresh-token.ts` (table `lumibase_refresh_tokens`) |
| Email-verify / password-reset tokens | `apps/cms/src/services/auth/{email-verification,password-reset}.ts` |
| Per-IP rate limit (register/resend/forgot) | `apps/cms/src/modules/auth/registration-guard.ts` |
| Email identity policy (normaliser, lookups, guarded mode change, invite) | `apps/cms/src/modules/email-identity/` · `apps/cms/src/routes/admin-email-identity.ts` |
| Verification / reset emails | `apps/cms/src/modules/email/{verify-email,password-reset}.ts` |
| Decision record | `docs/en/architecture/decisions/adr-011-user-management-realms.md` |

---

## 9. Hardening notes & known limitations

Verified fixes shipped with this feature (see CHANGELOG):

- **Single-use password-reset (H1).** `users.password_changed_at` (migration
  `0006`) is stamped on every reset/change; a reset token whose `iat`
  predates it is rejected (`isResetTokenStale`). A leaked or replayed link
  cannot set a second password, and issuing a newer reset invalidates older
  links.
- **Global unique email (H3).** Unique index on `lower(email)` (migration
  `0006`) is the DB backstop behind the check-then-insert in `/register`;
  a lost registration race surfaces as the same generic `202`.
- **Atomic refresh rotation (M1).** Rotation claims the row with a
  conditional `UPDATE … WHERE revoked_at IS NULL`; a concurrent loser is
  treated as reuse and the family is revoked.
- **Audience-pinned session verify (M5).** `verifyCustomJwt` requires
  `aud ∈ {studio, frontend}`; a single-purpose `email-verify`/`password-reset`
  JWT can never be replayed as a session token. Tokens minted before
  per-realm audiences existed are rejected → the holder re-authenticates.
- **`/refresh` re-checks realm (M4).** Membership is re-verified and the
  audience recomputed from the role's *current* `appAccess` on every renewal.

Known limitations — **tracked follow-ups, not yet fixed** (accept or address
before relying on them in a hostile deployment):

- **H2 — IP-based rate limiting off Cloudflare.** `extractClientIp` trusts
  `CF-Connecting-IP` and has no wired remote-address resolver on the Node
  runtime, so on a bare Docker deployment an attacker can rotate the header
  (bypass the limiter) or collapse all callers into one `unknown` bucket
  (DoS registration/reset for the whole site). This is a pre-existing,
  app-wide limitation shared with the login-guard. Mitigate by fronting the
  API with Cloudflare (or a proxy that strips/sets the header) and setting
  `LUMIBASE_TRUSTED_PROXIES`; a full fix wires runtime `getConnInfo` at the
  auth call sites.
- **M2 — no absolute session lifetime.** Refresh rotation grants a fresh TTL
  every hop, so a chain that refreshes at least once per refresh-TTL window
  lives indefinitely. Only a password change (which revokes all tokens) or
  explicit logout/session-revoke ends it. Add a family-origin cap if an
  absolute cap is required.
- **L2 — refresh cookie is host-scoped across tenants.** The
  `lumibase_refresh` cookie uses one name per host; on a shared-host
  multi-tenant deployment, logging into site B overwrites site A's cookie
  (a subsequent site-A cookie `/refresh` then 401s and clears). Body-token
  transport is unaffected — cross-tenant SPAs should prefer it.

Operational note — the `lower(email)` unique index (`0006`) fails to create
if the `users` table already holds case-insensitive duplicate emails.
De-duplicate first:

```sql
SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
```
