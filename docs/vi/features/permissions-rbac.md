---
version: 3
lastUpdated: 2026-07-25T07:47:22.511Z
sourceLang: vi
contentHash: 2a8277f7ae1ace80
codeVerified: 2026-07-25T07:56:30.140Z
codeVerifiedHash: 2a8277f7ae1ace80
codeVerifiedClaims: 22
---

# Permissions, Roles & Policies

> Mục tiêu: hệ phân quyền **mạnh nhất** trong nhóm OSS headless CMS. Hỗ trợ field-level, row-level, time-bound, IP-bound, attribute-based và composable policies.
>
> Xem thêm bản điều tra/blueprint chi tiết: [permission-builder-directus-investigation.md](./permission-builder-directus-investigation.md).
>
> Audit implementation hiện tại: [permission-service-compose-audit.md](./permission-service-compose-audit.md).
>
> Migration role flags sang policy flags: [role-policy-flag-migration.md](./role-policy-flag-migration.md).

## 1. Mô hình

```
Realm (staff / subscriber / public / integration)   ← biên giới xác thực
  └─ Site (tenant; mọi bảng access đều scope theo site_id)
       └─ User ──┬─► UserPolicy (direct attach, override)
                 └─► UserSite (role per site)
          Role ──► RolePolicy (priority) ──► Policy ──► Permission[] per (collection, action)
                                                          └─ fields / row rule / validation / presets
```

- **Realm**: principal đi vào qua biên giới xác thực nào. Staff và subscriber tách nhau bằng role + token audience (ADR-011); `public` là realm ẩn danh (§1.1); integration xác thực bằng API key.
- **Role**: tập hợp cố định gán cho user (per site).
- **Policy**: đơn vị có thể tái sử dụng, gắn vào nhiều role/user, có thứ tự ưu tiên (`priority` thấp = chạy trước, sau cao override).
- **Permission**: rule cụ thể `(collection, action)` với `permissions`, `validation`, `presets`, `fields`.

> Ghi chú thiết kế 2026-06-03: Directus v11 đã chuyển `admin_access`, `app_access`, `enforce_tfa`, `ip_access` khỏi role và đặt trên policy. LumiBase hiện còn `roles.adminAccess/appAccess`; nên coi đây là compatibility layer và migrate về policy flags để role chỉ còn là grouping. Strategy chi tiết xem [Migration role flags sang policy flags](./role-policy-flag-migration.md).

> `roles.parentId` có trong schema nhưng permission evaluator **không** đọc nó — **không có role inheritance**. Role con không nhận policy của role cha. Coi cột này là metadata grouping cho tới khi evaluator được thay đổi.

### 1.1. Realm ngoài staff: `public` và `subscriber`

Có hai realm least-privilege dành cho người không phải staff. Cả hai đều bắt đầu **rỗng** — không cấp gì cho tới khi operator chỉ định.

| | `public` | `subscriber` |
|---|---|---|
| Là ai | bất kỳ ai, không có credential | đã đăng ký + đăng nhập trên frontend của bạn |
| Tồn tại mặc định | ❌ opt-in theo từng site | ✅ ngay lần đăng ký đầu tiên |
| Action cấp được | chỉ `read` | `read`/`create`/`update`/`delete` |
| Row scope | published-only | published-only, own-rows-only |
| Studio | không bao giờ | không bao giờ (`appAccess: false`) |

**Resolve ẩn danh.** Khi public access được bật, request không credential sẽ resolve về role `public` của site chứ **không** bỏ qua authorization — nên row filter và field mask vẫn còn hiệu lực. Hai điều kiện gate nó, cả hai đều load-bearing:

1. site phải có role `public` (việc tạo role này *chính là* bật realm), và
2. request phải là `GET`/`HEAD` trên prefix content trong allowlist (`/items`, `/search`, `/media`, `/files`).

`/graphql` bị loại trừ có chủ đích: operation của nó đi qua POST nên quy tắc read-method không phủ được. Muốn mở cần validate operation read-only song song với cost limiter hiện có.

**Vì sao `public` chỉ đọc.** Một write grant tổng quát sẽ trao cho mọi caller ẩn danh một đường ghi không giới hạn. Bề mặt ghi công khai (form liên hệ, comment ẩn danh) cần câu chuyện throttle/captcha riêng, đặt sau một endpoint chuyên dụng — không phải một permission row.

**Guard cứng.** `adminAccess`/`appAccess` trên role và policy `public` bị ghim tắt bằng check constraint (migration `0012`) — cờ elevation ở đó sẽ là một admin bypass không cần xác thực. Route guard từ chối cùng các thao tác đó với 4xx đọc được. Policy do operator tự attach vào role `public` được screen tại điểm attach, vì table check không nhìn được qua join `role_policies`. Editor permission của policy chung cũng được screen theo giới hạn read-only, bởi grant thêm ở đó rơi vào đúng cùng một compiled bundle.

**Caching.** Các principal ẩn danh dùng chung một compiled bundle cho mỗi site (cache key `role:{id}`), và bản thân lookup role cũng được cache kèm cả kết quả âm — đường ẩn danh là đường có lưu lượng cao nhất.

**API** (`/api/v1/access/grants`, chỉ site-admin):

```
GET    /access/grants                             # collections + giới hạn & grant của cả hai realm
POST   /access/grants/public/enable               # provision realm
POST   /access/grants/public/disable              # tháo bỏ (xoá luôn mọi grant của nó)
POST   /access/grants/:realm                      # { collection, action?, publishedOnly?, ownOnly?, fields? }
DELETE /access/grants/:realm/:collection/:action
```

`publishedOnly` mặc định **bật** cho `read` và **tắt** cho write. Hai scope có thể kết hợp, compose thành `_and`. Studio hiển thị toàn bộ ở **Access control → Public & subscribers**.

`POST /users/subscriber-access` giữ nguyên contract published-only-read ban đầu khi bỏ qua `action`.

## 2. Permission record (JSON DSL)

```json
{
  "collection": "posts",
  "action": "update",
  "fields": ["title", "body", "status"],
  "permissions": {
    "_and": [
      { "user_created": { "_eq": "$CURRENT_USER" } },
      { "status": { "_neq": "archived" } },
      { "_or": [
        { "site_id": { "_eq": "$CURRENT_SITE" } },
        { "_role": { "_in": ["admin"] } }
      ]}
    ]
  },
  "validation": {
    "status": { "_in": ["draft", "review", "published"] }
  },
  "presets": { "updated_by": "$CURRENT_USER" }
}
```

### Operators hỗ trợ
- Logic: `_and`, `_or`, `_not`.
- So sánh: `_eq`, `_neq`, `_lt`, `_lte`, `_gt`, `_gte`, `_in`, `_nin`, `_contains`, `_starts_with`, `_ends_with`, `_between`.
- Date: `_dynamic` ví dụ `$NOW(-7 days)`.
- Magic: `$CURRENT_USER`, `$CURRENT_ROLE`, `$CURRENT_SITE`, `$NOW`, `$IP`, `$HEADERS.x-foo`.
- Magic mở rộng: `$CURRENT_ROLES`, `$CURRENT_POLICIES`, `$CURRENT_API_KEY`, `$CURRENT_USER.email`, `$CURRENT_USER.preferences.locale`, `$NOW(+2 hours)`, `$NOW(-7 days)`.
- Unknown magic vars fail-closed; rule dùng biến không hỗ trợ sẽ không match.

## 3. Field-level

- `fields: ["*"]` = tất cả.
- `fields: ["title","body"]` whitelist.
- `fields: ["-secret"]` blacklist (prefix `-`).
- Đối với `read`: trả về **field mask**, server **không** serialize field cấm.
- Đối với `update/create`: server reject nếu payload có field không cho phép.

## 4. Row-level

- Đánh giá `permissions` AST → SQL where (Drizzle) cho `read/list`, hoặc check post-fetch cho `update/delete` (an toàn cho update vẫn cần WHERE).
- Cache "compiled rule" theo `(policyId, action)` trong KV.

## 5. Time-bound & IP-bound

- Policy có field optional ở level `policy`:
```json
{ "activeWindow": { "from": "2025-01-01T00:00:00Z", "to": "2025-12-31T23:59:59Z" }, "allowIps": ["10.0.0.0/8"], "denyIps": [] }
```
- Đánh giá trước rules; reject sớm nếu ngoài cửa sổ.
- Nên hỗ trợ IPv4, IPv6, CIDR và IP range. `ipDeny` thắng `ipAllow`.
- Nếu policy không pass IP/time, loại policy đó khỏi chain thay vì deny toàn bộ principal.

## 5.1. App access, admin access, enforce TFA

- `adminAccess=true` là bypass toàn bộ permission checks; policy admin không cần seed permission rows.
- `appAccess=true` cho phép principal dùng Studio, không đồng nghĩa với quyền API. API-only user vẫn có thể gọi API nếu có permission rows nhưng bị chặn khỏi Studio.
- Studio client phải gửi `X-Lumi-Client: studio`; backend dùng effective `appAccess` để gate các request này.
- API key không bao giờ được dùng Studio dù policy có app access.
- `enforceTfa=true` bắt buộc user đã enroll và session đã pass 2FA trước khi Studio request được dùng.
- Không đặt các flag này trên user; user chỉ giữ identity/status/TFA enrollment.

## 6. Composition & precedence

- Hợp nhất nhiều permission cùng `(collection, action)`:
  - `fields`: union (đặc biệt: nếu xuất hiện blacklist, áp dụng sau union).
  - `permissions` rule: nối bằng `_or` (cấp quyền cộng dồn).
  - `validation`/`presets`: merge bằng `_and` / object spread theo `priority`.
- Role `adminAccess=true` → bypass.

Khuyến nghị mới: không âm thầm OR/union khi attach policy qua Studio. Backend cần conflict checker:

- Block nếu một policy grant `{}` nhưng policy khác restrict cùng collection/action.
- Block nếu một policy grant `["*"]` nhưng policy khác whitelist fields.
- Block nếu `validation` hoặc `presets` cùng field nhưng khác value.
- Warning nếu chỉ mở rộng field hoặc OR thêm rule có điều kiện; admin phải xác nhận và audit.
- DB nên có unique `(policyId, collection, action)` để một policy không có nhiều permission rows trùng key.

### 6.1. Publishable API keys

Một API key có thể được mint dưới dạng **publishable** (`lbk_pub_…`) để nhúng vào browser bundle hoặc mobile app, khác với key secret `lbk_…` giữ ở phía server.

Publishable key **không phải secret**. Bất cứ thứ gì ship xuống client đều trích xuất được, nên posture đúng duy nhất là scope nó y như thể nó đã công khai. Nó mua được gì so với việc phục vụ cùng dữ liệu đó hoàn toàn ẩn danh: quota rate-limit theo từng key (limiter đã key theo `k:{apiKeyId}`), revoke và rotate mà không cần redeploy, audit attribution, và scope theo key (staging vs production). Nó **không** mua được: confidentiality. Nếu để lộ mà thấy đau thì keep một secret key ở server và proxy qua backend của bạn.

- Prefix `lbk_pub_` là source of truth — derive từ token nên không thể lệch khỏi metadata flag, và secret scanner có thể báo động với key `lbk_` bị lộ trong khi im lặng với key publishable. Rotation giữ nguyên tính chất này.
- **Origin allowlist** — `metadata.allowedOrigins`, sửa trực tiếp qua `PATCH /api-keys/:id/allowed-origins`. Rỗng = không ràng buộc.
- Enforcement chỉ áp cho publishable key (secret key dùng server-to-server, nơi không có `Origin`). `Origin`/`Referer` không khớp → `403 ORIGIN_NOT_ALLOWED` và được audit; origin **vắng mặt** thì cho qua. Đây là chủ đích: control này chặn một *website khác* dùng key của bạn trong browser, tức đúng failure mode thực tế. Nó không phải phòng tuyến chống `curl` — thứ có thể set bất kỳ `Origin` nào — nên từ chối request thiếu origin chỉ làm hỏng caller native/server hợp lệ mà không thêm bảo mật.
- Policy có `adminAccess`/`appAccess` không thể attach vào publishable key (`PUBLISHABLE_KEY_ELEVATION`).

## 7. API

- `GET /permissions/me` — trả ma trận `{collection: { create, read, update, delete, share, fields, presets }}` để Studio render UI (ẩn nút, disable field).
- `POST /permissions/check` — debug: input action+payload, output allow/deny + reason trace.

## 8. UI Studio

- Module **Access Control**:
  - Page Public & subscribers: bật/tắt truy cập ẩn danh và tick chọn grant `collection × action` cho từng realm ngoài staff. Các giới hạn được đọc từ `GET /access/grants` thay vì hard-code phía client, nên việc siết chặt ở server không thể bị một giả định client cũ phản bác. Realm togglable đang tắt sẽ render read-only, nên cú click checkbox đầu tiên không thể âm thầm bật truy cập ẩn danh.
  - Page Roles: list + tạo + assign users + đính kèm policies.
  - Page Policies: list + JSON editor + GUI builder (form per row).
  - Page Permission Matrix: bảng grid `collection × action`, click ô để mở chi tiết (fields, rules, presets, validation).
  - Page Test sandbox: simulate user → xem field mask, allowed rows.
  - Page API Keys: tạo key, rotate/revoke, attach roles/policies, preview effective permissions.
  - Role/Key attach flow: preview conflict trước khi lưu.

## 8.1. Import / Export

- `GET /access/export` xuất roles, policies, permission rows, role-policy bindings và API key metadata dưới dạng JSON versioned.
- `POST /access/import?dryRun=true` trả diff/conflict, không ghi DB.
- Import thật chạy transaction, dùng stable keys, audit đầy đủ, không bao giờ import/export plaintext API key.

## 9. Caching & invalidation

- KV: `perm:{site}:{role}` (compiled). TTL 5 phút + invalidate khi policy/role thay đổi.
- WebSocket broadcast event `permissions.changed` → client studio reload `/permissions/me`.

## 10. Audit

- Mọi denial log vào `activity` với action `permission_denied` + lý do (rule path).

## 11. Tasks: Phase MVP-C, C2.

## 12. Compliance & quyền của người dùng

Bộ máy RBAC/audit này là nền cho một số nghĩa vụ pháp lý (access control,
provenance, phát hiện vi phạm). Về cách nó map sang quyền của chủ thể dữ liệu
và những chỗ còn thiếu, xem [Compliance — gap analysis](../compliance/gap-analysis.md).
