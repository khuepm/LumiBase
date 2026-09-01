---
title: Đặc tả Hono API — LumiBase
version: 2
lastUpdated: 2026-08-30T09:36:09.209Z
sourceLang: en
translatedFrom: en
sourceHash: aeb93d6616d2f86b
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-30T09:36:09.209Z
codeVerifiedHash: aeb93d6616d2f86b
codeVerifiedClaims: 374
---

<!-- check-parity: allow inline-code -->

# Đặc tả Hono API — LumiBase

> **Dành cho AI agent:** Trang này cũng có sẵn dưới dạng Markdown sạch. Thêm `/index.md` vào bất kỳ URL tài liệu LumiBase nào.
>
> **Base URL:** `https://api.<your-site>.lumibase.dev` (hoặc `http://localhost:1989` trong môi trường phát triển local)
>
> Tất cả điểm cuối đều được đánh phiên bản dưới `/api/v1`. Mọi request phải bao gồm:
> - `Authorization: Bearer <token>` — `token` đăng nhập, hoặc API key (`lbk_…`)
> - `X-Lumi-Site: <siteId>` — định danh site (hoặc được định tuyến qua subdomain)

---

## Cấu trúc Response

Tất cả phản hồi đều tuân theo cấu trúc sau:

```json
{
  "data": <T>,
  "meta": {
    "total": 123,
    "page": 1,
    "pageSize": 50,
    "filter_count": 50
  }
}
```

Phản hồi lỗi:

```json
{
  "errors": [
    {
      "code": "PERMISSION_DENIED",
      "message": "You don't have permission to read field 'secret'.",
      "path": ["fields", "secret"],
      "extensions": { "reason": "field_policy" }
    }
  ]
}
```

### Mã lỗi (Error codes)

| Mã | HTTP | Mô tả |
|------|------|-------------|
| `PERMISSION_DENIED` | 403 | Kiểm tra policy thất bại |
| `RECORD_NOT_FOUND` | 404 | Mục không tồn tại hoặc không hiển thị với role này |
| `VALIDATION_FAILED` | 400 | Lỗi xác thực schema dữ liệu đầu vào |
| `CONFLICT` | 409 | Vi phạm ràng buộc duy nhất (unique constraint) |
| `RATE_LIMITED` | 429 | Vượt quá giới hạn tốc độ — tuân thủ `Retry-After` |
| `RATE_LIMIT_UNAVAILABLE` | 503 | Cache phía sau của rate limiter không khả dụng và bản triển khai chạy throttle ở chế độ **fail-closed** (`LUMIBASE_RATE_LIMIT_FAIL_CLOSED=true`). Tạm thời — thử lại với lùi thời gian (backoff). Không xuất hiện trong cấu hình mặc định fail-open |
| `SITE_NOT_FOUND` | 404 | Header `X-Lumi-Site` trỏ tới tenant không tồn tại |
| `TOKEN_EXPIRED` | 401 | JWT đã hết hạn — làm mới và thử lại |
| `SKILL_DENIED` | 403 | AI skill yêu cầu một capability mà phiên làm việc thiếu |
| `HITL_REQUIRED` | 202 | Thao tác nguy hiểm cần sự phê duyệt của con người (Human-In-The-Loop) |

> **Tín hiệu Deprecation.** Một điểm cuối sắp ngưng hoạt động sẽ trả về các header response IETF `Deprecation` và `Sunset` (RFC 8594) cộng với `Link rel="deprecation"` dẫn tới changelog. Phía client nên log các header này và chuyển đổi trước ngày `Sunset`. Xem `docs/en/security/owasp-api-top-10-audit.md` (API9).

---

## Tham số truy vấn chuẩn (List endpoints)

| Tham số | Ví dụ | Mô tả |
|-----------|---------|-------------|
| `fields` | `fields=id,title,author.name` | Chọn các trường cụ thể + quan hệ lồng nhau |
| `filter` | `filter[status][_eq]=published` _hoặc_ `filter={"status":{"_eq":"published"}}` | Lọc bằng toán tử quy tắc — xem [Định dạng bộ lọc](#filter-forms) |
| `sort` | `sort=-updated_at,title` | Phân cách bằng dấu phẩy, tiền tố `-` cho DESC (giảm dần) |
| `page` | `page=2` | Số trang (bắt đầu từ 1) |
| `limit` | `limit=25` | Số mục mỗi trang (tối đa 200) |
| `aggregate[count]` | `aggregate[count]=*` | Các hàm gom nhóm (aggregate) |
| `groupBy` | `groupBy=status` | Gom nhóm kết quả aggregate |
| `deep` | `deep[author][fields]=name,avatar` | Tham số truy vấn cho quan hệ lồng nhau |

> Tìm kiếm toàn văn (Full-text search) là một **điểm cuối riêng biệt**, `GET /api/v1/search` (MeiliSearch), không phải tham số của list-endpoint. Nó hỗ trợ truy vấn đơn collection lẫn xuyên collection (bỏ qua `collection`) và không phân biệt dấu tiếng Việt. Xem [features/search.md](../features/search.md).

### Toán tử bộ lọc (Filter operators)

| Toán tử | Mô tả |
|----------|-------------|
| `_eq` | Bằng (Equals) |
| `_neq` | Khác (Not equals) |
| `_lt`, `_lte`, `_gt`, `_gte` | So sánh (<, <=, >, >=) |
| `_in`, `_nin` | Nằm trong / Không nằm trong mảng |
| `_null`, `_nnull` | Là null / Khác null |
| `_contains`, `_icontains` | Chứa (phân biệt / không phân biệt hoa thường) |
| `_starts_with`, `_ends_with` | Tiền tố / Hậu tố chuỗi |
| `_between` | Khoảng (mảng hai phần tử) |
| `_and`, `_or` | Gom nhóm logic |
| `_json_contains` | JSONB `@>` — chứa giá trị / sub-object / phần tử mảng |
| `_has_key` | Trường JSON object có chứa key này |
| `_has_any_keys`, `_has_all_keys` | Trường JSON object chứa bất kỳ / tất cả các key này (mảng chuỗi) |

**Tìm kiếm bên trong JSON.** Một key trường lọc có thể là **đường dẫn dấu chấm** vào trường JSON/JSONB lồng nhau — ví dụ `filter={"metadata.author.country":{"_eq":"VN"}}` biên dịch thành tra cứu `data #>> '{metadata,author,country}'`. Các phân đoạn đường dẫn bị giới hạn trong `[A-Za-z0-9_]` và được bind dưới dạng tham số (an toàn trước SQL injection); độ sâu tối đa là 8. Các toán tử `_json_contains` / `_has_*` chạy trên JSONB và sử dụng index GIN hiện có. Các key cấp cao nhất và các trường cấu trúc hoạt động chính xác như trước.

### Định dạng bộ lọc (Filter forms)

List endpoints chấp nhận tham số truy vấn `filter` ở **hai định dạng tương đương** — dùng định dạng nào thuận tiện hơn. Cả hai đều tạo ra cùng một filter object ở phía server.

**1. Dạng ngoặc vuông (Bracket form)** — tiện dụng cho URL viết tay và HTML form:

```
GET /api/v1/items/articles?filter[status][_eq]=published&filter[views][_gte]=100
```

- Lồng nhau ánh xạ trực tiếp: `filter[field][_op]=value`.
- Giá trị được ép kiểu: `true`/`false` → boolean, `null` → null, số nguyên/thập phân sạch → number (chuỗi có số 0 ở đầu như `007` giữ nguyên chuỗi), mọi thứ khác → string.
- Toán tử mảng (`_in`, `_nin`, `_between`) chấp nhận các giá trị phân cách bằng dấu phẩy: `filter[status][_in]=published,scheduled`.
- Các nhóm logic dùng chỉ số phân đoạn: `filter[_and][0][status][_eq]=published`.

**2. Dạng JSON (JSON form)** — tốt hơn cho các bộ lọc phức tạp/lập trình và SDK:

```
GET /api/v1/items/articles?filter={"status":{"_eq":"published"}}
```

> Nếu **cả hai** đều được cung cấp trong cùng một request, **dạng JSON sẽ ưu tiên**. Một `filter` JSON sai định dạng trả về `400 VALIDATION`; key ngoặc vuông sai định dạng sẽ bị bỏ qua thay vì làm thất bại toàn bộ request.

---

## 1. Auth

| Phương thức | Đường dẫn | Auth | Mô tả |
|--------|------|------|-------------|
| `POST` | `/api/v1/auth/login` | public | Đổi mã Logto auth code hoặc username/password lấy access JWT + rotating refresh token |
| `POST` | `/api/v1/auth/register` | public | Đăng ký subscriber tự phục vụ (generic 202, chống liệt kê tài khoản, giới hạn tốc độ) |
| `POST` | `/api/v1/auth/verify-email` | public | Kích hoạt tài khoản tự phục vụ từ token gửi qua email |
| `POST` | `/api/v1/auth/resend-verification` | public | Gửi lại email kích hoạt (generic 202, giới hạn tốc độ) |
| `POST` | `/api/v1/auth/forgot-password` | public | Gửi email link đặt lại mật khẩu (generic 202, giới hạn tốc độ) |
| `POST` | `/api/v1/auth/reset-password` | public | Sử dụng token đặt lại, thiết lập mật khẩu mới, thu hồi các refresh token |
| `POST` | `/api/v1/auth/refresh` | public | Xoay vòng (rotate) refresh token (cookie hoặc body) → access JWT mới + refresh token mới |
| `POST` | `/api/v1/auth/logout` | public | Thu hồi họ (family) refresh token được xuất trình + xóa cookie |
| `POST` | `/api/v1/auth/verify-totp` | public | Chặng thứ hai của login Studio hai bước — đổi MFA challenge token + TOTP code (hoặc recovery code) lấy một session |
| `GET` | `/api/v1/auth/me` | bearer | Lấy thông tin người dùng hiện tại |
| `GET` | `/api/v1/me/tfa` | bearer | Trạng thái enroll TOTP (`{ enabled, enrolledAt, recoveryCodesRemaining }`) |
| `POST` | `/api/v1/me/tfa/setup` | bearer | Bắt đầu enroll (step-up mật khẩu) → `secret` + `otpauthUrl` dùng một lần |
| `POST` | `/api/v1/me/tfa/confirm` | bearer | Xác nhận enroll bằng một code sống → recovery code dùng-một-lần |
| `POST` | `/api/v1/me/tfa/recovery-codes` | bearer | Tạo lại recovery code (mật khẩu + TOTP code) |
| `DELETE` | `/api/v1/me/tfa` | bearer | Tắt TOTP (mật khẩu + một TOTP code hoặc một recovery code); thu hồi session và tăng `tokenVersion` |
| `POST` | `/api/v1/me/change-password` | bearer | Xác nhận mật khẩu hiện tại, đặt hash mới, thu hồi refresh token + tăng `tokenVersion` |
| `GET` | `/api/v1/me/sessions` | bearer | Liệt kê các phiên hoạt động của người gọi (live refresh tokens, đã ẩn thông tin nhạy cảm) |
| `DELETE` | `/api/v1/me/sessions/:id` | bearer | Thu hồi một phiên làm việc của người gọi |
| `DELETE` | `/api/v1/me/sessions` | bearer | Thu hồi tất cả các phiên làm việc của người gọi |
| `POST` | `/api/v1/users/subscriber-access` | site-admin | Cấp quyền `read` cho subscriber trên một collection (Policy DSL) |
| `GET`/`DELETE` | `/api/v1/users/subscriber-access[/:collection]` | site-admin | Liệt kê / thu hồi quyền đọc của subscriber |
| `GET` | `/api/v1/me/preferences` | bearer | Blob tùy chọn của người dùng hiện tại (toàn cục identity) |
| `PATCH` | `/api/v1/me/preferences` | bearer | Gộp nông (shallow-merge) bản vá tùy chọn |
| `GET` | `/api/v1/me/consents` | bearer | Liệt kê các quyết định chấp thuận (consent) của người dùng hiện tại |
| `PUT` | `/api/v1/me/consents/:type` | bearer | Cấp hoặc rút lại chấp thuận (GDPR Art. 7, PDPD) |
| `GET` | `/api/v1/me/data-export` | bearer | Tải về dữ liệu cá nhân của người dùng hiện tại (GDPR Art. 15/20) |
| `GET` | `/api/v1/me/restriction` | bearer | Trạng thái hạn chế xử lý dữ liệu hiện tại (GDPR Art. 18) |
| `PUT` | `/api/v1/me/restriction` | bearer | Đặt hạn chế xử lý dữ liệu (`{ restricted, reason? }`) |
| `GET` | `/api/v1/me/automated-decisions` | bearer | Các bản sửa đổi do Agent tạo trên nội dung của người dùng (GDPR Art. 22) |
| `GET` | `/api/v1/retention` | admin | Báo cáo khoảng thời gian lưu trữ (retention horizon) đã cấu hình |
| `POST` | `/api/v1/retention/run` | admin | Cắt tỉa `activity` + `notifications` đã xử lý vượt quá thời gian lưu trữ |

Các endpoint `/auth/refresh` + `/auth/logout` lấy từ Cookie yêu cầu header `X-LumiBase-Refresh` (chống CSRF). Refresh token được cung cấp dưới dạng `httpOnly` cookie và trong response body; xem `docs/en/security/user-management.md` §4d để biết TTL theo từng realm và env cookie cross-domain (`REFRESH_COOKIE_SAMESITE`/`_DOMAIN`/`_SECURE`).

> Việc xóa tài khoản (GDPR Art. 17) và Yêu cầu truy cập của chủ thể (SAR) được phục vụ bởi tính năng regulated-content-readiness tại `/api/v1/admin/erasure` và `/api/v1/admin/sar`.

**Login hai yếu tố (TOTP).** Tuỳ chọn và theo từng user. Khi một user đã enroll
TOTP đăng nhập vào realm Studio, `POST /api/v1/auth/login` **không** trả về một
session. Nó trả về một challenge:

```jsonc
// POST /api/v1/auth/login  →  200
{ "data": { "status": "mfa_required",
            "challengeToken": "eyJ…",   // aud: mfa-challenge, 5 min TTL
            "expiresIn": 300 } }

// POST /api/v1/auth/verify-totp  →  200 (cùng shape với login thường)
{ "challengeToken": "eyJ…", "code": "123456" }
// …hoặc, nếu mất authenticator:
{ "challengeToken": "eyJ…", "recoveryCode": "XXXX-XXXX-XXXX" }
```

Challenge token mang audience `mfa-challenge` nên không thể replay như một
session JWT, và `jti` của nó dùng-một-lần (được theo dõi trong cache provider).
Verify bị giới hạn tần suất theo user và theo IP. Verify thành công thì access
JWT được cấp với `amr: ["pwd", "totp"]`. Step-up theo policy
(`anomalyAction: 'require_mfa'`) dùng đúng luồng challenge này khi user đã
enroll TOTP, và vẫn trả `401 MFA_REQUIRED` khi họ chưa enroll.

Enroll là luồng hai bước có step-up mật khẩu: `POST /me/tfa/setup` trả secret
base32 và `otpauthUrl` một lần (không đọc lại được), rồi `POST /me/tfa/confirm`
chứng minh sở hữu bằng một code sống và trả về tám recovery code dùng-một-lần.
Seed TOTP chỉ được lưu dưới dạng envelope AEAD của KeyProvider, nên enroll ở
production đòi `ENCRYPTION_KEY`; recovery code được lưu dưới dạng hash PBKDF2.
Đặt `LUMIBASE_TOTP_ISSUER` để điều khiển nhãn hiện trong app authenticator (mặc
định `LumiBase`).

Tình trạng khoá được báo tường minh chứ không phải `500`: `setup` trả
`503 ENCRYPTION_NOT_CONFIGURED` khi deployment không có khoá active nào, còn
verify / regenerate trả `409 TFA_KEY_UNAVAILABLE` khi khoá đã bọc chính seed đó
không còn trong cấu hình. Ở trường hợp sau, `DELETE /me/tfa` chấp nhận một
**recovery code** thay cho TOTP code, để user tháo được một enrollment mà seed
của nó không còn giải mã được. Xem
[Vận hành khoá mã hoá](../operations/encryption-keys.md).

**Quản lý chấp thuận (Consent management)** (`:type` ∈ `marketing` · `analytics` · `personalization` · `functional` · `sale_share`):

```jsonc
// PUT /api/v1/me/consents/marketing
{ "granted": true, "source": "preference_center", "version": "v1" }

// Response
{ "data": { "consentType": "marketing", "granted": true,
            "grantedAt": "2026-06-24T10:00:00.000Z", "withdrawnAt": null,
            "source": "preference_center", "version": "v1",
            "updatedAt": "2026-06-24T10:00:00.000Z" } }
```

Mỗi thay đổi sẽ ghi lại một sự kiện audit `consent_granted` / `consent_withdrawn`. Chỉ người dùng (không phải API key) mới có thể quản lý chấp thuận. Trạng thái hiện tại được lưu theo `(site_id, user_id, consent_type)` trong `user_consents`; lịch sử đầy đủ nằm trong log audit.

**Hủy đăng ký email & chặn gửi (CAN-SPAM):**

| Phương thức | Đường dẫn | Auth | Mô tả |
|--------|------|------|-------------|
| `GET` | `/api/v1/email/unsubscribe?token=…` | public | Hủy đăng ký 1-click (hiển thị trang xác nhận HTML) |
| `POST` | `/api/v1/email/unsubscribe` | public | RFC 8058 1-click (token trong query hoặc form body) |
| `GET` | `/api/v1/email/suppressions` | admin | Liệt kê các địa chỉ bị chặn |
| `POST` | `/api/v1/email/suppressions` | admin | Thêm địa chỉ bị chặn (`{ email, reason? }`) |
| `DELETE` | `/api/v1/email/suppressions/:email` | admin | Xóa địa chỉ khỏi danh sách chặn (đăng ký lại) |

Token hủy đăng ký là một HS256 JWT không lưu trạng thái (`{ siteId, email }`, không hết hạn) được ký bằng `JWT_SECRET`. Việc gửi email Marketing (`EmailModuleService.send({ category: 'marketing' })`) sẽ lọc người nhận đối chiếu với `email_suppressions` trước khi gửi. Việc hủy đăng ký / chặn gửi ghi nhận audit `email_unsubscribed` / `email_suppressed` / `email_unsuppressed`.

**Tùy chọn & hành động lưu.** `PATCH /api/v1/me/preferences` gộp nông bản vá đã xác thực vào `users.preferences` (các phần khác như `language` / `keybindings` được giữ nguyên). Gửi `{ "saveAction": "stay" | "return" | "create_new" }` để đặt điều hướng sau khi lưu của trình chỉnh sửa Studio; gửi `{ "saveAction": null }` để quay về mặc định của site (`sites.default_save_action`, đặt qua `PATCH /api/v1/site`). Enum không hợp lệ → 400.

### Xác thực External JWT

Một site có thể tin tưởng các JWT được cấp bởi IdP bên ngoài (Okta, Entra, Auth0, Logto, Keycloak, Cloudflare Access…). Xuất trình token dưới dạng `Authorization: Bearer <jwt>` kèm theo `X-Lumi-Site`. Chuỗi xác thực xác minh nó đối với **JWKS công khai** của nhà phát hành (giữa nhánh API-key và internal-JWT): khớp `iss` của token với nhà phát hành tin tưởng được đăng ký cho site đó, xác minh chữ ký + `aud`/`exp`/`nbf` với các thuật toán được phép (chỉ bất đối xứng) của nhà phát hành, ánh xạ claim role sang role LumiBase (**mặc định từ chối** — không có ánh xạ nghĩa là 403, không bao giờ tự động cho admin), bắt buộc bất kỳ claim `siteId` nào phải bằng site của request, và tùy chọn JIT-provisioning người dùng. Token có `iss` không tin tưởng sẽ bị bỏ qua (chuyển sang internal auth); một khi nhà phát hành đã khớp, xác minh sẽ hoạt động theo chế độ fail-closed.

CRUD quản trị cho các nhà phát hành tin tưởng (chỉ admin):

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/admin/auth/issuers` | Liệt kê các nhà phát hành bên ngoài tin tưởng |
| `POST` | `/api/v1/admin/auth/issuers` | Đăng ký một nhà phát hành |
| `GET` | `/api/v1/admin/auth/issuers/:id` | Lấy chi tiết một nhà phát hành |
| `PATCH` | `/api/v1/admin/auth/issuers/:id` | Cập nhật |
| `DELETE` | `/api/v1/admin/auth/issuers/:id` | Xóa |

**Cấu hình Issuer:** `{ issuer, jwksUri | discoveryUrl, audience, algorithms (RS*/ES* only), claimMapping: { email, roles, siteId?, externalId? }, roleMapping: { "<claim role>": { roleId | systemKey } }, defaultRoleId?, jitProvisioning, clockSkewSeconds (≤300), enabled }`. Errors: `VALIDATION_FAILED` (422, bao gồm thuật toán HS*/`none`), `ISSUER_ALREADY_EXISTS` (409), `NOT_FOUND` (404).

**Request đăng nhập:**
```json
{
  "email": "admin@example.com",
  "password": "your-password"
}
```

**Response đăng nhập:** một bearer `token` đơn lẻ cộng với thông tin người dùng. Gửi token dưới dạng `Authorization: Bearer <token>` ở các request tiếp theo.

```json
{
  "data": {
    "token": "eyJ...",
    "user": {
      "id": "usr_abc123",
      "email": "admin@example.com",
      "firstName": "Admin",
      "lastName": "User",
      "avatar": null
    }
  }
}
```

> Cho việc truy cập server-to-server dài hạn, hãy tạo một API key (`POST /api/v1/api-keys`, tiền tố token `lbk_`) thay vì dùng token đăng nhập.

---

## 2. Schema Admin

### Collections

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/collections` | Liệt kê tất cả collections |
| `POST` | `/api/v1/collections` | Tạo một collection mới |
| `GET` | `/api/v1/collections/:name` | Lấy chi tiết collection |
| `PATCH` | `/api/v1/collections/:name` | Cập nhật meta collection (tên hiển thị, icon, ghi chú) |
| `DELETE` | `/api/v1/collections/:name` | Xóa mềm collection |
| `GET` | `/api/v1/collections/:name/schema` | Xuất schema collection dạng JSON |
| `PUT` | `/api/v1/collections/:name/schema` | Áp dụng schema (idempotent, nhận biết diff) |
| `POST` | `/api/v1/collections/diff` | So sánh schema bundle với hiện tại |

**Request tạo collection:**
```json
{
  "name": "articles",
  "displayName": "Articles",
  "icon": "article",
  "note": "Blog articles",
  "singleton": false,
  "status_field": "status",
  "sort_field": "sort"
}
```

### Fields

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/fields/:collection` | Liệt kê các trường trong collection |
| `POST` | `/api/v1/fields/:collection` | Thêm một trường |
| `GET` | `/api/v1/fields/:collection/:field` | Lấy chi tiết trường |
| `PATCH` | `/api/v1/fields/:collection/:field` | Cập nhật cấu hình trường |
| `DELETE` | `/api/v1/fields/:collection/:field` | Xóa trường |

**Request tạo trường:**
```json
{
  "field": "title",
  "type": "string",
  "interface": "input",
  "display": "raw",
  "options": { "placeholder": "Article title" },
  "required": true,
  "sort": 1
}
```

### Relations

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/relations` | Liệt kê tất cả các quan hệ |
| `POST` | `/api/v1/relations` | Tạo quan hệ |
| `PATCH` | `/api/v1/relations/:id` | Cập nhật quan hệ |
| `DELETE` | `/api/v1/relations/:id` | Xóa quan hệ |

### Code-First Configuration (Config Manifest)

Xuất / diff / áp dụng **cấu hình schema** của một site — collections, fields, relations, settings và webhooks — dưới dạng một file JSON manifest khai báo có thể quản lý phiên bản (`lumibase.config@v1`). Được xây dựng cho CI/CD và đồng bộ môi trường (giống như Directus schema snapshot/apply). **Chỉ dành cho Admin.** **Không** bao gồm các mục nội dung, secrets, hay kiểm soát truy cập (dùng `/api/v1/access/*` cho loại sau).

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/config/export?scope=all\|schema\|settings\|webhooks` | Xuất config manifest |
| `POST` | `/api/v1/config/import?dryRun=true&mode=<mode>` | Xác thực + diff manifest (không ghi) |
| `POST` | `/api/v1/config/import?mode=<mode>&allowDestructive=true` | Áp dụng manifest trong một transaction |

`mode` ∈ `merge` (chỉ tạo/cập nhật — không bao giờ xóa), `replace-managed` (xóa cả tài nguyên nằm trong `managedScopes` của manifest), `replace-all` (đồng bộ hoàn toàn — xóa bất kỳ thứ gì không có trong manifest). Các thay đổi phá hủy rủi ro cao (xóa collection/field đang có dữ liệu, đổi kiểu dữ liệu trường, mở rộng `onDelete` của quan hệ sang `cascade`) bị từ chối trừ khi `allowDestructive=true`.

**Response Export** (`{ data: ConfigManifest }`):
```json
{
  "data": {
    "version": "lumibase.config@v1",
    "exportedAt": "2026-06-22T00:00:00.000Z",
    "collections": [{ "name": "articles", "label": "Articles", "versioning": true }],
    "fields": [{ "collection": "articles", "field": "title", "type": "string", "interface": "input" }],
    "relations": [],
    "webhooks": [],
    "settings": [{ "key": "login_security_policy", "value": { } }],
    "managedScopes": ["articles"]
  }
}
```

**Response Dry-run / apply** (`{ data: { valid, errors, diff, applied? } }`): phần `diff` liệt kê số lượng `create | update | unchanged | delete` theo từng tài nguyên và `risk` cấp cao nhất (`low | medium | high`). Khi áp dụng, `applied` báo cáo `{ created, updated, deleted }`. Lỗi xác thực dùng các mã `UNSUPPORTED_MANIFEST_VERSION`, `DANGLING_REFERENCE`, `DUPLICATE_KEY`; áp dụng phá hủy bị chặn trả về HTTP 409 `DESTRUCTIVE_BLOCKED`.

CLI: `pnpm --filter @lumibase/cms config export|diff|apply` — xem [`docs/en/contributing/code-first-config.md`](../contributing/code-first-config.md).

---

## 3a. Pages (Delivery page-builder rows)

CRUD đã xác thực Studio trên `lumibase_pages` (được tiêu thụ bởi `GET /api/v1/deliver/page/:site_id/:slug`). Việc tạo và đổi tên slug sẽ xóa ngay lập tức các tombstone negative-cache tương ứng.

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/pages` | Liệt kê các trang của site đang hoạt động |
| `POST` | `/api/v1/pages` | Tạo `{ slug, title, layoutConfig? }` |
| `GET` | `/api/v1/pages/:id` | Lấy chi tiết một trang |
| `PATCH` | `/api/v1/pages/:id` | Cập nhật một phần (`slug` / `title` / `layoutConfig`) |
| `DELETE` | `/api/v1/pages/:id` | Xóa trang |

Định dạng slug khớp với quy tắc kiểm tra của Delivery (`^[a-z0-9]+(?:[/_-][a-z0-9]+)*$`, ≤200).

Admin cache purge (control-plane): `POST /api/v1/utils/cache/purge` với `{ tags?: string[], keys?: string[] }` — mọi tag/key phải chứa `siteId` đang hoạt động.

---

## 3. Items (Generic CRUD)

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/items/:collection` | Liệt kê các mục (có phân trang, bộ lọc) |
| `POST` | `/api/v1/items/:collection` | Tạo mục (hoặc mảng cho hàng loạt) |
| `GET` | `/api/v1/items/:collection/:id` | Lấy một mục duy nhất |
| `PATCH` | `/api/v1/items/:collection/:id` | Cập nhật một phần |
| `PUT` | `/api/v1/items/:collection/:id` | Thay thế hoàn toàn |
| `DELETE` | `/api/v1/items/:collection/:id` | Xóa mục — **409 nếu bị chặn bởi phụ thuộc** |
| `GET` | `/api/v1/items/:collection/:id/dependents` | Liệt kê các bản ghi tham chiếu tới mục này |
| `POST` | `/api/v1/items/:collection/:id/resolve-dependents` | Xử lý hàng loạt các phụ thuộc của quan hệ |
| `GET` | `/api/v1/items/:collection/:id/revisions` | Liệt kê các bản sửa đổi (revisions) |
| `POST` | `/api/v1/items/:collection/:id/revert` | Khôi phục lại một bản sửa đổi |
| `GET` | `/api/v1/items/:collection/:id/versions` | Liệt kê các bản nháp có tên (mỗi bản có cờ `mainChanged`) |
| `POST` | `/api/v1/items/:collection/:id/versions` | Tạo bản nháp `{ key, name }` (chụp lại main hiện tại) |
| `GET` | `/api/v1/items/:collection/:id/versions/:key` | Lấy chi tiết một bản nháp |
| `PATCH` | `/api/v1/items/:collection/:id/versions/:key` | Cập nhật bản nháp `{ data?, name? }` (không chạm vào main) |
| `DELETE` | `/api/v1/items/:collection/:id/versions/:key` | Xóa một bản nháp |
| `GET` | `/api/v1/items/:collection/:id/versions/:key/compare` | Diff các trường với main → `{ main, version, changes }` |
| `POST` | `/api/v1/items/:collection/:id/versions/:key/promote` | Áp dụng bản nháp vào main (ghi một revision); `meta.mainDiverged` |

**Các bản ghi phụ thuộc (Dependent records).** Vì các tham chiếu item nằm trong JSONB (không phải cột FK vật lý), `onDelete` của một quan hệ được thực thi ở lớp ứng dụng. Khi `DELETE`, nếu một quan hệ khai báo `restrict` vẫn còn bản ghi trỏ tới item, lệnh xóa sẽ bị chặn với **409 `DEPENDENT_RECORDS_EXIST`** và một mảng `dependents`. (`set null`/`cascade` **không** tự động áp dụng khi xóa mềm — điều đó sẽ làm hỏng khả năng phục hồi của xóa mềm; trình biên tập phải xóa chúng một cách tường minh.) `GET …/dependents` trả về `{ data: { blocking, dependents: [{ relation, collection, field, onDelete, count, sample }] } }`. `POST …/resolve-dependents` nhận `{ action: "set_null"|"delete"|"reassign", relation, newTargetId?, hard? }` và chạy trong một transaction (lệnh delete ủy quyền cho đường dẫn xóa item thông thường). Lỗi: `DEPENDENT_RECORDS_EXIST` (409), `FIELD_REQUIRED` (409, set_null trên trường bắt buộc), `INVALID_TARGET` (422, reassign), `NOT_FOUND` (404).

**Phân trang danh sách & Tổng số.** `GET /items/:collection` chấp nhận `limit` (1–200, mặc định 25), `offset`, và `meta`:

- `meta=total_count` (mặc định) — phản hồi là `{ data, meta: { total, limit, offset } }`.
- `meta=none` — bỏ qua câu lệnh aggregate `count(*)` để truy vấn rẻ hơn; phản hồi là `{ data, meta: { limit, offset } }` (không có `total`). Dùng cho dạng cuộn vô tận (infinite-scroll) / bảng tin không bao giờ hiển thị tổng số trang.

Mặc định không đổi, nên các client hiện tại tiếp tục nhận `meta.total`. `@lumibase/sdk` `readItems` chấp nhận tùy chọn `meta` tương tự.

**Header tùy chọn:**
- `X-Lumi-Draft: true` — lấy phiên bản nháp
- `X-Lumi-Locale: vi` — áp dụng dịch ở phía server

**Tạo mục:**
```json
{ "title": "Hello World", "status": "draft", "author": "usr_abc123" }
```

**Tạo hàng loạt (body dạng mảng):**
```json
[
  { "title": "Article 1", "status": "published" },
  { "title": "Article 2", "status": "draft" }
]
```

---

## 3b. Content Releases

Một **Release** gom các bản sửa đổi mục cụ thể trên nhiều collection thành một gói có tên để xuất bản tất cả cùng lúc — thủ công hoặc lên lịch theo ngày/giờ (giống Directus Releases). Xuất bản ủy quyền cho đường dẫn cập nhật item, do đó các cổng biên tập, xác thực, quyền và hook đều được áp dụng.

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `POST` | `/api/v1/releases` | Tạo release (`draft`, hoặc `scheduled` nếu `publishAt` được đặt) |
| `GET` | `/api/v1/releases` | Liệt kê các release (`?status=&page=&limit=`) |
| `GET` | `/api/v1/releases/:id` | Chi tiết release + các mục của nó |
| `PATCH` | `/api/v1/releases/:id` | Cập nhật meta, `addItems`/`removeItems`, đặt `publishAt` |
| `POST` | `/api/v1/releases/:id/publish` | Xuất bản ngay (thủ công) |
| `DELETE` | `/api/v1/releases/:id` | Xóa release (xóa nối tiếp các mục) |

**Body Tạo / Patch:**
```json
{
  "name": "Spring launch",
  "atomicityMode": "all_or_nothing",
  "publishAt": "2026-07-01T09:00:00Z",
  "maintenanceWindow": { "windows": [{ "dow": 1, "start": "09:00", "end": "17:00" }] },
  "addItems": [
    { "collection": "articles", "itemId": "itm_1", "targetStatus": "published", "revisionId": "rev_3" }
  ]
}
```

`atomicityMode`: `all_or_nothing` (kiểm tra trước mọi mục có thể xuất bản được — tồn tại, chưa bị xóa, thỏa mãn cổng biên tập — và không xuất bản gì nếu có bất kỳ mục nào bị chặn) hoặc `best_effort` (xuất bản độc lập từng mục, ghi nhận kết quả từng mục). `revisionId` ghim snapshot của bản sửa đổi cụ thể; bỏ qua để xuất bản trạng thái live của mục tại thời điểm xuất bản.

**Response Xuất bản** (`{ data: { release, status, outcomes } }`): `status` là `published` | `partially_failed` | `failed`; mỗi outcome là `{ collection, itemId, outcome: 'published'|'skipped'|'failed', reason? }`. Xuất bản một phần / thất bại vẫn trả về **HTTP 200** kèm kết quả.

**Mã lỗi:** `EMPTY_RELEASE` (422), `ALREADY_PUBLISHED` (409), `RELEASE_IMMUTABLE` (409, chỉnh sửa các mục của release đã xuất bản), `ITEM_NOT_FOUND` (404), `REVISION_STAGED` (409, ghim bản sửa đổi chưa commit), `VALIDATION_FAILED` (422, bao gồm `publishAt` trong quá khứ). Các yếu tố chặn xuất bản từng mục xuất hiện dưới dạng lý do outcome `EDITORIAL_GATE_REQUIRED` / `ITEM_DELETED`.

Các release lên lịch được xuất bản qua nhịp `content-scheduler` dùng chung (`sweepDueReleases`) — idempotent và nhận biết `maintenanceWindow`.

---

## 4. Permissions, Roles & Policies

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/permissions/me` | Ma trận quyền hiệu lực của người dùng hiện tại |
| `POST` | `/api/v1/permissions/check` | Debug: đánh giá một quy tắc policy |
| `GET/POST/PATCH/DELETE` | `/api/v1/roles` | CRUD Role |
| `GET/POST/PATCH/DELETE` | `/api/v1/policies` | CRUD Policy |
| `GET/POST/DELETE` | `/api/v1/policies/:id/permissions` | Các quy tắc quyền trong một policy |
| `POST` | `/api/v1/policies/:id/attach` | Gắn policy cho một role, user, hoặc team |

**Cấu trúc quy tắc quyền:**
```json
{
  "collection": "articles",
  "action": "read",
  "fields": ["id", "title", "status"],
  "conditions": { "status": { "_eq": "published" } }
}
```

---

## 5. Users & Teams

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET/POST` | `/api/v1/users` | Liệt kê / tạo người dùng |
| `GET/PATCH/DELETE` | `/api/v1/users/:id` | Lấy / cập nhật / xóa người dùng |
| `POST` | `/api/v1/users/invite` | Gửi email mời |
| `POST` | `/api/v1/users/:id/impersonate` | Mạo danh (chỉ admin) |
| `GET` | `/api/v1/users/:id/sessions` | Liệt kê các phiên hoạt động |
| `DELETE` | `/api/v1/sessions/:id` | Thu hồi một phiên làm việc |
| `GET/POST/PATCH/DELETE` | `/api/v1/teams` | CRUD Team |

---

## 6. Files & Assets

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `POST` | `/api/v1/files/presigned-url` | Lấy URL PUT presigned của R2/S3 |
| `POST` | `/api/v1/files` | Đăng ký metadata file sau khi upload |
| `GET` | `/api/v1/files` | Liệt kê các file (có bộ lọc) |
| `GET` | `/api/v1/files/:id` | Metadata file |
| `PATCH` | `/api/v1/files/:id` | Cập nhật metadata (tiêu đề, tag, thư mục) |
| `DELETE` | `/api/v1/files/:id` | Xóa file |
| `GET` | `/api/v1/assets/:id` | Phục vụ/biến đổi hình ảnh (tham số query bên dưới) |
| `POST` | `/api/v1/media/:key` | Upload bytes media thô (RBAC `media:create`; bảo vệ upload áp dụng) |
| `GET` | `/api/v1/media/:key` | Tải về media (phục vụ dạng `attachment` + `nosniff`); kèm tham số biến đổi → 302 tới file biến đổi |
| `DELETE` | `/api/v1/media/:key` | Xóa media object |
| `GET` | `/api/v1/transform-presets` | Liệt kê các preset biến đổi hình ảnh có tên (RBAC `media:read`) |
| `POST` | `/api/v1/transform-presets` | Tạo preset `{ key, name, dsl }` (RBAC `media:create`) |
| `PATCH` | `/api/v1/transform-presets/:id` | Cập nhật preset (RBAC `media:update`) |
| `DELETE` | `/api/v1/transform-presets/:id` | Xóa preset (RBAC `media:delete`) |
| `GET` | `/api/v1/uploads/config` | Policy upload hiệu lực + danh mục kiểu file (bất kỳ thành viên nào) |
| `PUT` | `/api/v1/uploads/config` | Cập nhật danh sách cho phép / giới hạn kích thước (site admin) |

**DSL biến đổi hình ảnh (`/api/v1/media/:key` và `/api/v1/assets/:id`):**
```
?width=800&height=600&format=webp&quality=80&fit=cover&focal=0.5,0.5
?preset=thumbnail
```
Tại `/media/:key`, các tham số biến đổi được xác thực đối với `transformDslSchema` (`@lumibase/shared`; `MAX_DIM=5000`) và request chuyển hướng 302 tới URL hình ảnh runtime (CF Image Resizing / Imgproxy). Không có tham số → bytes gốc. `?preset=<key>` giải quyết một hàng `transform_presets` đã lưu cho site. Xem `.kiro/specs/image-transform-dsl`.

**Chính sách upload (`/api/v1/uploads/config`).** Được thực thi bởi bộ bảo vệ `file-upload-policy` trên mọi bề mặt upload (`POST /api/v1/files`, `PUT /api/v1/files/upload/:key`, `POST /api/v1/media/:key`): role public không thể upload; body bị giới hạn dung lượng trên độ dài byte thực tế; MIME được khai báo phải nằm trong danh sách cho phép và khớp với đuôi file; bytes thô được kiểm tra nội dung (magic bytes) và các file thực thi / SVG nội dung hoạt động bị từ chối; hình ảnh raster được quét payload script/executable chèn vào (polyglot) và bị từ chối. Danh sách cho phép + giới hạn giải quyết `per-site DB (settings key upload_policy) → env (FILE_UPLOAD_*) → default`. Xem spec tính năng `.kiro/specs/upload-file-controls/` và `docs/en/security/runtime-security-guards-plan.md` §3 để biết các đảm bảo đầy đủ.

```
GET  /api/v1/uploads/config
→ { data: { maxBytes, allowedMimeTypes[], allowedExtensions[], catalogue[] } }

PUT  /api/v1/uploads/config           # chỉ site admin
{ "maxBytes": 5242880, "allowedMimeTypes": ["image/png","image/jpeg"] }
```

### 6b. View presets (collection views + bookmarks)

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/presets/effective?collection=` | View mặc định hiệu lực (độ ưu tiên user > role-chain > global), kèm `sourceScope` |
| `GET` | `/api/v1/presets/bookmarks?collection=` | Các bookmark có tên hiển thị cho người gọi, kèm `sourceScope` |
| `GET` | `/api/v1/presets` | Liệt kê các preset (tùy chọn `?collection=`) |
| `POST` | `/api/v1/presets` | Tạo preset/bookmark; phạm vi user tự quản lý, role/global yêu cầu admin |
| `PATCH` | `/api/v1/presets/:id` | Cập nhật (được ủy quyền dựa trên phạm vi hiện tại của hàng) |
| `DELETE` | `/api/v1/presets/:id` | Xóa (user sở hữu của mình; role/global yêu cầu admin) |

Phạm vi được suy ra từ các cột sở hữu: `userId` được đặt → user, `roleId` được đặt → role, không có gì → global. Các preset role kế thừa theo chuỗi `roles.parentId`. Xem `.kiro/specs/presets-inheritance`.

### 6c. Translation memory

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/tm?source=&target=&entrySource=&limit=&offset=` | Liệt kê các mục TM (phân trang; `meta { total, limit, offset }`) |
| `POST` | `/api/v1/tm` | Upsert một mục |
| `PATCH` | `/api/v1/tm/:id` | Sửa target/quality/source (phạm vi siteId, 404 cross-tenant) |
| `DELETE` | `/api/v1/tm/:id` | Xóa một mục (phạm vi siteId) |
| `POST` | `/api/v1/tm/lookup` | Trực quan khớp mờ tốt nhất `{ query, sourceLang, targetLang, threshold? }` → `{ match }` |
| `POST` | `/api/v1/tm/translate` | Pipeline dịch máy `{ text, from, to }` (TM → thuật ngữ → nhà cung cấp) |

`TM_DEFAULT_THRESHOLD = 75` (`@lumibase/shared`). Học-TM (Studio) upsert các bản dịch người dùng khi lưu nếu `translations.learnTm` được bật. Xem `.kiro/specs/translation-memory-ui`.

---

## 7. Flows / Automation

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/flows/operations` | Các key thao tác đã đăng ký + gợi ý tùy chọn (editor palette / `validateGraph` knownKeys) |
| `GET` | `/api/v1/flows` | Liệt kê các flow (lọc theo `status`, `trigger`) |
| `POST` | `/api/v1/flows` | Tạo flow mới (xác thực đồ thị khi `active`; flow lịch trình yêu cầu cron hợp lệ) |
| `GET` | `/api/v1/flows/:id` | Lấy chi tiết flow + đồ thị |
| `PATCH` | `/api/v1/flows/:id` | Cập nhật flow (đồ thị, trạng thái, tùy chọn) |
| `DELETE` | `/api/v1/flows/:id` | Xóa flow |
| `POST` | `/api/v1/flows/:id/run` | Kích hoạt thủ công với body làm đầu vào |
| `POST` | `/api/v1/flows/:id/trigger` | **Webhook trigger** — không có phiên CMS; xác thực bằng token theo flow (`x-flow-token` header hoặc `Bearer`), so sánh thời gian hằng số. Input = `{ body, headers, query }` (header chứng thư bị loại bỏ). 404 cho non-webhook/inactive flows; 401 `WEBHOOK_NOT_CONFIGURED`/`UNAUTHENTICATED` |
| `GET` | `/api/v1/flows/:id/runs` | Lịch sử thực thi |
| `GET` | `/api/v1/flows/:id/runs/:runId` | Chi tiết một lần chạy (kết quả các bước) |

**Cổng kiểm tra khi lưu:** một flow `active` phải vượt qua xác thực đồ thị dùng chung — nếu không sẽ trả về `400` với `GRAPH_DANGLING_EDGE` / `GRAPH_CYCLE` / `GRAPH_NO_ENTRY` / `GRAPH_UNKNOWN_OPERATION` (+ `nodeId`); bản nháp có thể giữ công việc dở dang không hợp lệ. Các flow lịch trình xác thực `triggerOptions.cron` (5 trường, UTC): `400 CRON_INVALID` khi biểu thức sai định dạng, `400 CRON_REQUIRED` khi kích hoạt mà thiếu cron; `next_run_at` được tính khi lưu và tiến tới bởi scheduler sweep trước mỗi lần xếp hàng chạy (idempotent).

**Triggers:** các flow `event` kích hoạt khi mục được tạo/cập nhật/xóa qua hàng đợi `flow-events` (bộ lọc `triggerOptions.collection` / `.action`, chuỗi hoặc mảng, thiếu = tất cả); các flow `schedule` được quét mỗi nhịp scheduler; các flow `webhook` dùng điểm cuối ở trên; các lần chạy `manual` chạy inline qua `/run`.

**Kích hoạt một flow:**
```bash
POST /api/v1/flows/flw_abc123/run
Content-Type: application/json
Authorization: Bearer <token>

{ "userId": "usr_xyz", "action": "welcome" }
```

**Response:**
```json
{
  "data": {
    "runId": "run_def456",
    "status": "running",
    "startedAt": "2026-06-07T00:00:00Z"
  }
}
```

---

## 8. AI Copilot

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `POST` | `/api/v1/ai/chat` | Gửi câu lệnh ngôn ngữ tự nhiên tới AI Copilot |
| `GET` | `/api/v1/ai/approvals` | Liệt kê các phê duyệt HITL đang chờ |
| `POST` | `/api/v1/ai/approvals/:id/decide` | Phê duyệt hoặc từ chối một hành động đang chờ |
| `GET` | `/api/v1/ai/conversations` | Liệt kê lịch sử hội thoại |
| `GET` | `/api/v1/ai/conversations/:id/messages` | Lấy danh sách tin nhắn trong một hội thoại |
| `DELETE` | `/api/v1/ai/conversations/:id` | Xóa một hội thoại |

**Request chat:**
```json
{ "message": "Create a collection called 'products' with title, price, and status fields" }
```

**Response skill an toàn:**
```json
{
  "data": {
    "status": "executed",
    "data": { "collectionName": "products", "fieldsCreated": 3 }
  }
}
```

**Response yêu cầu HITL (skill nguy hiểm):**
```json
{
  "data": {
    "status": "pending_approval",
    "approvalId": "apr_ghi789",
    "message": "Creating a collection requires admin approval."
  }
}
```

**Quyết định phê duyệt:**
```json
{ "decision": "approved" }
```

### Agent API (Content OS)

Tất cả các tuyến được gắn dưới chuỗi đã xác thực; các role của token là tập hợp capability.

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET/POST` | `/api/v1/agent/goals` | Liệt kê / tạo goal (`execution: 'async'` xếp hàng chạy) |
| `POST` | `/api/v1/agent/goals/:id/decompose` | Planner: tạo sub-goal theo vai trò kế thừa ngân sách còn lại |
| `POST` | `/api/v1/agent/goals/:id/settle` | Giải quyết goal cha từ trạng thái kết thúc của các goal con |
| `GET/POST/PATCH/DELETE` | `/api/v1/agent/roles[/:name]` | CRUD thư viện vai trò Agent (admin) — khởi tạo sẵn với Planner, Writer, … |
| `GET` | `/api/v1/agent/autonomy` | Sổ bộ tin cậy: quyền hạn + sự cố đang mở |
| `GET/POST` | `/api/v1/agent/autonomy/promotions[...]` | Đề xuất thăng cấp; `POST :id/decide` là con đường duy nhất lên cấp cao hơn (admin) |
| `GET/POST` | `/api/v1/agent/staged[...]` | Cửa sổ veto: các bản staging đang chờ bổ sung `approvalId/collection/itemId/patch/agentRole` từ bản sửa đổi staging (trường null khi staging không còn); `POST :id/veto` loại bỏ một staging |
| `POST` | `/api/v1/agent/approvals/:id/agent-decide` | Quyết định của Agent với tư cách người đánh giá (cần `review:<domain>`; cấm tự đánh giá) |
| `GET/POST` | `/api/v1/agent/constitution[...]` | Các phiên bản, bản nháp, `/compile` (NL→đánh giá), `:id/dry-run`, `:id/activate` |
| `GET/POST` | `/api/v1/agent/kill-switch[/lift]` | Dừng ở 4 phạm vi (`run/intent/role/site`); việc đóng đóng băng cần `agents:freeze` |
| `*` | `/api/v1/agent/intents[...]` | CRUD ý định nội dung, `:id/pause|resume|scan|drifts`, `/compile` |
| `POST` | `/api/v1/mcp` | MCP server (Streamable HTTP, JSON-RPC 2.0) — được bảo vệ bởi cờ `contentOs.mcp` |
| `GET/DELETE` | `/api/v1/items/:collection/:id/pins[/:field]` | Ghim Law Zero: liệt kê / giải phóng |
| `GET` | `/api/v1/deliver/llms.txt/:site_id` | Chỉ mục llms.txt công khai mỗi site |

---

## 9. Realtime (WebSocket)

**Điểm cuối:** `wss://api.<your-site>.lumibase.dev/api/v1/realtime`

**Auth (đổi vé):** trình duyệt không thể gửi `Authorization` trong bắt tay WS, vì vậy đổi phiên lấy một vé ngắn hạn (1 phút) trước: `POST /api/v1/realtime/ticket` (studio) hoặc `POST /api/v1/realtime/audience-ticket` (người dùng cuối), sau đó kết nối:
```
wss://...realtime?ticket=<ticket>
```
Vé studio nhúng các collection mà người gọi có thể `read`; hub từ chối bất kỳ `subscribe` nào khác với `{ "type": "error", "code": "SUBSCRIBE_FORBIDDEN" }`.

**Đăng ký nhận tin collection** (tùy chọn bộ lọc kiểu Directus `filter`, được đánh giá ở phía server trên phong bì sự kiện `collection`/`action`/`itemId`):
```json
{ "type": "subscribe", "collection": "articles", "filter": { "action": { "_eq": "delete" } } }
```

**Sự kiện từ Server** — chỉ phát tín hiệu: không có dữ liệu hàng trên đường truyền (client fetch lại qua `/items`, nơi thực thi RBAC + ẩn trường):
```json
{ "type": "event", "collection": "articles", "action": "update", "itemId": "art_001", "payload": null }
```

**Khung thông báo từ Server** (tính năng push-noti) — phát tới mọi phiên làm việc của site (không giới hạn collection):
```json
{ "type": "notification", "notification": { "id": "…", "kind": "approval", "severity": "info", "title": "…", "body": "…", "deepLink": "/mission-control/inbox?entry=approval:…", "entityId": "…", "ts": "2026-06-23T01:00:00Z" } }
```

Xem [features/websockets-realtime.md](../features/websockets-realtime.md) để biết tham chiếu giao thức đầy đủ.

---

## 9b. Push notifications

Web Push (VAPID) + realtime trong ứng dụng cho các sự kiện agent. Giới hạn theo tenant; VAPID key là tài nguyên triển khai dùng chung. Xem [features/push-notifications.md](../features/push-notifications.md).

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/push/vapid-public-key` | Public key của Application-server (`404 PUSH_NOT_CONFIGURED` khi chưa đặt). Cùng một key cho mọi tenant. |
| `GET` | `/api/v1/push/status` | `{ vapidConfigured, realtimeAvailable, subscriptions }` cho site đang hoạt động. |
| `POST` | `/api/v1/push/test` | Gửi một thông báo `test` tới site đang hoạt động (cả hai phương thức truyền tải). |
| `POST` | `/api/v1/push/subscriptions` | Upsert một đăng ký trình duyệt: `{ endpoint, keys: { p256dh, auth } }`. |
| `DELETE` | `/api/v1/push/subscriptions` | Xóa đăng ký theo `{ endpoint }`. |

---

## 10. Settings

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/settings` | Lấy tất cả cài đặt của site |
| `PATCH` | `/api/v1/settings` | Cập nhật nhiều cài đặt |
| `GET` | `/api/v1/settings/:key` | Lấy một cài đặt theo key |
| `PUT` | `/api/v1/settings/:key` | Đặt một cài đặt |
| `POST` | `/api/v1/settings/export` | Xuất cài đặt dạng gói JSON |
| `POST` | `/api/v1/settings/apply` | Áp dụng gói cài đặt |

### Cấu hình Site

Định danh, thương hiệu và giao diện mặc định của site đang hoạt động nằm ở hàng `sites` (không phải bảng key/value `settings`). Được giới hạn theo tenant đang hoạt động qua header `X-Lumi-Site`.

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/site` | Lấy cấu hình của site đang hoạt động |
| `PATCH` | `/api/v1/site` | Cập nhật định danh / thương hiệu / giao diện của site (một phần) |

`PATCH /api/v1/site` chấp nhận bất kỳ tập hợp con nào của: `name`, `displayTitle`, `siteUrl`, `descriptor`, `domain`, `defaultLanguage`, `defaultAppearance` (`auto`\|`light`\|`dark`), `defaultSaveAction` (`stay`\|`return`\|`create_new` — hành động lưu mặc định toàn site mà tùy chọn cá nhân người dùng có thể ghi đè), `branding` (`{ logoUrl, faviconUrl, brandColor }`), `themeOverrides` (bản đồ `{ light, dark }` của các token CSS trong danh sách cho phép → giá trị `H S% L%`), và `customCss`. Một chuỗi rỗng sẽ xóa trường có thể null. Một `domain` bị trùng trả về `409 { errors: [{ code: 'DOMAIN_TAKEN' }] }`.

Mô hình giao diện (Theme model): site giữ các mặc định toàn cục; giao diện/thương hiệu/ngôn ngữ đè của từng người dùng (được giải quyết ở phía client) được ưu tiên.

---

## 10b. Regulated / sensitive content (admin)

Tập hợp capability dạng opt-in (spec: `regulated-content-readiness`). Tất cả tuyến admin yêu cầu role `admin`; giải mã ở cấp trường yêu cầu thêm quyền `read_decrypted`. Các lần đọc trường nhạy cảm `pii`/`phi` được ghi vào `field_access_log`; thất bại giải mã sẽ fail closed (`500 DECRYPTION_FAILED`) và được audit — không bao giờ trả về placeholder.

### Mã hóa — keys & envelope mode

Key **material** chỉ nằm trong `KeyProvider` runtime (Workers Secrets / env: `ENCRYPTION_KEY_<id>` + `ENCRYPTION_ACTIVE_KEY_ID`); các bề mặt này ghi lại metadata + audit và thực hiện migration.

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET`  | `/api/v1/admin/encryption/keys` | Liệt kê metadata key đã cấu hình (id/status/algo). |
| `POST` | `/api/v1/admin/encryption/keys/rotate` | Chuyển một key đã khởi tạo lên active; cho key trước đó nghỉ. Body `{ keyId }`. Audit `encryption_key_rotated`. `422 KEY_NOT_PROVISIONED` nếu thiếu bytes. |
| `POST` | `/api/v1/admin/encryption/keys/rewrap` | Mã hóa lại ciphertext của key đã nghỉ (và mã hóa lại DEK theo từng bản ghi) lên key active. Idempotent, có thể tiếp tục, giới hạn mỗi lần gọi. |
| `GET`  | `/api/v1/admin/encryption/envelope` | Cài đặt chế độ envelope hiện tại + tiến độ migration. |
| `POST` | `/api/v1/admin/encryption/envelope` | Bật/tắt chế độ envelope (DEK theo từng bản ghi). Body `{ enabled, password }` — **xác thực nâng cao (step-up auth)** xác nhận lại mật khẩu admin (`401 INVALID_CREDENTIALS` khi không khớp). Ghi `encryption.envelope`, audit `envelope_mode_changed`, xếp hàng migration chạy ngầm và xử lý một đợt inline giới hạn. |
| `POST` | `/api/v1/admin/encryption/envelope/migrate` | Xử lý thêm các đợt migration (có thể tiếp tục). Polling cho đến khi `{ done: true }`. |

### Đánh giá biên tập → xuất bản

Gắn tại `/api/v1/editorial`. Bật/tắt theo từng collection qua collection `meta.editorialWorkflow`; `meta.requireSeparateReviewer` bắt buộc người đánh giá khác với tác giả. Các chuyển trạng thái audit `editorial_transition`.

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET`  | `/api/v1/editorial/reviews` | Liệt kê các yêu cầu đánh giá (lọc theo trạng thái/người được giao). |
| `POST` | `/api/v1/editorial/:collection/:id/submit-review` | Chuyển `draft → in_review`; giao cho người đánh giá. |
| `POST` | `/api/v1/editorial/:collection/:id/approve` | `in_review → approved` (→ xuất bản theo workflow). |
| `POST` | `/api/v1/editorial/:collection/:id/reject` | `in_review → rejected`. Body `{ reason }`. |

### Xóa GDPR (kiểm soát kép)

Gắn tại `/api/v1/admin/erasure`. Hủy mã hóa (bỏ DEK từng bản ghi) hoặc xóa cứng `items` + `revisions` trong khi **bảo toàn** log audit chống sửa đổi `data_erased` (không cascade). Kiểm soát kép qua cài đặt `erasureDualControl`.

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `POST` | `/api/v1/admin/erasure` | Tạo yêu cầu xóa. Body `{ collection, filter }` + lý do. Lưu hash của chủ thể, không bao giờ lưu văn bản rõ. |
| `POST` | `/api/v1/admin/erasure/:id/confirm` | Admin thứ hai xác nhận (kiểm soát kép). |
| `POST` | `/api/v1/admin/erasure/:id/execute` | Thực thi việc xóa đã xác nhận; audit `data_erased` kèm `recordCount`. |

### Field access log & Subject Access Request

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET`  | `/api/v1/admin/field-access-log` | Truy vấn audit đọc đã giải mã của các trường `pii`/`phi` (không bao giờ lưu giá trị). |
| `POST` | `/api/v1/admin/sar/export` | Yêu cầu truy cập của chủ thể: xuất các bản ghi đã giải mã + nguồn gốc của một chủ thể. Bắt buộc tạo một mục `field_access_log` (Req 13.2). |

---

## 11. Extensions

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/extensions` | Liệt kê các extension đã cài đặt |
| `POST` | `/api/v1/extensions/upload` | Upload gói extension (multipart) |
| `POST` | `/api/v1/extensions/:id/enable` | Bật extension |
| `POST` | `/api/v1/extensions/:id/disable` | Tắt extension |
| `POST` | `/api/v1/extensions/:id/capabilities` | Cấp các capability |
| `GET` | `/api/v1/extensions/ui/manifest` | UI manifest cho Studio import động |

**Ký tên & các extension chính thức.** Mọi đường dẫn cài đặt/tải (marketplace install, CRUD chung `POST /extensions`, điểm cuối gắn động, và điều phối hook) đều định tuyến qua một trình xác minh dùng chung. Chữ ký Ed25519 đính kèm được kiểm tra đối chiếu với key nhà xuất bản từ `MARKETPLACE_PUBLIC_KEYS` (env) gộp với bảng `lumibase_publisher_keys` (**DB ghi đè env** cho `official`/`revoked`). `isOfficial` được suy ra ở phía server (tên trong namespace `lumibase-` **và** chữ ký bởi key chính thức) — không bao giờ lấy từ khai báo manifest. Các extension chính thức hoạt động theo chế độ **fail-closed**: gói không thể xác minh sẽ không bao giờ tải. Việc thực thi phía thứ ba tuân theo `LUMIBASE_EXT_SIGNATURE_POLICY` (mặc định `require`, hoặc `warn`). Namespace `lumibase-` được bảo lưu: cộng đồng `/marketplace/submit` sẽ từ chối nó, và các extension chính thức có `autoInstall`/`enabledByDefault` sẽ được cài đặt trong quá trình setup / khi tạo site bởi reconciler. Ký gói với `@lumibase/extension-cli` (`lumibase-ext keygen|sign|verify`).

---

## 11a. Pageviews (visitor counting)

Beacon công khai + đọc đã xác thực cho module pageview tích hợp sẵn. Cấu hình theo từng site nằm trong key cài đặt `pageviews` (`scope: 'module'`): `strategy` (mặc định `db-rollup` | `hot-counter` | `cdc` | `hll`), `userTable`, `respectConsent`, `botFilter`, `hashSalt`, `flushIntervalS`. Các lượt xem đã xác thực được gán cho người dùng chỉ khi có chấp thuận `analytics`; lượt xem ẩn danh dùng hash salted (không bao giờ dùng IP thô). Các bộ đếm xả vào `lumibase_pageview_daily` mỗi 5 phút.

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `POST` | `/api/v1/pageviews/:site_id/hit` | Beacon công khai; được lọc bot/DNT/GPC, giới hạn tốc độ; trả về `204` |
| `GET` | `/api/v1/pageviews/stats?from=&to=&path=` | Số lượt xem/lượt xem duy nhất hằng ngày đã xác thực trong một khoảng |

---

## 11b. Email (templates, layouts, send)

Phạm vi site-admin (`requireSiteAdmin`). Được hỗ trợ bởi EmailService dùng chung (SMTP / MailChannels) + kho lưu trữ template/layout theo từng site. Hướng dẫn đầy đủ: `docs/en/features/email-service.md`.

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/email/capabilities` | Tính khả dụng của phương thức truyền tải + `from` mặc định |
| `GET` | `/api/v1/email/layouts` | Liệt kê các layout |
| `POST` | `/api/v1/email/layouts` | Tạo layout (vỏ HTML với `{{content}}`) |
| `PATCH` | `/api/v1/email/layouts/:id` | Cập nhật layout |
| `DELETE` | `/api/v1/email/layouts/:id` | Xóa layout |
| `GET` | `/api/v1/email/templates` | Liệt kê các template |
| `POST` | `/api/v1/email/templates` | Tạo template |
| `PATCH` | `/api/v1/email/templates/:id` | Cập nhật template |
| `DELETE` | `/api/v1/email/templates/:id` | Xóa template |
| `POST` | `/api/v1/email/templates/:key/preview` | Xem trước mà không gửi |
| `POST` | `/api/v1/email/send` | Render (nếu có `templateKey`) + gửi — điểm truy cập extension |
| `POST` | `/api/v1/email/test` | Gửi một email thử nghiệm đơn lẻ |

Body `POST /api/v1/email/send`: `{ to[], cc?, replyTo?, variables?, ` và chính xác một trong `templateKey` hoặc `inline: { subject, html?, text? }` `}`. Trả về `502 DELIVERY_FAILED`, `404 NOT_FOUND` (template), hoặc `503 EMAIL_NOT_CONFIGURED` (chế độ suy giảm).

---

## 12. Firebase Sync

Đồng bộ nội dung (`items`) sang mục tiêu Firebase — Cloud Firestore hoặc Realtime Database — theo thời gian thực. Tất cả điểm cuối yêu cầu **quyền admin trong phạm vi site**. Chứng thư Firebase là **write-only** (cung cấp khi tạo/cập nhật, được mã hóa khi lưu bằng `ENCRYPTION_KEY`, không bao giờ trả về). Xem [features/firebase-sync.md](../features/firebase-sync.md).

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/firebase-sync/pipelines` | Liệt kê các pipeline đồng bộ của site đang hoạt động |
| `POST` | `/api/v1/firebase-sync/pipelines` | Tạo một pipeline |
| `GET` | `/api/v1/firebase-sync/pipelines/:id` | Chi tiết pipeline (bỏ qua chứng thư) |
| `PATCH` | `/api/v1/firebase-sync/pipelines/:id` | Cập nhật cấu hình / xoay vòng chứng thư |
| `DELETE` | `/api/v1/firebase-sync/pipelines/:id` | Xóa pipeline (xóa nối tiếp log của nó) |
| `GET` | `/api/v1/firebase-sync/pipelines/:id/log` | Các lần thử đồng bộ gần đây |
| `POST` | `/api/v1/firebase-sync/pipelines/:id/backfill` | Đẩy tất cả các mục khớp sang Firebase ngay lập tức |

**Tạo một pipeline (Firestore):**
```bash
POST /api/v1/firebase-sync/pipelines
Content-Type: application/json
Authorization: Bearer <token>
X-Lumi-Site: <siteId>

{
  "name": "blog-to-firestore",
  "target": "firestore",
  "projectId": "my-firebase-project",
  "credentials": {
    "project_id": "my-firebase-project",
    "client_email": "svc@my-firebase-project.iam.gserviceaccount.com",
    "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
  },
  "collections": ["articles", "authors"],
  "targetPath": "content/{collection}",
  "syncOnCreate": true,
  "syncOnUpdate": true,
  "syncOnDelete": true
}
```

Với `target: "rtdb"`, `credentials` là `{ "databaseUrl": "https://<project>.firebaseio.com", "secret": "<rtdb-secret>" }`.

**Response (201):**
```json
{
  "data": {
    "id": "V1StGXR8_Z5jdHi6B-myT",
    "name": "blog-to-firestore",
    "target": "firestore",
    "status": "active",
    "projectId": "my-firebase-project",
    "collections": ["articles", "authors"],
    "targetPath": "content/{collection}",
    "syncOnCreate": true,
    "syncOnUpdate": true,
    "syncOnDelete": true,
    "lastSyncAt": null,
    "lastSyncItemCount": null,
    "createdAt": "2026-06-17T00:00:00Z",
    "updatedAt": "2026-06-17T00:00:00Z"
  }
}
```

**Response Backfill:**
```json
{ "data": { "scanned": 120, "pushed": 118, "failed": 2, "truncated": false } }
```

Mã lỗi riêng cho phần này: `ENCRYPTION_KEY_REQUIRED` (400 — `ENCRYPTION_KEY` chưa được cấu hình, không thể mã hóa chứng thư), `VALIDATION_ERROR` (400 — cấu trúc body / chứng thư không khớp với `target` được chọn).

---

## 12a. Translation Memory

Bản dịch có thể tái sử dụng cung cấp dữ liệu cho pipeline MT (TM → thuật ngữ → nhà cung cấp).

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/tm` | Liệt kê các mục; bộ lọc `?source=&target=&entrySource=`; phân trang `?limit=&offset=` → `{ data, meta: { total, limit, offset } }` |
| `POST` | `/api/v1/tm` | Upsert một mục TM |
| `PATCH` | `/api/v1/tm/:id` | Cập nhật `targetText`/`quality`/`context`/`source` |
| `DELETE` | `/api/v1/tm/:id` | Xóa một mục |
| `POST` | `/api/v1/tm/lookup` | Khớp mờ (ngưỡng mặc định 75, dùng chung `TM_DEFAULT_THRESHOLD`) |
| `POST` | `/api/v1/tm/translate` | Pipeline đầy đủ (TM → thuật ngữ → nhà cung cấp MT) |

---

## 12b. Insights (Dashboards)

Dashboard do người dùng xây dựng gồm các panel tổng hợp trên các collection. Truy vấn panel được thực thi an toàn: mọi trường được tham chiếu phải nằm trong danh sách trắng trường của collection và truy vấn được giới hạn trong site đang hoạt động — không có đầu vào người dùng nào tới định danh SQL.

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/dashboards` | Liệt kê các dashboard |
| `POST` | `/api/v1/dashboards` | Tạo dashboard `{ name, icon?, color?, note? }` |
| `GET` | `/api/v1/dashboards/:id` | Lấy chi tiết dashboard |
| `PATCH` | `/api/v1/dashboards/:id` | Cập nhật dashboard |
| `DELETE` | `/api/v1/dashboards/:id` | Xóa dashboard |
| `GET` | `/api/v1/dashboards/:id/panels` | Liệt kê các panel |
| `POST` | `/api/v1/dashboards/:id/panels` | Tạo panel `{ name, type, position, query }` |
| `PATCH` | `/api/v1/dashboards/:id/panels/:panelId` | Cập nhật panel (bao gồm `position` cho layout) |
| `DELETE` | `/api/v1/dashboards/:id/panels/:panelId` | Xóa panel |
| `POST` | `/api/v1/dashboards/:id/panels/:panelId/data` | Chạy panel → `{ data, meta: { executedAt, rowCount, durationMs } }` |
| `POST` | `/api/v1/dashboards/:id/panels/preview` | Chạy thử `PanelQuery` (xem trước trong trình chỉnh sửa) |

`PanelQuery` (hợp đồng dùng chung `@lumibase/shared`): `{ collection, aggregate (count|sum|avg|min|max), field?, groupBy?, filter? (quy tắc điều kiện), dateRange?, limit? }`. `field` is required for non-`count` aggregates. Trường nằm ngoài danh sách trắng của collection sẽ trả về `400 { errors: [{ code: 'INVALID_FIELD' }] }`.

---

## 12c. Git Integration (GitHub / GitLab)

Kết nối theo từng site tới các kho lưu trữ mã nguồn: theo dõi pull request + CI, xem/lưu log CI, gửi lại trạng thái xác thực nội dung, giải quyết các ý định khai báo (GitOps), và chạy các môi trường xem trước tự động. Các tuyến đã xác thực yêu cầu admin của site và `ENCRYPTION_KEY` (token được lưu mã hóa, không bao giờ trả về).

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/integrations/git` | Liệt kê các tích hợp cho site |
| `POST` | `/api/v1/integrations/git` | Tạo `{ provider (github\|gitlab), repoFullName, displayName, authMethod (app\|pat), token?, installationId? }` → 409 khi trùng `(provider, repo)` |
| `GET` | `/api/v1/integrations/git/:id` | Lấy chi tiết một tích hợp |
| `PATCH` | `/api/v1/integrations/git/:id` | Cập nhật tên hiển thị / token / trạng thái / cấu hình đồng bộ |
| `DELETE` | `/api/v1/integrations/git/:id` | Ngắt kết nối (quên token) |
| `POST` | `/api/v1/integrations/git/:id/rotate-secret` | Xoay vòng secret của webhook |
| `GET` | `/api/v1/integrations/git/:id/oauth/authorize` | Trả về `{ authorizeUrl }` (trạng thái cache dùng một lần) |
| `GET` | `/api/v1/integrations/git/:id/pull-requests` | Liệt kê các PR đã cache |
| `POST` | `/api/v1/integrations/git/:id/pull-requests/refresh` | Tải các PR trực tiếp từ nhà cung cấp (upsert cache) |
| `GET` | `/api/v1/integrations/git/:id/pull-requests/:number/ci` | Các lượt chạy CI cho tích hợp |
| `POST` | `/api/v1/integrations/git/:id/pull-requests/:number/validate` | Xác thực cấu hình + gửi trạng thái commit `lumibase/content-validation` |
| `GET` | `/api/v1/integrations/git/:id/ci-runs/:runId/logs` | Tải + cache log CI (lưu trữ blob) |
| `POST` | `/api/v1/integrations/git/:id/gitops/sync` | Đối soát `lumibase/intents.json` vào các ý định nội dung (+ quét/đối soát sai lệch) |
| `GET` | `/api/v1/integrations/git/:id/provenance` | Nguồn gốc `?collection=&itemId=` — commit/PR nào đã thay đổi một mục |

Public (không có phiên làm việc; xác minh chữ ký hoặc trạng thái dùng một lần):

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/integrations/git/oauth/:provider/callback` | Mã OAuth → trao đổi token (gắn với trạng thái cache) |
| `POST` | `/api/v1/integrations/git/webhook/:provider/:siteId/:integrationId` | Bộ nhận webhook — GitHub HMAC-SHA256 (`X-Hub-Signature-256`) / GitLab token (`X-Gitlab-Token`); idempotent theo delivery id |

Môi trường xem trước là opt-in cho từng tích hợp (`sync_config.preview = true`): khi PR mở/đồng bộ, LumiBase khởi tạo một site tạm thời (`${siteId}__pr-${number}`) được phục vụ tại `/api/v1/deliver/page/${ephemeralSiteId}/...`; khi đóng/gộp PR nó sẽ bị hủy. Thất bại CI ghi lại một `agent_incident` (role `git-sync`) + một mục audit `git_ci_failed`.

---

## 13. Delivery (Public)

Không cần header `Authorization`. Quyền được áp dụng qua role `public`.

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/deliver/page/:slug` | Cung cấp dữ liệu trang trong 1 roundtrip |
| `GET` | `/api/v1/deliver/items/:collection` | Danh sách mục công khai |
| `GET` | `/api/v1/deliver/menu/:key` | Cấu hình menu |

**HTTP caching** (`GET /deliver/page/:site_id/:slug`): các phản hồi không có chứng thư có thể chia sẻ cache để bất kỳ CDN/proxy nào cũng có thể hấp thụ các lượt đọc lặp lại.

| Request | Response headers |
|---------|------------------|
| Không có chứng thư (mặc định) | `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` · `ETag: W/"…"` · `Vary: X-Lumi-Site` |
| Có header `Authorization` | `Cache-Control: private, no-store` (không có `ETag` dùng chung) |
| Không tìm thấy trang | `404` + `Cache-Control: no-store` |
| Định dạng identifier không hợp lệ (`site_id` / `slug`) | `404` + `Cache-Control: no-store` (body giống hệt với trang không tìm thấy thật — không phải `400`) |
| IP client vượt quá `LUMIBASE_DELIVER_RATE_LIMIT` | `429` + `Retry-After` + `Cache-Control: no-store` |

Conditional requests: gửi `If-None-Match` kèm theo `ETag` mới nhất; nếu khớp sẽ trả về `304 Not Modified` với body rỗng và bỏ qua hoàn toàn việc lấy dữ liệu các section. ETag là dấu vân tay nội dung cấp site — bất kỳ thao tác ghi item nào (hoặc việc xuất bản/hủy xuất bản theo lịch có hiệu lực) đều làm xoay vòng nó, vì vậy 304 cũ không bao giờ được phục vụ đổi lại tỷ lệ revalidation thấp hơn.

Các biến có thể điều chỉnh (env): `LUMIBASE_DELIVER_SMAXAGE` (giây, mặc định `60`, `0` tắt shared cache), `LUMIBASE_DELIVER_SWR` (giây, mặc định `300`), `LUMIBASE_NEGATIVE_CACHE_TTL` (giây, mặc định `30`, `0` tắt tombstone), `LUMIBASE_DELIVER_RATE_LIMIT` (request/phút/IP, mặc định `1200`, `0` tắt). Xem [Caching — penetration](../features/caching.md).

---

## 14. Utility endpoints

| Phương thức | Đường dẫn | Mô tả |
|--------|------|-------------|
| `GET` | `/api/v1/utils/health` | Kiểm tra sức khỏe (DB, cache, storage, search, queue) |
| `GET` | `/api/v1/utils/version` | Thông tin phiên bản API |
| `POST` | `/api/v1/utils/render-template` | Render một display template phía server |
| `POST` | `/api/v1/utils/jsonata/test` | Đánh giá biểu thức JSONata |
| `GET` | `/api/v1/metrics` | Prometheus metrics (chỉ ở chế độ Docker) |

**Phản hồi sức khỏe (Health response):**
```json
{
  "data": {
    "status": "healthy",
    "checks": {
      "database": "ok",
      "cache": "ok",
      "storage": "ok",
      "search": "ok",
      "queue": "ok"
    },
    "version": "1.0.0",
    "runtime": "cloudflare"
  }
}
```

---

## 15. Rate limits

| Phạm vi | Giới hạn |
|-------|-------|
| Các điểm cuối Auth | 30 req/phút mỗi IP |
| Ghi Items | 600 req/phút mỗi người dùng |
| Đọc Items | 6,000 req/phút mỗi người dùng |
| Upload File | 100 req/phút mỗi người dùng |
| Kết nối Realtime | 50 đồng thời mỗi site |
| AI Chat | 60 req/phút mỗi người dùng |

Header rate limit:
```
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 598
X-RateLimit-Reset: 1749254460
```

---

## 16. Versioning

Các thay đổi có tính breaking change sẽ có tiền tố đường dẫn mới (`/api/v2`). Phiên bản trước đó được duy trì trong ít nhất 12 tháng.

Gửi `X-Lumi-API-Version: 1` để ghim tới một phiên bản API cụ thể. Mặc định là bản ổn định mới nhất.


## Change Feed (`/api/v1/cdc` — spec cdc-extension-integration)

Được gắn trên ứng dụng `api` đã xác thực TRƯỚC router control-plane ClickHouse CDC. Token thuộc realm frontend bị từ chối ở mọi tuyến (ADR-011).

| Phương thức | Đường dẫn | Bảo vệ (Guard) | Mô tả |
|---|---|---|---|
| GET | `/cdc/events` | capability `cdc:subscribe` (admin mặc định có) | Sự kiện thay đổi được phân trang theo keyset. Query: `cursor`, `collections` (CSV), `operations` (CSV), `limit` (≤500), `wait` (giây long-poll ≤25 — giữ lượt đọc đầu tiên rỗng cho đến khi có sự kiện). Trả về `{ data, meta: { nextCursor, hasMore } }`. Phong bì `type` là `<resource>.<operation>` (`items.*` nội dung, `collections.*`/`fields.*` schema). 400 cursor sai định dạng; 410 `CURSOR_EXPIRED` + `earliestCursor` vượt quá thời gian lưu trữ. |
| GET/POST | `/cdc/subscriptions` | site admin | Liệt kê (với độ trễ từng đăng ký) / tạo (tối đa 50 mỗi site → 403; trùng tên → 409; `kind=webhook` yêu cầu một webhook **có secret** → 400). |
| GET/PATCH/DELETE | `/cdc/subscriptions/:id` | site admin | Chi tiết / cập nhật bộ lọc + tạm dừng/tiếp tục (chuyển trạng thái không hợp lệ → 409) / xóa (có audit). |
| POST | `/cdc/subscriptions/:id/ack` | capability `cdc:subscribe` | Commit một checkpoint pull. Chỉ tiến lên — lùi lại → 409 `ACK_REGRESSION`. |
| POST | `/cdc/subscriptions/:id/replay` | site admin | Tua lại trong phạm vi thời gian lưu trữ (`{cursor}` xor `{occurred_after}`); đặt lại chết/cũ → active. Được audit. |
| POST | `/cdc/subscriptions/:id/dispatch` | site admin | Điều phối theo yêu cầu (dự phòng khi không có hàng đợi). 202. |
| GET | `/cdc/subscriptions/:id/deliveries` | site admin | Lịch sử thử giao hàng, mới nhất trước (`limit`, `page`; `meta.total`). |

Giao hàng Webhook được ký: `X-LumiBase-Signature: t=<unix>,v1=<hmac_sha256_hex>` trên `` `${t}.${rawBody}` `` — xem `docs/en/features/cdc-change-feed.md` để biết đoạn code xác minh và tham chiếu phong bì.
