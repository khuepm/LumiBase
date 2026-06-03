# Permission Builder & RBAC: điều tra Directus và thiết kế cho LumiBase

> Ngày điều tra: 2026-06-03. Tài liệu này tổng hợp kết quả đọc DB Directus mẫu, đối chiếu tài liệu Directus chính thức, và đề xuất thiết kế Role / Policy / Permission / API Key cho LumiBase.

## 1. Mục tiêu

LumiBase cần một hệ Access Control tương tự Directus nhưng chặt hơn ở các điểm Directus dễ gây nhầm:

- Role gom user hoặc service account vào một ngữ cảnh quyền.
- Policy là đơn vị tái sử dụng, gắn vào role, user hoặc API key.
- Permission là quyền theo từng `collection + action`, có field-level, row-level rule, validation và presets.
- Studio phải phát hiện conflict khi một role/API key nhận nhiều policy cùng collection/action.
- Có import/export JSON để đồng bộ quyền giữa dev/staging/prod.
- Có guard bảo mật: bắt buộc 2FA, allowlist IP, static/API key an toàn, audit và dry-run.

Nguồn tham khảo chính:

- Directus DB mẫu được truy vấn trực tiếp bằng Postgres metadata và aggregate query.
- [Directus Access Control guide](https://directus.io/docs/guides/auth/access-control)
- [Directus Policies API](https://directus.io/docs/api/policies)
- [Directus Permissions API](https://directus.io/docs/api/permissions)
- [Directus Roles API](https://directus.io/docs/api/roles)
- [Directus Filter Rules / Dynamic Variables](https://docs.directus.io/reference/filter-rules)
- [Directus Authentication API](https://directus.io/docs/api/authentication)

## 1.1. Bảng so sánh LumiBase vs Directus

Đây là **comparison ledger** cho Permission Builder/RBAC. Khi thêm bất kỳ capability mới nào mà Directus chưa có first-class, phải thêm hoặc cập nhật một dòng trong bảng này để phục vụ tài liệu sản phẩm/marketing sau này.

Legend:

- **Parity**: LumiBase nên hỗ trợ tương đương Directus.
- **Improve**: LumiBase hỗ trợ cùng use case nhưng fail-closed hơn hoặc vận hành tốt hơn.
- **New**: năng lực Directus chưa có first-class; LumiBase nên đưa vào như lợi thế cạnh tranh.

| Nhóm | Directus | LumiBase mục tiêu | Trạng thái thiết kế |
|---|---|---|---|
| Role | User có một role chính; role có thể có parent/nested role. | User có primary role và nhiều role phụ qua `user_roles`; role chỉ là grouping dài hạn. | Parity + Improve |
| Policy | Policy gắn vào role hoặc user qua `directus_access`. | Policy gắn vào role, user, và API key; policy là đơn vị import/export chính. | Improve |
| Access flags | `admin_access`, `app_access`, `enforce_tfa`, `ip_access` nằm trên policy. | Giữ compatibility role flags ngắn hạn nhưng migrate về policy flags: `adminAccess`, `appAccess`, `enforceTfa`, `ipAllow`, `ipDeny`, `validFrom`, `validUntil`. | Parity + Improve |
| Permission granularity | Theo `collection + action`, có row rules, field list, validation, presets. | Tương tự, thêm source trace trong effective permission và conflict preview trước khi attach. | Improve |
| Action `share` | Có action/share link gắn role đọc dữ liệu. | Share role chuyên dụng, validity window, password hash, max uses, revoke, field/row mask qua role share. | Parity + Improve |
| Field rules | `fields` có thể whitelist hoặc `*`. | Whitelist/blacklist rõ ràng; conflict checker block `*` vs whitelist và cần hardening để giữ exclusion khi merge. | Improve |
| Dynamic variables | Hỗ trợ `$CURRENT_USER`, `$CURRENT_ROLE`, `$CURRENT_ROLES`, `$CURRENT_POLICIES`, `$NOW`, v.v. | Hỗ trợ các biến tương tự, thêm `$CURRENT_API_KEY`, nested `$CURRENT_USER.*`, `$NOW(+/- duration)` và fail-closed unknown magic var. | Parity + Improve |
| Multiple policies same collection/action | Additive merge; user đã ghi nhận có case chồng policy gây quyền sai/mở rộng. | Conflict checker backend/UI: blocking cho unconditional-vs-restricted, `*` vs whitelist, preset/validation conflict; warning cần override và audit. | Improve |
| Unique permission row trong một policy | DB mẫu Directus có duplicate permission rows cùng `policy + collection + action`. | Unique `(policy_id, collection, action)`; migration detect duplicate trước khi apply. | Improve |
| IP access | Directus dùng `ip_access` trên policy. | JSON array `ipAllow/ipDeny`, hỗ trợ IPv4/IPv6/CIDR, `ipDeny` thắng `ipAllow`, policy không pass bị loại khỏi chain. | Improve |
| App access | Policy có `app_access`; kiểm soát vào Directus App. | Enforce app access theo effective active policies; API key luôn bị chặn khỏi Studio. | Parity + Improve |
| TFA enforcement | Policy có `enforce_tfa`. | User attach role/policy TFA phải enroll/pass TFA; API key attach TFA policy bị conflict/warning. | Parity + Improve |
| Static token/API key | Directus static token nằm trên user; token kế thừa user/role. | API key là principal riêng, có thể gắn role/policy trực tiếp, token hash/prefix, rotate/revoke/expire/last_used, không export plaintext. | **New / Improve** |
| Import/export access config | Không có permission builder manifest first-class để sync roles/policies/API key metadata giữa env theo stable keys. | `lumibase.access@v1`, export/import/dry-run/diff/conflict-check, modes `merge`, `replace-managed`, `replace-all`, CLI cho CI/CD. | **New** |
| Conflict dry-run | Không có endpoint first-class cho attach policy diff/conflict. | `POST /access/conflicts/check` dùng cho UI, API, import dry-run. | **New** |
| Effective permission trace | Directus App hiển thị quyền nhưng không tập trung vào source trace cho mỗi effective cell. | `/permissions/me` trả source policies; Permission Matrix hiển thị quyền cuối cùng và nguồn. | **New / Improve** |
| System collections | Directus có system collections và permissions tương ứng. | Seed system permissions explicit, nhóm sensitive/admin-only và ẩn khỏi non-admin trong builder. | Parity + Improve |
| Extension sandbox | Directus sandboxed API extensions có requested scopes; non-sandboxed extensions là trust boundary khác. | Capability grant là upper bound trong sandbox runtime, có audit grant/revoke. | Parity + Improve |
| Extension access per user/role | Directus chưa có first-class policy để "role/user X được thấy/gọi extension Y"; app module thường tự check hoặc dựa vào admin/permissions store. | Extension Access Control first-class: `extensions:read/execute/configure/install/enable/grant_capability/delete`, áp vào Studio loader, module bar, endpoint dispatch, operations. | **New** |
| Extension data permission | Directus services dùng `accountability`; bỏ/null accountability có thể chạy admin. | Extension mặc định thao tác data theo actor permission; service-account mode phải khai báo capability/policy riêng và audit. | Improve |
| Audit | Directus có activity/audit nền. | Audit bắt buộc cho access import, conflict override, API key lifecycle, extension capability grant, service-account execution, deny quan trọng. | Improve |

## 2. Directus lưu gì trong DB

Instance Directus mẫu có 26 bảng `directus_*`:

```txt
directus_access
directus_activity
directus_collections
directus_comments
directus_dashboards
directus_extensions
directus_fields
directus_files
directus_flows
directus_folders
directus_migrations
directus_notifications
directus_operations
directus_panels
directus_permissions
directus_policies
directus_presets
directus_relations
directus_revisions
directus_roles
directus_sessions
directus_settings
directus_shares
directus_translations
directus_users
directus_versions
```

Các bảng trọng tâm:

| Bảng | Vai trò | Cột quan trọng |
|---|---|---|
| `directus_roles` | Nhóm tổ chức user. Directus v11 không còn giữ `admin_access/app_access` ở role. | `id`, `name`, `icon`, `description`, `parent` |
| `directus_policies` | Đơn vị quyền có thể attach vào role hoặc user. | `id`, `name`, `icon`, `description`, `ip_access`, `enforce_tfa`, `admin_access`, `app_access` |
| `directus_access` | Junction policy-to-role hoặc policy-to-user. | `id`, `role`, `user`, `policy`, `sort` |
| `directus_permissions` | Rule theo collection/action. | `id`, `collection`, `action`, `permissions`, `validation`, `presets`, `fields`, `policy` |
| `directus_users` | Tài khoản đăng nhập và static token. | `id`, `email`, `password`, `tfa_secret`, `status`, `role`, `token` |
| `directus_shares` | Share link theo item. | `collection`, `item`, `role`, `password`, `date_start`, `date_end`, `times_used`, `max_uses` |

Quan hệ chính:

- `directus_users.role -> directus_roles.id`: mỗi user có một role trực tiếp.
- `directus_roles.parent -> directus_roles.id`: Directus hỗ trợ role lồng nhau; DB mẫu chưa dùng role con.
- `directus_access.policy -> directus_policies.id`.
- `directus_access.role -> directus_roles.id`, nullable.
- `directus_access.user -> directus_users.id`, nullable.
- `directus_permissions.policy -> directus_policies.id`.
- `directus_shares.role -> directus_roles.id`: share link kế thừa quyền read của role được chọn.

Điểm quan trọng: Directus v11 chuyển `admin_access`, `app_access`, `enforce_tfa`, `ip_access` từ role sang policy. Tài liệu breaking changes của Directus cũng mô tả quyền user là aggregate của policies gắn trực tiếp, policies gắn qua role, và policies từ nested roles.

## 3. Số liệu từ DB Directus mẫu

| Metric | Kết quả |
|---|---:|
| `directus_roles` | 24 |
| `directus_policies` | 33 |
| `directus_access` | 50 |
| `directus_permissions` | 2414 |
| `directus_users` | 57 |
| Users có role trực tiếp | 51 |
| Users có static token | 9 |
| Users có `tfa_secret` | 11 |
| Policies `admin_access=true` | 2 |
| Policies `app_access=true` | 25 |
| Policies `enforce_tfa=true` | 0 |
| Policies có `ip_access` | 0 |

Phân bố action trong `directus_permissions`:

| Action | Rows |
|---|---:|
| `create` | 491 |
| `read` | 947 |
| `update` | 499 |
| `delete` | 348 |
| `share` | 129 |

Field-level trong DB Directus:

- `fields='*'`: 2346 rows.
- `fields` cụ thể: 64 rows.
- `fields` là text CSV trong DB mẫu, ví dụ `id,first_name,last_name,email,...`.
- `permissions` có row-level filter: 432 rows.
- `validation` có rule: 58 rows.
- `presets` có default: 66 rows.

Ví dụ rule Directus đang dùng:

```json
{ "user_created": { "_eq": "$CURRENT_USER" } }
```

```json
{
  "_or": [
    { "user": { "_eq": "$CURRENT_USER" } },
    {
      "_and": [
        { "user": { "_null": true } },
        { "role": { "_eq": "$CURRENT_ROLE" } }
      ]
    },
    {
      "_and": [
        { "user": { "_null": true } },
        { "role": { "_null": true } }
      ]
    }
  ]
}
```

Directus hỗ trợ dynamic variables:

- `$CURRENT_USER`
- `$CURRENT_ROLE`
- `$CURRENT_ROLES`
- `$CURRENT_POLICIES`
- `$NOW`
- `$NOW(-1 year)`, `$NOW(+2 hours)`
- Trong permissions/validation/presets/conditional fields, Directus còn cho nested user/role variables như `$CURRENT_USER.avatar.filesize` hoặc `$CURRENT_ROLE.name`.

## 4. Share trong Directus là gì

Directus dùng CRUDS thay vì CRUD: `create`, `read`, `update`, `delete`, `share`.

`share` không phải là quyền đọc dữ liệu trực tiếp. Nó là quyền tạo/quản lý share link cho một item. Link được lưu ở `directus_shares` với:

- `collection`
- `item`
- `role`
- `password`
- `date_start`
- `date_end`
- `times_used`
- `max_uses`

Khi người ngoài mở share link, Directus dùng role gắn với share để xác định read permissions của item đó. Vì vậy `share` phải được hiểu là quyền tạo cổng truy cập tạm thời, còn dữ liệu được trả về vẫn phải đi qua permission của role share.

Đề xuất cho LumiBase:

- Giữ action `share`.
- Thêm bảng `shares` khi triển khai tính năng này: `site_id`, `collection`, `item_id`, `role_id`, `created_by`, `password_hash`, `valid_from`, `valid_until`, `max_uses`, `used_count`, `revoked_at`.
- Share role phải là role chuyên dụng, không dùng role admin/editor thật.
- UI chỉ cho chọn role có `appAccess=false`, `adminAccess=false`, và chỉ có read permissions tối thiểu.

## 5. Bài học quan trọng từ Directus

### 5.1. Đặt `app_access/admin_access/enforce_tfa/ip_access` ở policy tốt hơn ở user hoặc role

Directus v11 đặt các flag này ở policy, không đặt ở role. Đây là hướng đúng hơn cho LumiBase:

- Policy là đơn vị deploy/import/export được.
- Role chỉ là nhóm tổ chức.
- API key cũng có thể nhận cùng policy như user.
- User chỉ nên giữ trạng thái định danh: `status`, `tfa`, profile, external id.
- Nếu đặt `adminAccess` trên user, quyền sẽ khó audit, khó sync môi trường, và dễ tạo ngoại lệ không thấy trong Permission Builder.

Hiện LumiBase đang có `roles.adminAccess` và `roles.appAccess`. Nên migrate dần:

1. Thêm flags explicit vào `policies`: `adminAccess`, `appAccess`, `enforceTfa`, `ipAllow`, `ipDeny`, `validFrom`, `validUntil`.
2. Giữ `roles.adminAccess/appAccess` tạm thời để tương thích API cũ, nhưng coi là deprecated.
3. Khi compile quyền, effective access lấy từ active policies trước; role flags chỉ là fallback trong một migration window. Strategy chi tiết: [Migration role flags sang policy flags](./role-policy-flag-migration.md).
4. Studio Role Detail không nên sửa trực tiếp `adminAccess/appAccess` trên role nữa; thay vào đó tạo/attach policy tương ứng.

### 5.2. Admin access là bypass, không phải tập permission rows

Trong DB mẫu, policy `admin_access=true` có 0 permission rows. Đây là pattern nên giữ:

- `adminAccess=true`: bypass toàn bộ permission checks trong site/project.
- Không cần seed hàng trăm permission rows cho admin.
- UI phải khóa permission editor khi policy là admin bypass để tránh hiểu nhầm.

### 5.3. Directus merge nhiều policy theo hướng additive

Tài liệu Directus nói nhiều policy trên cùng collection/action được cộng dồn:

- Fields: union.
- Item rules: OR.
- IP access: policy nào không pass IP thì bị loại khỏi chain.

Điều này mạnh nhưng nguy hiểm: thêm một policy có rule rộng hơn có thể mở dữ liệu im lặng. DB mẫu cũng có rất nhiều overlap:

- Có duplicate permission rows cùng `policy + collection + action`.
- Có role nhận nhiều policy cùng `collection + action`.
- Có role mẫu nhận 4 policies cùng quyền `directus_translations/read`.

Người dùng đã ghi nhận Directus có case add chồng policy cùng collection nhưng khác quyền làm quyền hoạt động sai, thậm chí mở quá rộng. LumiBase không nên lặp lại trải nghiệm này.

## 6. Thiết kế đề xuất cho LumiBase

### 6.1. Mô hình khái niệm

```txt
Principal
  ├─ User
  ├─ API Key
  └─ Public/Anonymous

User ──► UserRole[] ──► Role ──► RolePolicy[] ──► Policy ──► Permission[]
API Key ──────────────► ApiKeyRole[] ─┘
User ──► UserPolicy[] ───────────────────────────────┘
API Key ──► ApiKeyPolicy[] ───────────────────────────┘
Public ──► Public Policy
```

LumiBase hiện có `user_sites.role_id`, tức một primary role per site. Có hai hướng:

- Directus-compatible MVP: giữ một role trực tiếp qua `user_sites.role_id`, policy gắn vào role hoặc gắn trực tiếp user.
- LumiBase nâng cấp: thêm `user_roles(user_id, site_id, role_id)` để user có nhiều role. `user_sites.role_id` giữ làm primary/display role trong giai đoạn chuyển đổi.

Vì user yêu cầu API Keys có thể gắn trực tiếp tới roles, nên nên thiết kế API key theo hướng nhiều role ngay từ đầu.

### 6.2. Schema đề xuất

Các bảng hiện có:

- `roles`
- `policies`
- `role_policies`
- `user_policies`
- `permissions`
- `users`
- `user_sites`

Nên thêm hoặc chỉnh:

```txt
roles
  id
  site_id
  name
  icon
  description
  parent_id nullable
  system_key nullable
  created_at

policies
  id
  site_id
  key stable unique per site
  name
  icon
  description
  admin_access boolean default false
  app_access boolean default false
  enforce_tfa boolean default false
  ip_allow jsonb default []
  ip_deny jsonb default []
  valid_from timestamp nullable
  valid_until timestamp nullable
  rules jsonb default {}
  created_at
  updated_at

permissions
  id
  site_id
  policy_id
  collection
  action
  permissions jsonb default {}
  validation jsonb default {}
  presets jsonb default {}
  fields jsonb default ["*"]
  unique(policy_id, collection, action)

user_roles
  user_id
  site_id
  role_id
  primary key(user_id, site_id, role_id)

api_keys
  id
  site_id
  name
  key_prefix
  key_hash
  created_by
  expires_at
  revoked_at
  last_used_at
  metadata jsonb
  created_at

api_key_roles
  api_key_id
  role_id
  primary key(api_key_id, role_id)

api_key_policies
  api_key_id
  policy_id
  priority
  primary key(api_key_id, policy_id)
```

Lưu ý:

- Không export/import plaintext API key.
- Chỉ hiển thị plaintext key một lần khi tạo.
- `key_hash` nên dùng SHA-256 hoặc HMAC-SHA-256 với server secret. Nếu muốn chống offline brute-force tốt hơn, dùng token entropy >= 256-bit và SHA-256 là đủ thực dụng.
- `key_prefix` dùng để lookup/log nhanh, ví dụ `lumi_live_xxxxx`.
- API key principal nên có magic var riêng: `$CURRENT_API_KEY`.

### 6.3. Policy flags và cách evaluate

Evaluation order:

1. Resolve principal: user, API key, anonymous.
2. Load candidate policies:
   - Policies từ roles.
   - Policies gắn trực tiếp principal.
   - Public policy nếu anonymous.
3. Filter policy theo thời gian và IP:
   - Nếu IP trong `ip_deny`: loại policy.
   - Nếu `ip_allow` non-empty và IP không match: loại policy.
   - Nếu ngoài `valid_from/valid_until`: loại policy.
4. Nếu không có active policy cho Studio/API route: deny.
5. Nếu bất kỳ active policy có `enforce_tfa=true`:
   - User phải có TFA đã enrolled và request/session đã pass TFA.
   - API key không dùng TFA; với API key, policy `enforce_tfa=true` nên bị coi là incompatible hoặc ignored-by-design với warning khi attach.
6. Nếu bất kỳ active policy có `admin_access=true`: admin bypass.
7. Nếu route là Studio: yêu cầu ít nhất một active policy có `app_access=true`.
8. Compose permission rows theo collection/action.

### 6.4. Bắt buộc 2FA

Yêu cầu "kích hoạt 2FA bắt buộc đối với các user gắn roles" nên triển khai thành rule rõ:

- Role attach policy có `enforce_tfa=true` thì mọi user nhận role đó phải enroll TFA trước khi vào Studio hoặc dùng token đăng nhập.
- Nếu muốn mạnh hơn Directus, có setting site-level `security.requireTfaForRoleMembers=true`: mọi user có ít nhất một role khác public phải có TFA.
- Khi admin assign role cho user chưa enroll TFA, UI cho phép assign nhưng trạng thái user là `mfa_required`; lần đăng nhập kế tiếp bắt buộc setup TFA.
- Audit events:
  - `role_assigned_requires_tfa`
  - `mfa_enrollment_required`
  - `mfa_enrolled`
  - `mfa_bypass_denied`

### 6.5. IP allowlist

Directus dùng `ip_access` CSV trên policy. LumiBase nên dùng JSON array:

```json
{
  "ipAllow": ["203.0.113.10", "10.0.0.0/8", "2001:db8::/32"],
  "ipDeny": ["198.51.100.0/24"]
}
```

Best practice:

- Hỗ trợ IPv4, IPv6, CIDR.
- Không chỉ match string chính xác như code hiện tại; cần parser CIDR.
- `ipDeny` thắng `ipAllow`.
- Nếu policy không pass IP, loại policy khỏi evaluation thay vì deny toàn bộ principal. Cách này giống Directus và cho phép "policy chỉ mở thêm khi ở VPN".
- Studio phải preview: "từ IP hiện tại policy nào active/inactive".

## 7. Conflict detection cho Role Builder

### 7.1. Vấn đề cần tránh

Nếu role có nhiều policy cùng `collection + action`, các rule có thể cộng dồn thành quyền rộng hơn dự kiến. Ví dụ:

```json
// Policy A
{ "collection": "posts", "action": "read", "permissions": { "status": { "_eq": "published" } } }

// Policy B
{ "collection": "posts", "action": "read", "permissions": {} }
```

Nếu OR-merge, policy B biến quyền thành đọc tất cả posts. Đây có thể là đúng về mặt toán học nhưng sai về ý định admin.

### 7.2. Constraint DB

Nên thêm unique index:

```sql
unique(policy_id, collection, action)
```

Một policy chỉ có tối đa một permission row cho cùng collection/action. Nếu cần nhiều rule, dùng `_or`/`_and` trong cùng row.

### 7.3. Conflict classifier

Khi attach policy vào role/API key/user, backend trả về diff:

```txt
compatible
  - Same collection/action nhưng rule, fields, validation, presets giống hệt.
  - Fields là subset/superset và admin chọn merge mode explicit.

warning
  - Fields khác nhau nhưng chỉ mở rộng field read.
  - Row rules khác nhau nhưng không có unconditional grant.
  - Policy chỉ active theo IP/time nên conflict có điều kiện.

blocking_conflict
  - Một rule unconditional `{}` hoặc `null`, rule còn lại restricted.
  - Một permission fields `["*"]`, permission còn lại là whitelist.
  - `validation` cùng field nhưng operator/value khác.
  - `presets` cùng field nhưng value khác.
  - Một policy có `admin_access=true` được attach cùng policy granular.
  - Policy `enforce_tfa=true` attach vào API key.
```

### 7.4. UI yêu cầu

Role Detail khi chọn policy mới:

- Gọi `POST /api/v1/access/conflicts/check`.
- Hiển thị bảng conflict:
  - collection
  - action
  - existing policy
  - incoming policy
  - conflict type
  - effective result nếu merge
- Blocking conflict không cho Save.
- Warning cho phép Save nếu admin tick "I understand this widens access"; phải audit.
- Permission Matrix có chế độ "Effective View" để admin nhìn quyền cuối cùng của role/API key.

Endpoint đề xuất:

```txt
POST /api/v1/access/conflicts/check
{
  "target": { "type": "role", "id": "role_editor" },
  "addPolicies": ["policy_news_read"],
  "removePolicies": []
}
```

Response:

```json
{
  "data": {
    "ok": false,
    "conflicts": [
      {
        "severity": "blocking",
        "collection": "posts",
        "action": "read",
        "existingPolicy": "policy_posts_published",
        "incomingPolicy": "policy_posts_all",
        "reason": "UNCONDITIONAL_RULE_WIDENS_RESTRICTED_RULE"
      }
    ],
    "warnings": []
  }
}
```

## 8. Permission DSL cho LumiBase

LumiBase hiện đã hỗ trợ nhiều operator và magic vars. Nên mở rộng để gần Directus hơn:

```txt
Logic:
  _and, _or, _not

Compare:
  _eq, _neq, _lt, _lte, _gt, _gte, _in, _nin

Null/empty:
  _null, _nnull, _empty, _nempty

String:
  _contains, _icontains, _ncontains,
  _starts_with, _istarts_with,
  _ends_with, _iends_with

Range:
  _between, _nbetween

Validation-only:
  _regex

Relations:
  nested object paths, _some, _none
```

Magic vars nên có:

```txt
$CURRENT_USER
$CURRENT_USER.email
$CURRENT_ROLE
$CURRENT_ROLE.name
$CURRENT_ROLES
$CURRENT_POLICIES
$CURRENT_SITE
$CURRENT_API_KEY
$NOW
$NOW(-7 days)
$IP
$HEADERS.x-foo
```

Fail-closed rules:

- Unknown operator: deny.
- Unknown magic var: resolve null hoặc deny, không coi là literal string match.
- Relation traversal phải giới hạn depth và compile an toàn để tránh query explosion.

## 9. System collections và seeding

Directus cho non-admin cấu hình quyền trên system collections qua mục "System Collections". LumiBase cần seed policy cho các bảng hệ thống tương tự, nếu không Studio sẽ hoặc quá mở hoặc không dùng được.

Contract chốt cho seed/UI/import-export nằm ở [system-collections-access.md](./system-collections-access.md). Section này giữ bối cảnh điều tra Directus và blueprint ban đầu.

Danh sách system collections LumiBase hiện có theo schema Drizzle:

```txt
sites
users
user_sites
teams
team_members
notifications
roles
policies
role_policies
user_policies
permissions
scim_tokens
pages
collections
fields
relations
items
revisions
activity
flows
flow_runs
operations
materialized_collections
folders
files
presets
translations
settings
webhooks
extensions
translation_memory
glossary
system_state
audit_log
login_attempts
login_baselines
admin_backup_codes
ai_approvals
ai_conversations
ai_messages
ai_embeddings
cdc_pipelines
cdc_pipeline_health
cdc_deployments
```

Không phải tất cả đều nên hiện trong Permission Builder mặc định. Nên phân nhóm:

| Nhóm | Collections | Seed policy |
|---|---|---|
| Identity | `users`, `user_sites`, `teams`, `team_members` | `studio_user_self`, `access_manager` |
| Access control | `roles`, `policies`, `role_policies`, `user_policies`, `permissions`, `api_keys`, `api_key_roles`, `api_key_policies` | `access_manager` only |
| Schema builder | `collections`, `fields`, `relations` | `schema_manager` |
| Content/runtime | `items`, `revisions`, `activity`, `files`, `folders`, `presets`, `translations` | per role |
| Automation | `flows`, `flow_runs`, `operations`, `webhooks` | `automation_manager` |
| Security sensitive | `system_state`, `audit_log`, `login_attempts`, `login_baselines`, `admin_backup_codes`, `scim_tokens` | admin/security only |
| AI/CDC | `ai_*`, `cdc_*` | admin or dedicated manager |

Seed tối thiểu cho local/dev:

- `site_demo`
- `system_state`
- `policy_admin` với `admin_access=true`, `app_access=true`, `enforce_tfa=true`
- `role_administrator`
- attach `policy_admin` vào `role_administrator`
- bootstrap/dev user membership vào role administrator
- `policy_studio_self` với app access và quyền đọc/update profile của chính mình, notifications, presets
- `policy_public` không app access, chỉ có permission public do project owner chọn

Không nên seed:

- Quyền public đọc tất cả content.
- Static/API key plaintext.
- Quyền non-admin vào `system_state`, `audit_log`, backup codes, SCIM/API key secrets.

## 10. API Keys gắn trực tiếp tới Roles

Directus static token nằm trên `directus_users.token`: token dùng quyền của user đó. Cách này đơn giản nhưng có nhược điểm:

- Token gắn với người thật, khó audit service integration.
- Một user chỉ có một static token.
- Token không có lifecycle riêng theo integration.
- Rotate/revoke ảnh hưởng user.

LumiBase nên làm API key first-class:

- API key là principal riêng, không phải user giả.
- API key có roles và policies như user.
- API key không có app access.
- API key có scopes metadata để UI/audit rõ service nào đang dùng.
- API key có expire/revoke/rotate/last_used.
- API key có conflict check khi attach roles/policies.

Runtime:

```txt
Authorization: Bearer lumi_live_<prefix>_<secret>
```

Middleware:

1. Hash token.
2. Lookup active `api_keys`.
3. Build principal `{ type: "api_key", apiKeyId, siteId }`.
4. Compile policies qua `api_key_roles` + `api_key_policies`.
5. Apply permission checks y hệt user, ngoại trừ TFA và Studio access.

## 11. Import / Export access config

Đây nên là tính năng "Permission Builder Config-as-Code".

Contract versioned đã chốt ở [access-manifest-v1.md](./access-manifest-v1.md) và schema JSON ở [`docs/schemas/lumibase.access.v1.schema.json`](../../schemas/lumibase.access.v1.schema.json).

### 11.1. Nguyên tắc

- Dùng stable key, không phụ thuộc DB id.
- Export không chứa secret.
- Import chạy trong transaction.
- Luôn có dry-run.
- Có conflict report trước khi apply.
- Có mode `merge`, `replace-managed`, `replace-all`.
- Có audit event cho từng import.
- Có schema version.

### 11.2. Manifest đề xuất

```json
{
  "schema": "lumibase.access@v1",
  "version": 1,
  "kind": "lumibase.access",
  "siteKey": "default",
  "exportedAt": "2026-06-03T00:00:00.000Z",
  "roles": [
    {
      "key": "editor",
      "name": "Editor",
      "description": "Can edit own drafts",
      "icon": "square-pen",
      "parents": [],
      "policies": [
        { "key": "studio_app", "priority": 10 },
        { "key": "posts_editor", "priority": 100 }
      ]
    }
  ],
  "policies": [
    {
      "key": "posts_editor",
      "name": "Posts editor",
      "adminAccess": false,
      "appAccess": true,
      "enforceTfa": true,
      "ipAllow": ["10.0.0.0/8"],
      "ipDeny": [],
      "validFrom": null,
      "validUntil": null,
      "permissions": [
        {
          "collection": "posts",
          "action": "read",
          "fields": ["title", "body", "status", "user_created"],
          "permissions": {
            "_or": [
              { "status": { "_eq": "published" } },
              { "user_created": { "_eq": "$CURRENT_USER" } }
            ]
          },
          "validation": {},
          "presets": {}
        },
        {
          "collection": "posts",
          "action": "update",
          "fields": ["title", "body", "status"],
          "permissions": {
            "user_created": { "_eq": "$CURRENT_USER" }
          },
          "validation": {
            "status": { "_in": ["draft", "review"] }
          },
          "presets": {
            "user_updated": "$CURRENT_USER"
          }
        }
      ]
    }
  ],
  "apiKeys": [
    {
      "key": "nextjs_frontend",
      "name": "Next.js frontend",
      "roles": ["public_reader"],
      "policies": [],
      "expiresAt": null,
      "revoked": false
    }
  ]
}
```

### 11.3. Import modes

| Mode | Hành vi |
|---|---|
| `dry-run` | Parse, validate, diff, conflict check; không ghi DB |
| `merge` | Upsert role/policy/permission theo key; không xóa object ngoài manifest |
| `replace-managed` | Chỉ xóa object có `managedBy="access-import"` nhưng không còn trong manifest |
| `replace-all` | Xóa mọi access config trong site rồi apply; chỉ dùng cho env mới |

### 11.4. Endpoint/CLI

```txt
GET  /api/v1/access/export
POST /api/v1/access/import?dryRun=true
POST /api/v1/access/import
POST /api/v1/access/conflicts/check
```

CLI:

```bash
lumibase access export --site site_demo > access.json
lumibase access import access.json --dry-run
lumibase access import access.json --mode replace-managed
```

### 11.5. Best practice khi sync môi trường

- Commit `access.json` vào repo cùng collection schema.
- CI chạy import dry-run trên staging DB clone.
- Không export user membership production nếu có PII; export roles/policies trước, membership bằng SCIM hoặc seed riêng.
- API keys export metadata, không export secret. Import tạo key disabled hoặc yêu cầu `--generate-secrets`.
- Dùng stable key dạng slug: `posts_editor`, `policy_public_read_posts`.
- Mọi import phải tạo audit log với diff summary.

## 12. Extension access control

### 12.1. Directus xử lý extension qua nhiều lớp

Directus không có một policy first-class kiểu "role/user X được truy cập extension Y" cho mọi extension. Cách họ xử lý là nhiều lớp khác nhau:

1. **Extension installation/loading layer**
   - App extensions và sandboxed API extensions có thể cài qua Marketplace.
   - API extensions không sandboxed là mức tin cậy cao hơn và self-host có thể phải bật trust hoặc cài thủ công.
   - Extension enabled/disabled ở Settings là scope toàn project, không phải per-user.

2. **Sandbox capability layer cho API extensions**
   - Sandboxed API Extensions chạy trong môi trường isolate và phải khai báo `requestedScopes`.
   - Scope ví dụ: `log`, `sleep`, `request` với method/url allowlist.
   - Đây là quyền của extension đối với host environment, không phải quyền của user đối với extension.

3. **Accountability/user-permission layer khi extension gọi Directus services**
   - API extension có thể dùng internal services như `ItemsService`, `CollectionsService`, `FilesService`.
   - Khi service được khởi tạo với `accountability: req.accountability`, quyền dữ liệu được kiểm theo user hiện tại.
   - Nếu extension truyền `accountability: null` hoặc bỏ qua accountability, service chạy với quyền admin. Đây là lớp mạnh nhưng cũng là rủi ro nếu extension không cẩn thận.

4. **App extension/module UI layer**
   - App modules không có access control riêng như collections.
   - Module có thể tự dùng permission store để kiểm tra quyền collection/admin rồi ẩn hoặc chặn UI.
   - Đây là convention ở extension code, không phải policy binding bắt buộc ở platform level.

Kết luận: Directus có extension enable/sandbox/service accountability, nhưng chưa có permission builder first-class để cấu hình user/role/policy được thấy/chạy extension nào.

Nguồn tham khảo chính thức:

- Directus Sandbox: sandboxed API extensions chạy isolate và phải khai báo requested scopes.
- Directus Services: internal services nhận `accountability`; `null`/omit có thể dùng administrator permissions.
- Directus Including Extensions: Marketplace mặc định cho app/sandboxed API extensions; API extensions không sandboxed phụ thuộc trust/self-host install.
- Directus Modules: module xuất hiện khi extension enabled và module enabled trong Module Bar; module không có access control như collection, extension có thể dùng permission store để tự chặn.

### 12.2. Thiết kế đề xuất cho LumiBase

LumiBase nên tách 3 loại quyền extension:

| Lớp | Mục tiêu | Ai cấu hình | Enforce ở đâu |
|---|---|---|---|
| Extension capability grant | Extension được dùng host API nào | Site admin/security admin | Sandbox runtime |
| Extension access policy | User/role/API key nào được thấy/gọi extension nào | Access manager | PermissionService + Studio/router |
| Effective data permission | Extension thao tác data theo quyền user hay service account | Extension author + admin grant | ItemService/PermissionService |

Capability không thay thế RBAC. Ví dụ extension `shopify-sync` có capability `items:update:products`, nhưng chỉ role `commerce_manager` mới được mở module và chạy sync.

### 12.3. Collection/action mới cho Permission Builder

Thêm system collection virtual hoặc thật:

- `extensions`
- `extension_modules`
- `extension_endpoints`
- `extension_operations`

Action đề xuất:

| Action | Ý nghĩa |
|---|---|
| `read` | Thấy extension trong Settings/Marketplace/Module Bar |
| `execute` | Gọi endpoint/operation/module action của extension |
| `configure` | Sửa config của extension |
| `install` | Cài extension mới |
| `enable` | Enable/disable extension |
| `grant_capability` | Duyệt sandbox capabilities |
| `delete` | Uninstall extension |

Permission row có thể dùng collection/action chuẩn:

```json
{
  "collection": "extensions",
  "action": "execute",
  "permissions": {
    "extension_key": { "_in": ["shopify_sync", "stripe_refunds"] }
  },
  "fields": ["*"]
}
```

Hoặc model chuyên biệt hơn:

```json
{
  "collection": "extension_modules",
  "action": "read",
  "permissions": {
    "extension_key": { "_eq": "commerce_dashboard" }
  }
}
```

### 12.4. Runtime enforcement cho LumiBase

1. **Studio extension loader**
   - `/extensions` list chỉ trả extension UI mà principal có `extensions:read` hoặc `extension_modules:read`.
   - Module Bar chỉ hiện module extension nếu effective policy cho phép.
   - Settings > Extensions yêu cầu `extensions:configure/install/enable/delete`.

2. **Extension endpoint router**
   - Trước khi route tới `/api/v1/extensions/:name/*`, backend kiểm tra:
     - extension enabled;
     - principal có `extensions:execute` với `extension_key=name`;
     - nếu API key principal thì extension phải khai báo `apiKeyCallable=true` hoặc policy cho phép rõ.

3. **Hook/operation execution**
   - Hook chạy do mutation của user nên phải có `actor` trong context.
   - Extension thao tác data mặc định dùng actor permission.
   - Nếu cần service-account mode, phải khai báo trong manifest và được grant capability riêng, có audit.

4. **Sandbox capability**
   - Tiếp tục giữ capability allowlist hiện có (`items:*`, `http:fetch`, `secrets:read`, `log:write`, ...).
   - Capability grant là upper bound; user permission là lower bound. Extension chỉ được làm khi cả hai lớp đều cho phép.

### 12.5. DB/API đề xuất

Schema options:

- Thêm cột vào `extensions`:
  - `key` stable unique per site.
  - `accessMode`: `inherit` | `restricted` | `public_studio`.
  - `serviceAccountPolicyId` nullable.
  - `apiKeyCallable` boolean.
- Hoặc thêm bảng:
  - `extension_access_policies(extension_id, policy_id, access_scope, priority)`.

Khuyến nghị: dùng Permission Builder là nguồn chính, không tạo hệ RBAC thứ hai. `extension_access_policies` chỉ cần nếu muốn shortcut UI. Import/export phải đưa extension access config vào manifest.

### 12.6. Conflict và audit

- Conflict checker phải hiểu `extensions/extension_modules/extension_endpoints` như system collections.
- Block nếu policy cho user thường `grant_capability` hoặc `install` extension mà không có `appAccess`.
- Audit bắt buộc cho:
  - install/uninstall;
  - enable/disable;
  - grant/revoke capability;
  - execute endpoint/operation bị deny;
  - service-account execution.

## 13. Implementation plan

### Phase 1: Hardening schema hiện có

- Thêm unique `(policy_id, collection, action)`.
- Thêm conflict checker service.
- Thêm endpoint `POST /access/conflicts/check`.
- Role Detail UI gọi conflict checker trước khi attach policy.
- PermissionService trả trace source policies trong `/permissions/me`.

### Phase 2: Policy flags migration

- Thêm cột policy: `admin_access`, `app_access`, `enforce_tfa`, `ip_allow`, `ip_deny`, `valid_from`, `valid_until`.
- Deprecate `roles.admin_access`, `roles.app_access`.
- Studio chuyển toggles sang policy detail hoặc quick-create policy.
- Auth middleware enforce app access và TFA theo effective policies.

### Phase 3: API keys

- Thêm `api_keys`, `api_key_roles`, `api_key_policies`.
- Bearer auth lookup theo hashed token.
- API Key management UI.
- Rotate/revoke/last-used/audit.

### Phase 4: Import/export

- Define JSON schema.
- Export stable keys.
- Dry-run diff.
- Apply transaction + audit.
- CLI wrapper.

### Phase 5: Extension access

- Thêm extension access system collections/actions.
- Enforce extension list/module/endpoint theo effective permissions.
- Thêm UI policy builder cho extension access.
- Audit capability grant và endpoint/operation deny.

### Phase 6: Share

- Thêm `shares`.
- Implement `share` action.
- Share role builder chuyên dụng.
- Public share endpoint dùng role permission để mask fields/read item.

## 14. Test matrix

Backend tests:

- Policy active/inactive theo IP CIDR.
- Policy active/inactive theo time window.
- `enforce_tfa` deny khi session chưa pass TFA.
- `admin_access` bypass không cần permission rows.
- Unknown operator/magic var fail closed.
- Duplicate permission trong một policy bị reject.
- Conflict checker block unconditional-vs-restricted.
- Conflict checker block `*` fields vs whitelist.
- API key compile roles/policies y hệt user.
- User không có `extensions:execute` không gọi được endpoint extension.
- User không có `extension_modules:read` không thấy module extension trong Studio.
- Extension capability có nhưng actor permission thiếu thì vẫn deny data mutation.
- Import dry-run không ghi DB.
- Import apply idempotent.

Frontend tests:

- Role attach policy hiển thị conflict trước khi save.
- Permission matrix hiển thị effective source policies.
- Policy detail có app/admin/TFA/IP controls.
- API key detail attach roles/policies và preview effective permissions.
- Import dialog hiển thị diff/conflict.
- Extension settings chỉ hiện install/enable/grant capability khi principal có quyền tương ứng.

Security tests:

- Public role không đọc được collection chưa explicit permission.
- API key revoked không authenticate.
- API key không được dùng Studio route dù policy có app access.
- API key không gọi được extension endpoint trừ khi extension cho phép API-key callable và policy có `extensions:execute`.
- Share link chỉ đọc fields role share được phép.
- System collections sensitive không xuất hiện cho non-admin.

## 15. Quyết định khuyến nghị

1. Nên làm giống Directus v11 ở chỗ access flags thuộc policy, không thuộc user.
2. Không nên giữ `adminAccess/appAccess` trên role dài hạn; role chỉ nên là grouping.
3. Nên cho API key nhận role/policy trực tiếp, nhưng API key là principal riêng chứ không phải static token của user.
4. Nên chặn conflict ở UI/backend thay vì âm thầm OR/union mọi thứ.
5. Nên seed system access policies ngay từ đầu, đặc biệt `admin`, `studio self`, `schema manager`, `access manager`, `public`.
6. Nên coi import/export access config là production-critical: có schema version, dry-run, stable keys, audit, và không bao giờ export plaintext secrets.
7. Nên bổ sung extension access control first-class; đây là điểm LumiBase có thể tốt hơn Directus vì Directus chủ yếu dựa vào sandbox/accountability và module tự check permission.
