# Migration role flags sang policy flags

> Scope: thiết kế migration backward-compatible cho `roles.admin_access/app_access` sang policy-level `admin_access/app_access/enforce_tfa/ip_allow/ip_deny/valid_from/valid_until`.

## 1. Trạng thái hiện tại

- Schema `policies` đã có các cột `admin_access`, `app_access`, `enforce_tfa`, `ip_allow`, `ip_deny`, `valid_from`, `valid_until`.
- Schema `roles` vẫn còn `admin_access` và `app_access` để tương thích.
- `PermissionService` hiện tính effective access theo kiểu compatibility: legacy role flags OR active policy flags.
- Migration trước đây (`0010_loud_the_renegades.sql`, nay đã gộp vào `0000_lumibase_init`) đã thêm policy flags nhưng chưa materialize role flags hiện có thành policy rows.

Kết luận: có thể migrate an toàn nếu không xoá hoặc tắt legacy role flags ngay. Policy flags trở thành source of truth mới, còn role flags là fallback trong một release window.

## 2. Mục tiêu

1. Không làm mất quyền admin/app hiện tại của bất kỳ role/user/site nào.
2. Đưa `adminAccess`, `appAccess`, `enforceTfa`, IP guard và time window về policy level.
3. Giữ role là grouping/assignment unit, không phải nơi chứa security guard.
4. Chuẩn bị cho seed `policy_admin`, `policy_studio_self`, import/export `lumibase.access@v1`, app access enforcement và TFA enforcement.
5. Cho phép rollback không mất quyền.

## 3. Migration phases

### Phase A: compatibility window

Trạng thái này đang đúng với implementation hiện tại.

- Giữ `roles.admin_access/app_access`.
- Compile effective flags bằng `role flags OR active policy flags`.
- Studio đánh dấu role-level toggles là deprecated/read-only hoặc hiển thị cảnh báo.
- Policy Detail là nơi chỉnh flags mới.
- Import/export ưu tiên policy flags; role flags chỉ export dưới dạng legacy metadata nếu thật sự cần debug.

### Phase B: materialize legacy role flags

Tạo một policy legacy cho mỗi role đang có `admin_access=true` hoặc `app_access=true`.

Contract:

- Key policy: `legacy_role_flags_<stable_role_key>`.
- Name: `Legacy role flags: <role name>`.
- `admin_access` = giá trị hiện tại của role.
- `app_access` = giá trị hiện tại của role.
- `enforce_tfa=false`.
- `ip_allow=[]`, `ip_deny=[]`.
- `valid_from=null`, `valid_until=null`.
- Không tạo permission rows cho policy legacy, vì policy này chỉ mang access flags.
- Attach policy legacy vào chính role qua `role_policies`.
- Không mutate role flags ở phase này.

Lý do giữ đúng từng flag thay vì suy luận `admin_access => app_access`: dữ liệu legacy có thể tồn tại role admin API-only hoặc role app-only. Migration phải preserve exact effective behavior trước khi áp chính sách mới.

### Phase C: chuyển UI và seed sang policy-first

- Role Detail không còn là nơi chỉnh `adminAccess/appAccess`; thay vào đó có quick action tạo/attach policy phù hợp.
- Policy Detail sở hữu `adminAccess`, `appAccess`, `enforceTfa`, `ipAllow`, `ipDeny`, `validFrom`, `validUntil`.
- Seed mới không set role flags, trừ khi cần compatibility cho version cũ.
- Seed tối thiểu:
  - `role_administrator`
  - `policy_admin` với `adminAccess=true`, `appAccess=true`, `enforceTfa=true`
  - attach `policy_admin` vào `role_administrator`
  - `policy_studio_self` với `appAccess=true` và quyền self-service tối thiểu
  - `policy_public` với `adminAccess=false`, `appAccess=false`

### Phase D: shadow verify và tắt fallback

Trước khi tắt role fallback, chạy report so sánh:

- effective admin/app từ legacy role flags
- effective admin/app từ attached active policies
- danh sách role còn flag legacy true nhưng không có policy tương ứng

Chỉ sau khi report sạch mới bật cấu hình:

```text
LUMIBASE_RBAC_LEGACY_ROLE_FLAGS=false
```

Khi flag này false, `PermissionService` chỉ dùng policy flags. Cột role flags vẫn nên giữ thêm ít nhất một release để rollback.

### Phase E: drop legacy columns

Chỉ thực hiện sau một release boundary rõ ràng:

- không còn code đọc role flags
- không còn Studio control ghi role flags
- export/import không cần legacy metadata
- migration verification đã chạy sạch trên production

## 4. SQL strategy idempotent

Đây là pseudo-SQL, không phải migration cuối cùng. Implementation nên dùng Drizzle/SQL transaction và nanoid generator nhất quán với project.

```sql
WITH legacy_roles AS (
  SELECT
    id AS role_id,
    site_id,
    name,
    admin_access,
    app_access,
    lower(
      regexp_replace(
        coalesce(system_key, key, id),
        '[^a-zA-Z0-9]+',
        '_',
        'g'
      )
    ) AS role_key
  FROM lumibase_roles
  WHERE admin_access = true OR app_access = true
),
upserted_policies AS (
  INSERT INTO lumibase_policies (
    id,
    site_id,
    key,
    name,
    description,
    admin_access,
    app_access,
    enforce_tfa,
    ip_allow,
    ip_deny,
    valid_from,
    valid_until,
    rules
  )
  SELECT
    gen_lumibase_id(),
    site_id,
    'legacy_role_flags_' || role_key,
    'Legacy role flags: ' || name,
    'Backfilled from roles.admin_access/app_access. Do not edit manually after policy migration is complete.',
    admin_access,
    app_access,
    false,
    '[]'::jsonb,
    '[]'::jsonb,
    null,
    null,
    '{}'::jsonb
  FROM legacy_roles
  ON CONFLICT (site_id, key) DO UPDATE SET
    admin_access = excluded.admin_access,
    app_access = excluded.app_access,
    enforce_tfa = excluded.enforce_tfa,
    ip_allow = excluded.ip_allow,
    ip_deny = excluded.ip_deny,
    valid_from = excluded.valid_from,
    valid_until = excluded.valid_until
  RETURNING id, site_id, key
)
INSERT INTO lumibase_role_policies (role_id, policy_id, priority)
SELECT lr.role_id, p.id, 5
FROM legacy_roles lr
JOIN upserted_policies p
  ON p.site_id = lr.site_id
 AND p.key = 'legacy_role_flags_' || lr.role_key
ON CONFLICT DO NOTHING;
```

Implementation notes:

- Nếu DB không có `gen_lumibase_id()`, tạo ID trong application migration.
- `priority=5` chỉ là convention. Policy flag không có permission rows nên không ảnh hưởng merge permission rows.
- `ON CONFLICT (site_id, key)` yêu cầu unique index `policies_site_key_unique`.

## 5. Verification checklist

Pre-check:

```sql
SELECT site_id, count(*) AS role_count
FROM lumibase_roles
WHERE admin_access = true OR app_access = true
GROUP BY site_id;
```

Post-check:

```sql
SELECT r.id, r.site_id, r.name, r.admin_access, r.app_access
FROM lumibase_roles r
WHERE (r.admin_access = true OR r.app_access = true)
AND NOT EXISTS (
  SELECT 1
  FROM lumibase_role_policies rp
  JOIN lumibase_policies p ON p.id = rp.policy_id
  WHERE rp.role_id = r.id
    AND p.admin_access = r.admin_access
    AND p.app_access = r.app_access
);
```

Expected result: zero rows.

Behavior tests:

- Role admin legacy trước migration vẫn admin sau migration.
- Role app-only legacy trước migration vẫn vào Studio sau migration.
- Role không có app access vẫn không vào Studio.
- Role không có admin access vẫn không bypass permission rows.
- Tắt `LUMIBASE_RBAC_LEGACY_ROLE_FLAGS` trên fixture đã backfill không đổi effective result.
- Rollback xoá policy key prefix `legacy_role_flags_` vẫn không mất quyền vì role flags còn nguyên.

## 6. Rollback

Rollback an toàn trong compatibility window:

```sql
DELETE FROM lumibase_role_policies
WHERE policy_id IN (
  SELECT id FROM lumibase_policies WHERE key LIKE 'legacy_role_flags_%'
);

DELETE FROM lumibase_policies
WHERE key LIKE 'legacy_role_flags_%';
```

Không xoá hoặc reset `roles.admin_access/app_access` trong cùng migration. Đây là điểm bảo vệ backward-compatible quan trọng nhất.

## 7. Ảnh hưởng tới feature tiếp theo

App access enforcement:

- Studio phải check `effective.appAccess=true` từ active policies.
- Trong compatibility window, role flags vẫn OR vào kết quả để không phá user hiện tại.
- API key luôn bị chặn khỏi Studio, kể cả khi policy có `appAccess=true`.

TFA enforcement:

- Backfill legacy policy đặt `enforceTfa=false` vì role flags cũ không có nghĩa tương đương.
- `policy_admin` seed mới nên đặt `enforceTfa=true`.
- API key attach vào policy có `enforceTfa=true` phải bị blocking conflict hoặc warning mạnh, vì API key không enroll TFA.

IP/time guards:

- Backfill legacy policy để `ipAllow=[]`, `ipDeny=[]`, `validFrom=null`, `validUntil=null`.
- Các guard mới chỉ được thêm qua Policy Detail, seed hoặc import manifest.

Import/export:

- `lumibase.access@v1` export policy flags là source of truth.
- Legacy role flags không được dùng để tạo quyền mới trong môi trường đích.
- Nếu cần trace migration, export legacy role flags trong `metadata.legacyRoleFlags`, không trong contract chính.

Studio deprecation:

- Role page chỉ hiển thị legacy flags dạng read-only trong migration window.
- Save role không nên ghi `adminAccess/appAccess`.
- Nút sửa access flag nên điều hướng sang Policy Detail hoặc tạo policy mới rồi attach.

System seeding:

- New seed dùng `policy_admin`, `policy_studio_self`, `policy_public`.
- Không seed role-level access flags cho môi trường mới, trừ khi đang hỗ trợ version cũ chưa đọc policy flags.
