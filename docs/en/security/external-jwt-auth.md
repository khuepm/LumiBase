---
version: 2
lastUpdated: 2026-11-15T13:39:07.853Z
sourceLang: en
contentHash: f38ed07a22ad842c
codeVerified: 2026-11-15T13:39:07.853Z
codeVerifiedHash: f38ed07a22ad842c
codeVerifiedClaims: 4
---

# External JWT Authentication

LumiBase can authenticate users and services via JWTs issued by an external
identity provider (Okta, Microsoft Entra, Auth0, Logto, Keycloak, Cloudflare
Access, …). The token is presented as `Authorization: Bearer <jwt>` and verified
against the issuer's **public JWKS** — LumiBase stores no secret for the issuer.

This is a **security-sensitive** capability because it bypasses internal login.
The design is fail-closed and default-deny.

## How it works

For each site, an admin registers one or more **trusted issuers** at
`/api/v1/admin/auth/issuers`. On each request carrying a bearer token, the auth
chain (between the API-key and internal-JWT branches):

1. Decodes the token **unverified** only to read `iss` and `alg`.
2. Matches `iss` to a trusted issuer **for the request's site**. No match → the
   token is ignored and the chain falls through to internal auth (`skip`).
3. Rejects the token if its `alg` isn't in the issuer's allowlist (which can
   only contain asymmetric algorithms — `RS*`/`ES*`).
4. Verifies the signature and `iss`/`aud`/`exp`/`nbf` (with the configured clock
   skew) against the issuer's JWKS.
   On the MCP endpoint (`/api/v1/mcp`, `/api/v1/mcp/sites/<siteId>`) the token
   must also carry that endpoint's resource URI in `aud`. Everywhere else, a token
   whose only audience is an MCP resource is refused. Both checks run before role
   mapping and JIT provisioning. See [Remote MCP connector (OAuth 2.1)](../agent-setup/oauth-connector.md).
5. Enforces the multi-tenant gate: if the issuer maps a `siteId` claim, it must
   equal the request site.
6. Maps the token's role claim(s) to LumiBase roles via `roleMapping`
   (default-deny — unmapped → 403, never implicit admin), optionally falling
   back to `defaultRoleId`.
7. Resolves the user by `externalId`; with JIT enabled, creates the user and a
   site membership so permissions resolve normally.

Once an issuer matches (step 2), **every** subsequent failure is a fail-closed
rejection — the request never silently falls back to internal auth.

The verified claims become the principal, minus the markers that only LumiBase
itself sets: `dev`, `isBootstrap`, `tfaVerified`, `anonymous`, `apiKey` and
`mcpOAuth` are dropped (`apps/cms/src/modules/external-auth/principal-raw.ts`).
To satisfy the Studio 2FA gate, an IdP asserts MFA with the standard OIDC
`amr` (`mfa`, `otp`, `totp`, `webauthn`) or `acr` (containing `mfa`) claims, or
with `mfa` / `mfaVerified`. A `tfaVerified` claim from an IdP is ignored.

## Threat model & mitigations

| Threat | Mitigation |
|--------|------------|
| Forged / wrong-signature token | Signature verified against the issuer's public JWKS; fail-closed if JWKS can't be fetched |
| Privilege escalation (every token → admin) | **default-deny** role mapping; admin only via a `roleMapping` entry pointing at a role with `adminAccess`; the verifier never infers admin |
| Cross-tenant token reuse (site A token on site B) | Issuer is selected from the request site's trusted set; any `siteId` claim must equal the request site; same `iss` on two sites is two independent configs |
| Algorithm confusion (RS256 → HS256) | Allowlist is asymmetric-only; `HS*` and `none` are rejected; internal HS256 verification lives in a separate, unrelated branch |
| Revoked token / removed issuer | Disabling/deleting an issuer takes effect within the issuer-config cache TTL; bearer JWTs remain valid until `exp` (use short IdP token lifetimes) |
| Information leak | Raw tokens are never logged; outward errors use generic codes (`UNAUTHENTICATED`/`FORBIDDEN`); the specific reason goes only to the server log |
| Issuer asserting LumiBase-internal markers (`dev`, `isBootstrap`, `tfaVerified`) | Those claims are dropped from the principal; MFA comes from `amr`/`acr`/`mfa` |
| Token pass-through to MCP / MCP token replayed on REST | MCP requires its own resource URI in `aud`; an MCP-only token is refused on every other path |

## Configuring an issuer

```jsonc
POST /api/v1/admin/auth/issuers
{
  "issuer": "https://your-tenant.okta.com/",
  "jwksUri": "https://your-tenant.okta.com/oauth2/v1/keys",   // or discoveryUrl
  "audience": "lumibase-api",
  "algorithms": ["RS256"],
  "claimMapping": { "email": "email", "roles": "groups", "externalId": "sub" },
  "roleMapping": { "Editors": { "systemKey": "member" }, "Admins": { "systemKey": "administrator" } },
  "jitProvisioning": true,
  "clockSkewSeconds": 60
}
```

URLs must be `https://` (only `http://localhost` is allowed in development).
`algorithms` may not contain `HS256`/`HS384`/`HS512`/`none`.

## Relationship to the Cloudflare Access path

The existing Cloudflare Access branch (which trusts the `cf-access-jwt-assertion`
header) is left in place to avoid regression. Note it currently grants admin to
any valid Access token — prefer this external-JWT path with explicit role
mapping for non-CF IdPs; folding CF Access into a configurable issuer is a future
enhancement.
