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
User ──┬─► UserPolicy (direct attach, override)
       └─► UserSite (role per site)
Role ──► RolePolicy (priority) ──► Policy ──► Permission[] per (collection, action)
```

- **Role**: tập hợp cố định gán cho user (per site).
- **Policy**: đơn vị có thể tái sử dụng, gắn vào nhiều role/user, có thứ tự ưu tiên (`priority` thấp = chạy trước, sau cao override).
- **Permission**: rule cụ thể `(collection, action)` với `permissions`, `validation`, `presets`, `fields`.

> Ghi chú thiết kế 2026-06-03: Directus v11 đã chuyển `admin_access`, `app_access`, `enforce_tfa`, `ip_access` khỏi role và đặt trên policy. LumiBase hiện còn `roles.adminAccess/appAccess`; nên coi đây là compatibility layer và migrate về policy flags để role chỉ còn là grouping. Strategy chi tiết xem [Migration role flags sang policy flags](./role-policy-flag-migration.md).

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
- `appAccess=true` cho phép principal dùng Studio. API key không bao giờ được dùng Studio dù policy có app access.
- `enforceTfa=true` bắt buộc user đã enroll và pass 2FA trước khi policy được dùng.
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

## 7. API

- `GET /permissions/me` — trả ma trận `{collection: { create, read, update, delete, share, fields, presets }}` để Studio render UI (ẩn nút, disable field).
- `POST /permissions/check` — debug: input action+payload, output allow/deny + reason trace.

## 8. UI Studio

- Module **Access Control**:
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
