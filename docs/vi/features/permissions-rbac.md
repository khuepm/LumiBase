# Permissions, Roles & Policies

> Mục tiêu: hệ phân quyền **mạnh nhất** trong nhóm OSS headless CMS. Hỗ trợ field-level, row-level, time-bound, IP-bound, attribute-based và composable policies.

## 1. Mô hình

```
User ──┬─► UserPolicy (direct attach, override)
       └─► UserSite (role per site)
Role ──► RolePolicy (priority) ──► Policy ──► Permission[] per (collection, action)
```

- **Role**: tập hợp cố định gán cho user (per site).
- **Policy**: đơn vị có thể tái sử dụng, gắn vào nhiều role/user, có thứ tự ưu tiên (`priority` thấp = chạy trước, sau cao override).
- **Permission**: rule cụ thể `(collection, action)` với `permissions`, `validation`, `presets`, `fields`.

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

## 6. Composition & precedence

- Hợp nhất nhiều permission cùng `(collection, action)`:
  - `fields`: union (đặc biệt: nếu xuất hiện blacklist, áp dụng sau union).
  - `permissions` rule: nối bằng `_or` (cấp quyền cộng dồn).
  - `validation`/`presets`: merge bằng `_and` / object spread theo `priority`.
- Role `adminAccess=true` → bypass.

## 7. API

- `GET /permissions/me` — trả ma trận `{collection: { create, read, update, delete, share, fields, presets }}` để Studio render UI (ẩn nút, disable field).
- `POST /permissions/check` — debug: input action+payload, output allow/deny + reason trace.

## 8. UI Studio

- Module **Access Control**:
  - Page Roles: list + tạo + assign users + đính kèm policies.
  - Page Policies: list + JSON editor + GUI builder (form per row).
  - Page Permission Matrix: bảng grid `collection × action`, click ô để mở chi tiết (fields, rules, presets, validation).
  - Page Test sandbox: simulate user → xem field mask, allowed rows.

## 9. Caching & invalidation

- KV: `perm:{site}:{role}` (compiled). TTL 5 phút + invalidate khi policy/role thay đổi.
- WebSocket broadcast event `permissions.changed` → client studio reload `/permissions/me`.

## 10. Audit

- Mọi denial log vào `activity` với action `permission_denied` + lý do (rule path).

## 11. Tasks: Phase MVP-C, C2.
