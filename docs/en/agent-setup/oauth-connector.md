---
sourceLang: en
version: 1
lastUpdated: 2026-11-12T18:31:27.082Z
contentHash: 72aee3c7683a7c7f
codeVerified: 2026-11-12T18:31:27.082Z
codeVerifiedHash: 72aee3c7683a7c7f
codeVerifiedClaims: 16
---

# Remote MCP connector (OAuth 2.1) — LumiBase

> Connect LumiBase to a **hosted MCP client** — Claude connectors, ChatGPT connectors, IDE "remote MCP" — that runs the OAuth discovery + authorization-code + PKCE flow instead of asking you to paste a long-lived token. Tracked in issue #346.

LumiBase is only the **protected resource** here. It does not issue tokens and ships no identity provider: the **authorization server** is a trusted external issuer you already configure per site (Logto, Auth0, Okta, Entra, Keycloak, …) through `/api/v1/admin/auth/issuers`.

Plain Bearer credentials keep working on the same endpoint: API keys and Studio session JWTs are unchanged. OAuth is an additional way in, not a replacement.

---

## How the flow works

1. The client sends `POST <MCP URL>` with no token. LumiBase answers `401` with
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource<MCP path>"` (RFC 9728 §5.1).
2. The client fetches that **Protected Resource Metadata** document. `authorization_servers` lists every enabled trusted issuer of the site whose configured `audience` contains the exact MCP resource URI.
3. The client runs authorization-code + PKCE against that issuer, sending `resource=<MCP resource URI>` (RFC 8707), and receives an access token whose `aud` is the MCP resource.
4. The client calls the MCP endpoint with `Authorization: Bearer <token>`. LumiBase verifies it against the issuer's JWKS, maps it to a LumiBase user and role exactly like any other external-issuer token, and narrows the capability set by the token's scopes.

Sources: [`apps/cms/src/services/mcp-oauth.ts`](../../../apps/cms/src/services/mcp-oauth.ts), [`apps/cms/src/middleware/mcp-oauth.ts`](../../../apps/cms/src/middleware/mcp-oauth.ts), [`apps/cms/src/routes/oauth-protected-resource.ts`](../../../apps/cms/src/routes/oauth-protected-resource.ts), [`apps/cms/src/modules/external-auth/adapter.ts`](../../../apps/cms/src/modules/external-auth/adapter.ts).

---

## 1. Pick the MCP URL (the resource URI)

A hosted connector only knows a URL — it cannot send the `X-Lumi-Site` header. Use one of:

| Deployment | MCP URL to give the client | Resource URI (`aud`) |
|---|---|---|
| Host mapped to one site (custom domain or free subdomain) | `https://cms.acme.com/api/v1/mcp` | same |
| Host serving several sites (or no host mapping) | `https://cms.acme.com/api/v1/mcp/sites/<siteId>` | same |

The resource URI is `<public origin><MCP path>`. The public origin is `LUMIBASE_PUBLIC_URL` when set, otherwise the request origin (upgraded to `https` when `X-Forwarded-Proto: https`). **Behind a TLS-terminating proxy, set `LUMIBASE_PUBLIC_URL`** so the URI LumiBase computes matches the one the client and the issuer use. A trailing `/` is ignored.

The site path is authoritative: an `X-Lumi-Site` header that names a different site is rejected with `400 TENANT_MISMATCH`.

---

## 2. Enable MCP for the site

Set the per-site `contentOs.mcp` flag (default off). With it off, both the endpoint and the metadata document answer `404`.

---

## 3. Configure the authorization server

In your identity provider:

1. Create an **API resource** whose identifier (Logto: *API identifier*; Auth0: *Identifier*) is exactly the resource URI from step 1.
2. Define the scopes `mcp:read`, `mcp:write`, `mcp:delete`, `mcp:admin` on it (see [Scopes](#scopes)).
3. Make sure the access token carries a role claim LumiBase can map, or plan to use `defaultRoleId` (many IdPs, Logto included, do not put roles in access tokens by default).

Then register (or update) the trusted issuer on the site and **add the resource URI to its `audience`** — that one value is what opts the issuer in as an MCP authorization server:

```bash
curl -X POST https://cms.acme.com/api/v1/admin/auth/issuers \
  -H "Authorization: Bearer <admin token>" -H "X-Lumi-Site: <siteId>" \
  -H "Content-Type: application/json" \
  -d '{
    "issuer": "https://acme.logto.app/oidc",
    "discoveryUrl": "https://acme.logto.app/oidc/.well-known/openid-configuration",
    "audience": ["https://cms.acme.com/api/v1/mcp/sites/<siteId>"],
    "algorithms": ["ES384", "RS256"],
    "claimMapping": { "email": "email", "roles": "roles" },
    "roleMapping": { "editor": { "systemKey": "editor" } },
    "defaultRoleId": null,
    "jitProvisioning": false
  }'
```

Check the result: `GET https://cms.acme.com/.well-known/oauth-protected-resource/api/v1/mcp/sites/<siteId>` must return `200` with your issuer in `authorization_servers`. A `404` means the flag is off, the issuer is disabled, or its `audience` does not contain the exact resource URI.

---

## 4. Client registration (no DCR in LumiBase)

**Decision:** LumiBase does not implement Dynamic Client Registration (RFC 7591). DCR is an authorization-server feature, and LumiBase deliberately runs no authorization server.

- If your IdP supports DCR and advertises `registration_endpoint` in its metadata, the MCP client registers itself — nothing to do.
- Otherwise **register the client manually** in the IdP: create a public client (authorization code + PKCE, no client secret) and add the client's redirect URI (the client documents it; for Claude it is shown when you add a custom connector). Then enter that **client ID** in the client's advanced connector settings.

---

## 5. Add the connector in the client

Give the client the MCP URL from step 1. It discovers the authorization server from the `401` challenge, sends you to the IdP to sign in and consent to the scopes, and connects. Request only the scopes the connector needs.

---

## Scopes

Scopes **only narrow**. The capability set still comes from the user's live RBAC bundle (the same one REST and the API-key MCP path use); scopes then remove what the token was not authorized for. A scope never grants a capability the user's role lacks.

| Scope | Keeps capabilities whose action is | Example |
|---|---|---|
| `mcp:read` | `read` | `items:read`, `schema:read` |
| `mcp:write` | anything not read/delete (`write`, `create`, `update`, `run`, `manage`) | `items:write`, `flows:run` |
| `mcp:delete` | `delete` | `schema:delete` |
| `mcp:admin` | control-plane skills, and `ai:decide` | `deleteCollection`, `createRole` |

- An exact capability string used as a scope (e.g. `items:read`) also works, for IdPs that model fine-grained scopes.
- Scopes are read from the `scope` claim (space-delimited) or `scp` (string or array).
- A token with no recognised scope keeps discovery (`initialize`, `tools/list`, `ping`) but gets no capabilities.
- An admin grant stays a full admin grant only when all four scopes are present; otherwise it is expanded to the explicit capabilities of the core skills and filtered.
- When the user's role allows a call but the token's scopes do not, LumiBase answers `403 INSUFFICIENT_SCOPE` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…", resource_metadata="…"` so the client can ask for more scopes. When the role itself does not allow it, the harness denies the call as usual.

**Control plane:** the `CONTROL_PLANE_FORBIDDEN` backstop is unchanged and runs first. A control-plane skill (dangerous, schema-mutating, or `delete*`) needs an admin principal **and**, for an OAuth token, the `mcp:admin` scope.

**Organization tools** (`org:*`, organization keys) are not offered to OAuth tokens: they answer `403 ORGANIZATION_FORBIDDEN`. Use an organization API key for that plane.

---

## Audience wall

Following the token-audience rule of [ADR-011](../architecture/decisions/adr-011-user-management-realms.md), applied to external-issuer tokens:

- **On the MCP endpoint**, an external-issuer token must contain *this* resource URI in `aud`. A token minted for another API — even by a trusted issuer — is refused with `401` (code `AUDIENCE_NOT_MCP_RESOURCE` in server logs and the `external_auth_denied` audit row) before any user is provisioned. A token for the base URL does not work on a site URL, and the reverse is also true.
- **Everywhere else**, a token whose only audience is an MCP resource is refused (`AUDIENCE_MCP_ONLY`), so a connector token cannot be replayed against REST. A token minted for both an API audience and the MCP resource works on both.

API keys and LumiBase's own session JWTs are first-party credentials and are not affected.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Client says the server does not support OAuth | Metadata `404`: `contentOs.mcp` off, or no enabled issuer has the resource URI in `audience` |
| `401` right after sign-in | Token `aud` ≠ resource URI (check `LUMIBASE_PUBLIC_URL`, trailing path, base vs site URL), or the client did not send `resource=` |
| `403` after sign-in | No role could be mapped (`NO_ROLE_MAPPING`) — set `roleMapping` or `defaultRoleId`; or `USER_NOT_PROVISIONED` with `jitProvisioning: false` |
| `403 INSUFFICIENT_SCOPE` | Re-authorize with the scope named in the challenge |
| `403 CONTROL_PLANE_FORBIDDEN` | The user is not an admin; scopes cannot change that |
