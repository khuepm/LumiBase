---
version: 1
lastUpdated: 2026-07-25T08:19:21.531Z
sourceLang: vi
contentHash: 5bfafd0745c87140
codeVerified: 2026-07-25T08:19:21.531Z
codeVerifiedHash: 5bfafd0745c87140
codeVerifiedClaims: 8
---

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

## Auth & Security (Token Rotation)

SCIM **không dùng** Logto JWT pipeline để xác thực trực tiếp của người dùng. Thay vào đó, nó sử dụng Bearer tokens riêng:
- **Lưu trữ bảo mật**: Token thực tế được băm bằng thuật toán **SHA-256** trước khi lưu vào bảng `scim_tokens`. Plaintext token chỉ hiển thị duy nhất **một lần** khi tạo mới.
- **Rotation (Xoay vòng Token)**: Hỗ trợ tạo mới token và thu hồi (revoke) token cũ. Khi rotate, token cũ sẽ có một khoảng thời gian chờ (grace period) là **24 giờ** trước khi hết hạn hoàn toàn, đảm bảo dịch vụ không bị gián đoạn.
- **Audit Logging**: Tất cả mọi hoạt động thay đổi cấu hình SCIM (tạo user, sửa group, xóa...) đều được tự động ghi nhận vào bảng nhật ký `activity` kèm nhãn (label) của token thực hiện.

### Các API quản lý SCIM Token (yêu cầu Logto JWT):
- `POST /api/v1/scim-tokens`: Sinh token mới (trả về plaintext một lần duy nhất).
- `GET /api/v1/scim-tokens`: Danh sách token đã phát hành (mã hóa một phần, chỉ trả metadata).
- `DELETE /api/v1/scim-tokens/:id`: Thu hồi token ngay lập tức.
- `POST /api/v1/scim-tokens/:id/rotate`: Rotate token (tạo token mới + set grace period 24h cho token cũ).

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

## Multi-tenancy & Isolation

SCIM được thiết kế hoàn toàn cô lập giữa các tenant (multi-tenancy):
- **Token-based Site Extraction**: Middleware tự động trích xuất trực tiếp `siteId` được liên kết với token được tìm thấy từ database.
- **Spoofing Prevention**: Hệ thống bỏ qua bất kỳ header `X-Lumi-Site` nào được gửi từ phía client để tránh việc giả mạo tenant (spoofing). Tất cả tài nguyên (Users, Groups) được tạo/sửa đổi đều bị cô lập chặt chẽ trong phạm vi site của token đó.
