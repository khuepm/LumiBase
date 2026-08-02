---
version: 1
lastUpdated: 2026-07-25T08:19:21.531Z
sourceLang: vi
translatedFrom: vi
sourceHash: 5bfafd0745c87140
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T08:19:21.531Z
codeVerifiedHash: 5bfafd0745c87140
codeVerifiedClaims: 8
---

# SCIM 2.0 Provisioning

LumiBase implements a subset of RFC 7644 — enough for Okta, Azure AD, Logto and Google Workspace to provision and deprovision users and groups automatically.

## Endpoints

Mounted at `/scim/v2/*` (outside `/api/v1`):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/scim/v2/Users` | GET | List with a filter (e.g. `userName eq "alice@x.com"`) |
| `/scim/v2/Users/:id` | GET | Get a user |
| `/scim/v2/Users` | POST | Create a user |
| `/scim/v2/Users/:id` | PUT | Replace a user |
| `/scim/v2/Users/:id` | PATCH | Partial update |
| `/scim/v2/Users/:id` | DELETE | Soft delete (`active: false`) |
| `/scim/v2/Groups` | GET | List groups (= LumiBase teams) |
| `/scim/v2/Groups` | POST | Create a group |
| `/scim/v2/ServiceProviderConfig` | GET | Capabilities advertisement |
| `/scim/v2/Schemas` | GET | Schema definitions |
| `/scim/v2/ResourceTypes` | GET | Resource types |

Implementation: `apps/cms/src/routes/scim.ts`.

## Auth & security (token rotation)

SCIM does **not** authenticate through the Logto JWT pipeline for end-user identity. It uses its own bearer tokens instead:
- **Stored securely**: the actual token is hashed with **SHA-256** before being written to the `scim_tokens` table. The plaintext token is shown exactly **once**, at creation.
- **Rotation**: a new token can be issued and the old one revoked. On rotation the old token keeps a **24-hour** grace period before expiring completely, so the integration is not interrupted.
- **Audit logging**: every SCIM configuration change (create user, edit group, delete, …) is recorded automatically in the `activity` log, tagged with the label of the token that performed it.

### SCIM token management APIs (require a Logto JWT):
- `POST /api/v1/scim-tokens`: mint a new token (returns the plaintext once only).
- `GET /api/v1/scim-tokens`: list issued tokens (partially redacted — metadata only).
- `DELETE /api/v1/scim-tokens/:id`: revoke a token immediately.
- `POST /api/v1/scim-tokens/:id/rotate`: rotate a token (issue a new one and set the 24h grace period on the old one).

## Mapping

| SCIM | LumiBase |
|------|----------|
| `User.userName` | `users.email` |
| `User.name.givenName` / `familyName` | `users.firstName` / `lastName` |
| `User.active` | `users.status` (`active` ↔ `suspended`) |
| `Group` | a `teams` row |
| `Group.members` | `team_members` rows |

## Schema URNs

```
urn:ietf:params:scim:schemas:core:2.0:User
urn:ietf:params:scim:schemas:core:2.0:Group
urn:ietf:params:scim:api:messages:2.0:ListResponse
urn:ietf:params:scim:api:messages:2.0:Error
```

## Response format

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "id": "u_abc123",
  "userName": "alice@example.com",
  "name": { "givenName": "Alice", "familyName": "Doe" },
  "active": true,
  "meta": { "resourceType": "User", "created": "...", "lastModified": "..." }
}
```

## IdP configuration

### Okta

- SCIM 2.0 Connector Base URL: `https://<your-cms>/scim/v2`
- Auth: HTTP header `Authorization: Bearer <SCIM_TOKEN>`
- Push Profile Updates and Push Groups: enabled.

### Azure AD

- Tenant URL: `https://<your-cms>/scim/v2`
- Secret token: `<SCIM_TOKEN>`
- The default mappings work with LumiBase users/groups.

## Multi-tenancy & isolation

SCIM is designed to be fully isolated between tenants:
- **Token-based site extraction**: the middleware resolves the `siteId` bound to the token directly from the database.
- **Spoofing prevention**: the system ignores any client-supplied `X-Lumi-Site` header, so a tenant cannot be spoofed. Every resource (Users, Groups) created or modified is strictly confined to that token's site.
