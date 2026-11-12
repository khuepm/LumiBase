---
sourceLang: en
version: 1
lastUpdated: 2026-11-12T18:31:27.082Z
translatedFrom: en
sourceHash: 72aee3c7683a7c7f
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-12T18:31:27.082Z
codeVerifiedHash: 72aee3c7683a7c7f
codeVerifiedClaims: 16
---

# Remote MCP connector (OAuth 2.1) — LumiBase

> Kết nối LumiBase với một **MCP client được host** — Claude connectors, ChatGPT connectors, "remote MCP" trong IDE — loại client chạy luồng OAuth discovery + authorization-code + PKCE thay vì bắt bạn dán một token sống lâu. Theo dõi ở issue #346.

Ở đây LumiBase chỉ là **protected resource**. Nó không phát hành token và không kèm identity provider nào: **authorization server** là một trusted external issuer mà bạn đã cấu hình theo từng site (Logto, Auth0, Okta, Entra, Keycloak, …) qua `/api/v1/admin/auth/issuers`.

Bearer credential thông thường vẫn chạy trên cùng endpoint: API key và Studio session JWT không đổi. OAuth là một lối vào thêm, không thay thế.

---

## Luồng hoạt động

1. Client gửi `POST <MCP URL>` không kèm token. LumiBase trả `401` với
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource<MCP path>"` (RFC 9728 §5.1).
2. Client tải tài liệu **Protected Resource Metadata** đó. `authorization_servers` liệt kê mọi trusted issuer đang bật của site có `audience` cấu hình chứa đúng MCP resource URI.
3. Client chạy authorization-code + PKCE với issuer đó, gửi `resource=<MCP resource URI>` (RFC 8707), và nhận về access token có `aud` là MCP resource.
4. Client gọi MCP endpoint với `Authorization: Bearer <token>`. LumiBase verify token theo JWKS của issuer, map nó sang user và role LumiBase giống hệt mọi token external-issuer khác, rồi thu hẹp capability set theo scope của token.

Nguồn: [`apps/cms/src/services/mcp-oauth.ts`](../../../apps/cms/src/services/mcp-oauth.ts), [`apps/cms/src/middleware/mcp-oauth.ts`](../../../apps/cms/src/middleware/mcp-oauth.ts), [`apps/cms/src/routes/oauth-protected-resource.ts`](../../../apps/cms/src/routes/oauth-protected-resource.ts), [`apps/cms/src/modules/external-auth/adapter.ts`](../../../apps/cms/src/modules/external-auth/adapter.ts).

---

## 1. Chọn MCP URL (resource URI)

Connector được host chỉ biết một URL — nó không gửi được header `X-Lumi-Site`. Dùng một trong hai:

| Kiểu triển khai | MCP URL đưa cho client | Resource URI (`aud`) |
|---|---|---|
| Host map vào một site (custom domain hoặc subdomain miễn phí) | `https://cms.acme.com/api/v1/mcp` | như trên |
| Host phục vụ nhiều site (hoặc không có host mapping) | `https://cms.acme.com/api/v1/mcp/sites/<siteId>` | như trên |

Resource URI là `<public origin><MCP path>`. Public origin là `LUMIBASE_PUBLIC_URL` nếu được đặt, nếu không thì là origin của request (nâng lên `https` khi có `X-Forwarded-Proto: https`). **Đứng sau proxy terminate TLS thì hãy đặt `LUMIBASE_PUBLIC_URL`** để URI LumiBase tính ra khớp với URI mà client và issuer dùng. Dấu `/` ở cuối được bỏ qua.

Site trong path là nguồn quyết định: header `X-Lumi-Site` nêu một site khác sẽ bị từ chối với `400 TENANT_MISMATCH`.

---

## 2. Bật MCP cho site

Bật flag `contentOs.mcp` theo site (mặc định tắt). Khi tắt, cả endpoint lẫn tài liệu metadata đều trả `404`.

---

## 3. Cấu hình authorization server

Trong identity provider của bạn:

1. Tạo một **API resource** có identifier (Logto: *API identifier*; Auth0: *Identifier*) đúng bằng resource URI ở bước 1.
2. Khai báo các scope `mcp:read`, `mcp:write`, `mcp:delete`, `mcp:admin` trên resource đó (xem [Scopes](#scopes)).
3. Bảo đảm access token mang một role claim mà LumiBase map được, hoặc định dùng `defaultRoleId` (nhiều IdP, kể cả Logto, mặc định không đưa role vào access token).

Sau đó đăng ký (hoặc cập nhật) trusted issuer trên site và **thêm resource URI vào `audience` của nó** — chính giá trị đó là thứ opt issuer vào làm MCP authorization server:

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

Kiểm tra kết quả: `GET https://cms.acme.com/.well-known/oauth-protected-resource/api/v1/mcp/sites/<siteId>` phải trả `200` với issuer của bạn trong `authorization_servers`. `404` nghĩa là flag đang tắt, issuer bị disable, hoặc `audience` của nó không chứa đúng resource URI.

---

## 4. Đăng ký client (LumiBase không có DCR)

**Quyết định:** LumiBase không triển khai Dynamic Client Registration (RFC 7591). DCR là tính năng của authorization server, và LumiBase cố ý không chạy authorization server nào.

- Nếu IdP của bạn hỗ trợ DCR và công bố `registration_endpoint` trong metadata, MCP client tự đăng ký — không cần làm gì.
- Nếu không, **đăng ký client thủ công** trong IdP: tạo một public client (authorization code + PKCE, không client secret) và thêm redirect URI của client (client có ghi trong tài liệu; với Claude nó hiện ra khi bạn thêm custom connector). Sau đó nhập **client ID** đó vào phần cài đặt nâng cao của connector trong client.

---

## 5. Thêm connector trong client

Đưa cho client MCP URL ở bước 1. Client tự phát hiện authorization server từ challenge `401`, chuyển bạn sang IdP để đăng nhập và đồng ý cấp scope, rồi kết nối. Chỉ xin những scope connector thực sự cần.

---

## Scopes

Scope **chỉ thu hẹp**. Capability set vẫn đến từ RBAC bundle sống của user (cùng bundle mà REST và đường MCP bằng API key dùng); sau đó scope gỡ bỏ những gì token không được cấp. Scope không bao giờ cấp một capability mà role của user không có.

| Scope | Giữ các capability có action là | Ví dụ |
|---|---|---|
| `mcp:read` | `read` | `items:read`, `schema:read` |
| `mcp:write` | mọi thứ không phải read/delete (`write`, `create`, `update`, `run`, `manage`) | `items:write`, `flows:run` |
| `mcp:delete` | `delete` | `schema:delete` |
| `mcp:admin` | các skill control-plane, và `ai:decide` | `deleteCollection`, `createRole` |

- Dùng nguyên chuỗi capability làm scope (ví dụ `items:read`) cũng được, cho các IdP mô hình hoá scope chi tiết.
- Scope được đọc từ claim `scope` (phân tách bằng khoảng trắng) hoặc `scp` (chuỗi hoặc mảng).
- Token không có scope nào được nhận diện vẫn dùng được discovery (`initialize`, `tools/list`, `ping`) nhưng không có capability nào.
- Một grant admin chỉ giữ nguyên là admin đầy đủ khi có đủ cả bốn scope; nếu không, nó được khai triển thành các capability tường minh của core skill rồi lọc.
- Khi role của user cho phép một lời gọi nhưng scope của token thì không, LumiBase trả `403 INSUFFICIENT_SCOPE` kèm `WWW-Authenticate: Bearer error="insufficient_scope", scope="…", resource_metadata="…"` để client xin thêm scope. Khi chính role không cho phép, harness từ chối lời gọi như thường lệ.

**Control plane:** backstop `CONTROL_PLANE_FORBIDDEN` không đổi và chạy trước. Một skill control-plane (dangerous, sửa schema, hoặc `delete*`) cần principal admin **và**, với token OAuth, cần scope `mcp:admin`.

**Organization tools** (`org:*`, organization key) không mở cho token OAuth: chúng trả `403 ORGANIZATION_FORBIDDEN`. Dùng organization API key cho plane đó.

---

## Audience wall

Theo quy tắc token-audience của [ADR-011](../architecture/decisions/adr-011-user-management-realms.md), áp dụng cho token external-issuer:

- **Trên MCP endpoint**, token external-issuer phải chứa *đúng* resource URI này trong `aud`. Token phát cho một API khác — kể cả do trusted issuer phát — bị từ chối với `401` (mã `AUDIENCE_NOT_MCP_RESOURCE` trong server log và audit row `external_auth_denied`) trước khi bất kỳ user nào được provision. Token cho URL base không dùng được trên URL site, và ngược lại.
- **Ở mọi nơi khác**, token chỉ có audience là một MCP resource bị từ chối (`AUDIENCE_MCP_ONLY`), nên token của connector không thể bị replay vào REST. Token được phát cho cả một API audience lẫn MCP resource thì dùng được ở cả hai.

API key và session JWT của chính LumiBase là credential first-party và không bị ảnh hưởng.

---

## Troubleshooting

| Triệu chứng | Nguyên nhân thường gặp |
|---|---|
| Client báo server không hỗ trợ OAuth | Metadata `404`: `contentOs.mcp` tắt, hoặc không issuer nào đang bật có resource URI trong `audience` |
| `401` ngay sau khi đăng nhập | `aud` của token ≠ resource URI (kiểm tra `LUMIBASE_PUBLIC_URL`, path cuối, URL base hay URL site), hoặc client không gửi `resource=` |
| `403` sau khi đăng nhập | Không map được role nào (`NO_ROLE_MAPPING`) — đặt `roleMapping` hoặc `defaultRoleId`; hoặc `USER_NOT_PROVISIONED` khi `jitProvisioning: false` |
| `403 INSUFFICIENT_SCOPE` | Authorize lại với scope được nêu trong challenge |
| `403 CONTROL_PLANE_FORBIDDEN` | User không phải admin; scope không thay đổi được điều đó |
