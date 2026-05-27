# SCIM 2.0 Provisioning

LumiBase implement subset của RFC 7644 đủ để Okta, Azure AD, Logto, Google Workspace tự động provision/deprovision users và groups.

## Endpoints

Mount tại `/scim/v2/*` (ngoài `/api/v1`):

| Endpoint | Method | Mục đích |
|----------|--------|----------|
| `/scim/v2/Users` | GET | List với filter (e.g. `userName eq "alice@x.com"`) |
| `/scim/v2/Users/:id` | GET | Get user |
| `/scim/v2/Users` | POST | Create user |
| `/scim/v2/Users/:id` | PUT | Replace user |
| `/scim/v2/Users/:id` | PATCH | Partial update |
| `/scim/v2/Users/:id` | DELETE | Soft delete (`active: false`) |
| `/scim/v2/Groups` | GET | List groups (= LumiBase teams) |
| `/scim/v2/Groups` | POST | Create group |
| `/scim/v2/ServiceProviderConfig` | GET | Capabilities advertisement |
| `/scim/v2/Schemas` | GET | Schema definitions |
| `/scim/v2/ResourceTypes` | GET | Resource types |

Implementation: `apps/cms/src/routes/scim.ts`.

## Auth

SCIM **không dùng** Logto JWT pipeline. Thay vào đó: bearer token riêng từ env var `SCIM_TOKEN`.

```
Authorization: Bearer <SCIM_TOKEN>
```

Token sai hoặc thiếu → 401. Token đúng → cho qua.

> Lý do: IdP gửi request trực tiếp, không có user session. Token này nên rotate định kỳ và lưu trong secret manager.

## Mapping

| SCIM | LumiBase |
|------|----------|
| `User.userName` | `users.email` |
| `User.name.givenName` / `familyName` | `users.firstName` / `lastName` |
| `User.active` | `users.status` (`active` ↔ `suspended`) |
| `Group` | `teams` row |
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

## Configuration trên IdP

### Okta

- SCIM 2.0 Connector Base URL: `https://<your-cms>/scim/v2`
- Auth: HTTP Header `Authorization: Bearer <SCIM_TOKEN>`
- Push Profile Updates, Push Groups: enabled.

### Azure AD

- Tenant URL: `https://<your-cms>/scim/v2`
- Secret token: `<SCIM_TOKEN>`
- Mappings mặc định work với LumiBase user/group.

## Multi-tenancy

SCIM hiện tại scope theo header `X-Lumi-Site` hoặc subdomain — IdP cần cấu hình endpoint per-site nếu deploy multi-tenant. Roadmap có thể thêm site routing tự động qua claim `tenant_id`.
