---
sourceLang: en
version: 2
lastUpdated: 2026-11-14T02:22:56.785Z
contentHash: ef5e85d1d5f896d9
codeVerified: 2026-11-14T02:22:56.785Z
codeVerifiedHash: ef5e85d1d5f896d9
codeVerifiedClaims: 48
---

# Passkeys (WebAuthn)

> **Audience:** operators enabling passkeys, and integrators calling the auth API.
>
> **TL;DR:** Studio users can register passkeys under **Settings → Security →
> Passkeys** and then either sign in **without a password** or use the passkey as
> the **second factor** after the password. Either way the session is
> TFA-verified, so a policy with `enforceTfa` is satisfied. Subscribers
> (`frontend` realm) are not offered passkeys.

## 1. How it fits with password + TOTP

LumiBase already has native TOTP (see
[User management §4f](./user-management.md)).
Passkeys sit beside it; a user can hold both.

| Sign-in path | Endpoints | Session `amr` | `tfaVerified` |
|---|---|---|---|
| Password only | `POST /api/v1/auth/login` | — | no |
| Password + TOTP | `/auth/login` → `POST /api/v1/auth/verify-totp` | `["pwd","totp"]` | yes |
| Password + passkey | `/auth/login` → `POST /api/v1/auth/passkey/options` → `POST /api/v1/auth/passkey/verify` (with `challengeToken`) | `["pwd","webauthn"]` | yes |
| Passkey only (passwordless) | `POST /api/v1/auth/passkey/options` → `POST /api/v1/auth/passkey/verify` (no `challengeToken`) | `["webauthn"]` | yes |

When a Studio user with any second factor posts a correct password,
`/auth/login` answers `{ status: "mfa_required", challengeToken, expiresIn, methods }`.
`methods` lists what the challenge can be finished with: `totp`, `webauthn`, or
both. Every path mints the session through the same helper
(`completePasswordLoginSession` in `apps/cms/src/services/auth/login-session.ts`),
so the access token carries `sid` and the session shows up in
**Active sessions** and can be revoked like any other.

`withStudioAccess` (`apps/cms/src/middleware/studio-access.ts`) accepts a
session as TFA-verified when `tfaVerified` is `true` or `amr` contains
`webauthn`; enrollment is read from `users.tfa`, which is recomputed from both
the TOTP and passkey tables on every change, so disabling TOTP never un-enrolls a
passkey user.

A user under `enforceTfa` who has no second factor yet can still reach the
enrollment endpoints (`GET /api/v1/me/tfa`, `POST /api/v1/me/tfa/setup`,
`POST /api/v1/me/tfa/confirm`, `GET /api/v1/me/passkeys`,
`POST /api/v1/me/passkeys/registration-options`, `POST /api/v1/me/passkeys`)
and nothing else, so the policy is a requirement rather than a lockout. Once a
factor exists, every Studio request needs a TFA-verified session again: the
user signs in once more with the new factor.

## 2. Ceremonies

Both ceremonies are two calls. The first returns `{ ceremonyId, options }`; the
browser runs `navigator.credentials.create/get` with `options` (Studio uses
`@simplewebauthn/browser`); the second sends the result back with the
`ceremonyId`.

**Registration** (authenticated, bearer token):

```
POST /api/v1/me/passkeys/registration-options   { "password": "…" }
POST /api/v1/me/passkeys                        { "ceremonyId": "…", "response": {…}, "name": "Work laptop" }
```

Like TOTP setup, registration asks for the current password first. Options ask
for a discoverable credential (`residentKey: preferred`) so the passkey can also
be used for passwordless sign-in, with `attestation: none`. The user handle is
the LumiBase user id. Registering the user's **first** second factor signs out
every other session (same rule as TOTP enrolment, #730).

**Authentication** (public, no session yet):

```
POST /api/v1/auth/passkey/options   { "challengeToken": "…" }            ← second factor
POST /api/v1/auth/passkey/options   { }                                  ← passwordless
POST /api/v1/auth/passkey/verify    { "ceremonyId": "…", "response": {…}, "challengeToken": "…" }
```

As a second factor, the options list only the user's own credentials and
`userVerification` is `preferred`. Passwordless options carry no allow-list
(the browser offers any passkey it holds for the domain) and require user
verification (PIN or biometric), because the passkey replaces the password. The
server then finds the credential by id, checks the user handle names its owner,
and applies the same tenant and realm rules as `/auth/login`: a member of the
site (or the bootstrap admin, or an organization owner/admin) in the `studio`
realm. Otherwise it answers `403 PASSKEY_STUDIO_ONLY` or `TENANT_ACCESS_DENIED`.
A locked account (`users.locked_until` in the future) answers `423`.

Both auth endpoints are public paths, listed beside `/auth/verify-totp` in the
`withAuth`, `site-membership` and `studio-access` public sets.

**Self-service management:**

| Method + path | Body | Notes |
|---|---|---|
| `GET /api/v1/me/passkeys` | — | `{ passkeys, recoveryCodesRemaining, totpEnabled, available }` |
| `PATCH /api/v1/me/passkeys/:id` | `{ name }` | Rename. Only the caller's own passkeys. |
| `DELETE /api/v1/me/passkeys/:id` | `{ password }` | Removing the **last** second factor bumps `tokenVersion` and revokes every refresh token, like disabling TOTP. |
| `POST /api/v1/me/passkeys/recovery-codes` | `{ password }` | New recovery codes; the session must have been opened with a passkey. |

## 3. Security properties

- **Single-use, short-lived challenges.** Each options call stores
  `{ challenge, rpId, origins, … }` in the runtime cache for 5 minutes under a
  random `ceremonyId`. Verify claims it with an atomic counter and deletes it,
  so a ceremony can be redeemed once; if the cache cannot count, verify fails
  closed. As a second factor the ceremony is bound to the challenge token's
  user, site and `jti`, and the `jti` is spent on use exactly as in
  `/auth/verify-totp`.
- **Counter regression.** The stored signature counter must strictly increase
  once either side is non-zero (authenticators that keep no counter report 0
  forever and are accepted). A regression is rejected with `401 INVALID_PASSKEY`
  and audited as `passkey_counter_regression` with the stored and received
  values: it is the signal of a cloned authenticator.
- **Rate limits.** Options: 60 per IP per 15 minutes. Verify: 30 per IP and 10
  per user per 15 minutes (separate counters from TOTP).
- **Audit events.** `passkey_registered`, `passkey_removed`,
  `passkey_counter_regression`, `passkey_login_failed` (passwordless), and
  `mfa_verify_failed` with `method: "webauthn"` (second factor). No challenge,
  assertion or key material is written.
- **Nothing secret is stored.** `lumibase_user_passkeys` holds the credential id,
  COSE public key, counter, transports, AAGUID, backup state, a name and the RP ID.

## 4. Recovery

Recovery codes are shared with TOTP (`lumibase_user_totp_recovery_codes`). A
user who registers a passkey without having TOTP receives eight codes, shown
once. They are redeemed on the second-factor step through
`POST /api/v1/auth/verify-totp` with `recoveryCode`, which works for a
passkey-only account. Disabling TOTP keeps the codes while a passkey remains;
removing the last passkey with no TOTP deletes them. Losing every passkey and
every recovery code means an administrator has to reset the account.

## 5. Configuration: RP ID and origins

A passkey is bound by the browser to an **RP ID** (a domain) and every response
names the **origin** of the page that ran the ceremony. Both are the
**Studio's**, not the API's.

| Variable | Default | Meaning |
|---|---|---|
| `WEBAUTHN_ORIGINS` | unset | Comma-separated Studio origins allowed to run ceremonies. |
| `WEBAUTHN_RP_ID` | host of the Studio origin | The domain passkeys are bound to. Set a parent domain (`example.com`) to share passkeys across `studio.example.com` and `admin.example.com`. |
| `WEBAUTHN_RP_NAME` | `LumiBase` | Name the browser shows in its prompt. |

With nothing set, the server uses the request's `Origin` only when it is
already trusted: same origin as the API, equal to `LUMIBASE_PUBLIC_URL`, or
accepted by the credentialed-CORS rule (`CORS_ALLOWED_ORIGINS`, or a loopback
origin outside production). Behind a proxy that rewrites the request URL, set
`WEBAUTHN_ORIGINS` explicitly. Origins must be `https:` (or `http:` on
localhost) and belong to the RP ID. When nothing qualifies the endpoints answer
`503 WEBAUTHN_NOT_CONFIGURED`, and the Studio explains this instead of offering
to add a passkey. The resolution lives in
`apps/cms/src/modules/mfa/webauthn-config.ts`.

> **Changing `WEBAUTHN_RP_ID` orphans every registered passkey.** Each row
> records the RP ID it was created for and is only offered for that RP ID.
> Users can still sign in with password (+ TOTP or recovery code) and register
> again.

## 6. Desktop and mobile app

The Tauri shell (`apps/shell`) loads the Studio from `tauri://localhost` in
WKWebView, WebView2 or WebKitGTK. WebAuthn is either missing there or bound to
an origin no RP ID can match, so the Studio hides every passkey control inside
the shell (contract C5 in `apps/shell/README.md`). Password, TOTP and recovery
codes keep working; a passkey-only user signs in with a recovery code in the
app, or uses a browser. Passkeys registered in a browser still work in that
browser.

## 7. Implementation map

- Service: `apps/cms/src/modules/mfa/passkey-service.ts` (uses `@simplewebauthn/server`, Web Crypto only, runs on Workers and Node).
- Routes: `apps/cms/src/routes/passkeys.ts`.
- Shared factor state: `apps/cms/src/modules/mfa/tfa-state.ts`.
- Table: `packages/database/src/schema/security.ts` (`userPasskeys`), migration `packages/database/drizzle/0030_user_passkeys.sql`. Identity-scoped like the TOTP tables (keyed by `user_id`, no `site_id`): a passkey belongs to a domain, not to a LumiBase site.
- Studio: `apps/studio/src/modules/settings/passkeys-section.tsx`, `apps/studio/src/modules/auth/admin-login-page.tsx`, `apps/studio/src/lib/passkeys.ts`.

## 8. Known limits

- A refreshed access token does not carry `tfaVerified` / `amr` forward (true
  for TOTP as well), so under `enforceTfa` the user signs in again when the
  access token expires.
- Users without a password (for example, created through an external identity
  provider) cannot pass the password step-up, so they cannot register a passkey.
- Attestation is not requested, so an AAGUID allow-list of authenticator models
  is not enforced.
