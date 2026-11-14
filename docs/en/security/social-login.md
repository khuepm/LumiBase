---
sourceLang: en
version: 2
lastUpdated: 2026-11-14T02:18:44.695Z
contentHash: c65724322363fe2a
codeVerified: 2026-11-14T02:18:44.695Z
codeVerifiedHash: c65724322363fe2a
codeVerifiedClaims: 44
---

# Social Login for Members (Google, Apple, GitHub)

> **Audience:** operators who want their site's public members (the
> `frontend` / subscriber realm) to sign in with Google, Apple or GitHub, and
> frontend developers wiring the flow into a website or app.
>
> **TL;DR:** configure a provider per site in **Settings → Social login**,
> register the shown callback URL at the provider, list your frontend's
> redirect URIs, then run a PKCE flow: `start` → provider → our callback →
> your redirect URI with a one-time `code` → `exchange` for a session. Social
> login always issues a **subscriber** session (`aud: frontend`), never Studio
> access.

Module: `apps/cms/src/modules/social-auth/routes.ts` · tables
`lumibase_user_identities` and `lumibase_social_auth_providers` (migration
`packages/database/drizzle/0031_social_login_identities.sql`).

---

## 1. How it works

```
frontend                     LumiBase CMS                        provider
   │ POST /auth/social/google/start                                  │
   │   { redirectUri, codeChallenge, state } ──►  state + nonce +     │
   │                                              server PKCE saved   │
   │ ◄── { authorizationUrl }                                         │
   │ browser ─────────────────────────────────────────────────────────►│
   │                                 ◄── GET/POST callback?code&state ─│
   │                                     token exchange (PKCE, secret) │
   │                                     ID token verified (JWKS) or   │
   │                                     GitHub /user + /user/emails   │
   │ ◄── 303 redirectUri?code=<one-time>&state=<yours>                 │
   │ POST /auth/social/exchange { code, codeVerifier } ──►             │
   │ ◄── { token, refreshToken, user }  (aud: frontend, sid set)       │
```

- **Two PKCE pairs.** The CMS holds its own verifier for the provider token
  call; your frontend holds a second verifier and must present it to redeem
  the one-time code. A code lifted from a URL, or a flow an attacker started
  and pushed onto someone else's browser, cannot be redeemed.
- **State and nonce** are random, server-side, single use, and expire after
  10 minutes; the one-time result code expires after 2 minutes.
- **No tokens in URLs.** The redirect back to your site carries only the
  one-time `code`, your `state`, and `intent` (or `error`).
- **Google / Apple:** the ID token is verified with `jose` against the
  provider's JWKS — signature, `iss`, `aud` (your client id), expiry — and its
  `nonce` must match the one we sent.
- **GitHub** has no ID token: the CMS reads `/user` (stable numeric id) and
  `/user/emails`, and only the **primary** address counts, and only as
  verified when GitHub says `verified: true`.
- **Apple** answers with `response_mode=form_post` (an HTML form POST to the
  callback), and its client secret is a short-lived ES256 JWT the CMS signs
  per exchange with your `.p8` key. Apple sends the user's **name only on the
  first authorization**; the CMS stores it then, and a returning Apple user
  keeps that name. A provider never overwrites a name the member already has.
- The session is minted by the same code path as password login, so it has a
  `sid` (shows up in **Active sessions**), a refresh token and the refresh
  cookie, and `amr: ["fed"]`.

## 2. Accounts and linking

Identities live in `lumibase_user_identities` — one row per
`(issuer, subject)`, e.g. Google account `1234`, pointing at one LumiBase
account. On `exchange`:

| Situation | Result |
|---|---|
| The provider identity is already linked | Sign in that account (it must be `active`). |
| New identity, **no** account with this email | Create an `active` account with the site's `subscriber` role, link the identity. Requires a provider-verified email. |
| New identity, an account with this email exists, the provider verified the email, the account verified its own address, and the account is a member-only account | Link automatically, then sign in. |
| Same, but the provider did not verify the email | `403 SOCIAL_EMAIL_UNVERIFIED` |
| Same, but the account has not verified its address (`invited`) | `409 LINK_REQUIRES_VERIFIED_ACCOUNT` |
| Same, but the account has Studio access on any site (or is the bootstrap admin) | `409 LINK_REQUIRES_SIGN_IN` — sign in normally, then link from the account. |
| The provider shared no email | `422 SOCIAL_EMAIL_MISSING` |

Email matching follows the instance email-identity mode
(`apps/cms/src/modules/email-identity/service.ts`): in `root` mode an alias
matches its root mailbox, in `exact` mode only the same address matches.

**Sign in, then link.** A signed-in member links a provider with
`POST /me/identities/{provider}/link` and `POST /me/identities/complete` (same
PKCE flow, `intent=link`). The provider email does not have to match — the
member proved control of both. An identity already linked to someone else is
refused with `409 IDENTITY_ALREADY_LINKED`.

**Unlink.** `DELETE /me/identities/{id}` removes a linked provider, but never
the last way into the account: with no password and no other identity it
answers `409 LAST_LOGIN_METHOD`. Identities that came from an external JWT
issuer (backfilled from `users.external_id`) are listed as `external` and
cannot be unlinked here (`409 IDENTITY_MANAGED_EXTERNALLY`).

## 3. Provider setup

In Studio open **Settings → Social login**. Each provider card shows the
**callback URL** to register at the provider; it has the form
`{LUMIBASE_PUBLIC_URL}/api/v1/auth/social/callback/{siteId}/{provider}` (the
request origin is used when `LUMIBASE_PUBLIC_URL` is not set — set it behind a
proxy so the URL is stable). Secrets are encrypted with the deployment's
`ENCRYPTION_KEY` (the same KeyProvider vault as TOTP seeds) and are write-only:
the page shows whether one is stored, never its value. Saving a secret without
`ENCRYPTION_KEY` is refused with `503 ENCRYPTION_NOT_CONFIGURED`.

### Google

1. Google Cloud Console → **APIs & Services → OAuth consent screen**: set it up
   (scopes `openid`, `email`, `profile`).
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. Add the callback URL from Studio under **Authorized redirect URIs**.
4. Paste the **Client ID** and **Client secret** into the Google card.

### Apple

1. Apple Developer → **Identifiers → App IDs**: enable *Sign in with Apple* on
   your primary App ID.
2. **Identifiers → Services IDs**: create one (this is the **client id**),
   enable *Sign in with Apple*, add your domain and the callback URL from
   Studio as a **Return URL**.
3. **Keys**: create a key with *Sign in with Apple*, download the `.p8` file
   (it can be downloaded once) and note its **Key ID**.
4. In the Apple card enter the Services ID, your **Team ID**, the Key ID, and
   paste the full `.p8` file contents (`-----BEGIN PRIVATE KEY-----…`).

Apple does not document PKCE for web sign-in, so the CMS does not send a
challenge to Apple; the code is bound by the client-secret JWT, `state` and
the ID-token `nonce`. Private relay addresses
(`…@privaterelay.appleid.com`) are verified addresses and are used as the
account email.

### GitHub

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Authorization callback URL**: the callback URL from Studio.
3. Generate a client secret; paste the **Client ID** and secret into the
   GitHub card.

### Redirect URIs (all providers)

List every URI your frontend will ask to return to, one per line. Matching is
**exact** (scheme, host, port, path, query) — no prefixes, no wildcards.
`https://` is required except for `http://localhost` during development;
custom schemes such as `myapp://oauth` are allowed for native apps. A
`redirectUri` not on the list is refused with `400 REDIRECT_URI_NOT_ALLOWED`
before the provider is contacted, so the callback can never be used as an
open redirect. A provider cannot be enabled without at least one entry and its
secret (`400 PROVIDER_INCOMPLETE`).

## 4. Frontend integration

```ts
const site = 'site_abc';
const api = 'https://cms.example.com/api/v1';

// 1. PKCE pair, kept in sessionStorage across the redirect.
const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
sessionStorage.setItem('lb_pkce', verifier);

// 2. Start.
const start = await fetch(`${api}/auth/social/google/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Lumi-Site': site },
  body: JSON.stringify({ redirectUri: 'https://www.example.com/auth/callback', codeChallenge: challenge, state: 'my-csrf' }),
}).then((r) => r.json());
location.href = start.data.authorizationUrl;

// 3. On https://www.example.com/auth/callback?code=…&state=my-csrf
const params = new URLSearchParams(location.search);
if (params.get('error')) showError(params.get('error'));
const session = await fetch(`${api}/auth/social/exchange`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'X-Lumi-Site': site },
  body: JSON.stringify({ code: params.get('code'), codeVerifier: sessionStorage.getItem('lb_pkce') }),
}).then((r) => r.json());
// session.data → { token, refreshToken, refreshTokenExpiresAt, user }
```

Check that the returned `state` equals the one you sent. `GET
/auth/social/providers` lists which providers are enabled, for rendering
buttons.

## 5. API reference

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/v1/auth/social/providers` | public | Enabled providers (`[{ provider }]`). |
| `POST /api/v1/auth/social/{provider}/start` | public, rate-limited | `{ redirectUri, codeChallenge, codeChallengeMethod?: "S256", state? }` → `{ authorizationUrl, expiresIn }`. |
| `GET` / `POST /api/v1/auth/social/callback/{siteId}/{provider}` | provider | Callback (`POST` = Apple `form_post`). Redirects `303` to `redirectUri`. |
| `POST /api/v1/auth/social/exchange` | public, rate-limited | `{ code, codeVerifier }` → session (same shape as `/auth/login`). |
| `GET /api/v1/me/identities` | session | `{ identities: [{ id, provider, issuer, emailAtLink, createdAt, unlinkable }], hasPassword }`. |
| `POST /api/v1/me/identities/{provider}/link` | session | Same body as `start`; `intent=link`. |
| `POST /api/v1/me/identities/complete` | session | `{ code, codeVerifier }` → `{ status: "linked" \| "already_linked", identity }`. |
| `DELETE /api/v1/me/identities/{id}` | session | Unlink (not the last login method). |
| `GET /api/v1/admin/social-providers` | site admin | Provider configs (secrets reported as `hasClientSecret` / `hasApplePrivateKey`) + `callbackUri`. |
| `PUT /api/v1/admin/social-providers/{provider}` | site admin | `{ enabled?, clientId, clientSecret?, appleTeamId?, appleKeyId?, applePrivateKey?, allowedRedirectUris }`. |
| `DELETE /api/v1/admin/social-providers/{provider}` | site admin | Remove the configuration. |

Errors on the redirect come back as `?error=<CODE>`: `SOCIAL_CANCELLED`,
`SOCIAL_PROVIDER_ERROR`, `SOCIAL_CODE_REJECTED`, `SOCIAL_ID_TOKEN_INVALID`,
`SOCIAL_PROVIDER_NOT_CONFIGURED`. Errors on `exchange` / `complete` use the
standard `{ errors: [{ code, message }] }` body: `SOCIAL_CODE_INVALID`,
`SOCIAL_PKCE_MISMATCH`, plus the linking codes in §2.

## 6. Multi-tenancy

- **Isolated per site:** provider configuration (`lumibase_social_auth_providers`,
  RLS `site_isolation`), the redirect allow-list, the encrypted secrets (bound to
  site + provider by AAD, so a row copied to another site does not decrypt),
  the flow state and one-time codes (cache keys carry the site id and the record
  is checked against the request's site), rate-limit counters, and the
  membership/role a login produces.
- **Shared, by design:** `lumibase_user_identities`, like `lumibase_users`, is
  identity-global — a Google account is the same person on every site. Signing
  in on site B with an identity first used on site A adds a `subscriber`
  membership on B; it never carries A's role over.
- **Verified by:** the two-site route test (a state or code from site A is
  refused on site B) and the AAD test in
  `apps/cms/src/modules/social-auth/__tests__/config-service.test.ts`.

## 7. Audit events

`social_login`, `social_account_created`, `social_identity_linked`
(`automatic: true|false`), `social_identity_unlinked`, `social_login_failed`
(with a `reason` code), `social_provider_configured` (changed field **names**
only) and `social_provider_deleted`. No token, code or secret is written to the
audit log.
