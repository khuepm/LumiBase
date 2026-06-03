# Audit PermissionService compose behavior

Ngày audit: 2026-06-03.

Phạm vi đọc code:

- `apps/cms/src/services/permission-service.ts`
- `apps/cms/src/services/permission-dsl.ts`
- `apps/cms/src/services/item-service.ts`
- `apps/cms/src/routes/permissions.ts`

Mục tiêu của tài liệu này là mô tả hành vi hiện tại của `PermissionService`, đặc biệt là cách nhiều role/policy/permission được compose, những chỗ quyền có thể mở rộng im lặng, và các gap cần xử lý trước khi làm Permission Builder/import-export/API keys.

## 1. Luồng compile quyền hiện tại

`PermissionService.bundle()` compile một `PermissionBundle` cho principal hiện tại và cache theo key `perm:{siteId}:{userId|anon}` trong 60 giây.

Các bước compile:

1. Nếu có `ctx.userId`, load user row. Hiện user row chỉ dùng để xác định user tồn tại; chưa đưa user attributes vào magic vars.
2. Load role chính từ `user_sites.role_id`.
3. Load role phụ từ `user_roles`.
4. De-dupe roles theo `role.id`.
5. Load policy bindings từ:
   - `role_policies` cho tất cả role của user.
   - `user_policies` gắn trực tiếp user.
6. Sort bindings theo `priority` tăng dần.
7. De-dupe policy ids bằng `Set`, giữ thứ tự xuất hiện đầu tiên sau sort.
8. Load policy metadata, loại policy không active theo `valid_from`, `valid_until`, `ip_allow`, `ip_deny`.
9. Nếu role hoặc policy active có `adminAccess=true`, trả bundle admin bypass và không compile permission rows.
10. Load permission rows cho active policies.
11. Group permission rows theo key `${collection}::${action}`.
12. Nếu nhiều row cùng key, merge bằng `mergePermission()`.

Kết quả trả về:

- `admin`: bypass toàn bộ permission checks.
- `appAccess`: `true` nếu role legacy hoặc active policy có `appAccess=true`.
- `tfaRequired`: `true` nếu active policy có `enforceTfa=true`.
- `byKey`: map effective permission theo `collection::action`.
- `roles`: danh sách role đã de-dupe.

## 2. Hành vi compose permission rows

### 2.1. Rules (`permissions`)

Nếu hai permission cùng `collection + action` đều có rule, service nối bằng `_or`:

```ts
{ _or: [a.rule, b.rule] }
```

Nếu một bên không có rule hoặc rule rỗng, rule còn lại được giữ. Nếu cả hai không có rule, effective rule là `null`.

Ý nghĩa thực tế:

- Đây là mô hình additive/union.
- Thêm một policy rộng hơn có thể mở dữ liệu mà admin không nhận ra.
- Ví dụ policy A chỉ đọc `status=published`, policy B đọc `{}` hoặc không rule. Effective read có thể thành unrestricted hoặc rộng hơn mong đợi.

Ghi chú: conflict checker hiện đã block một số case khi attach role-policy/user-policy, nhưng `PermissionService` vẫn là additive engine. Import/export hoặc migration ghi trực tiếp vào DB vẫn cần conflict check riêng.

### 2.2. Fields

Field list merge bằng `mergeFieldLists()`:

- Nếu một trong hai list có `"*"`, effective fields là `["*"]`.
- Ngược lại union tất cả field names.
- Exclusion dạng `"-secret"` chỉ được xử lý khi apply mask, không được xử lý trong bước merge.

Rủi ro:

- Policy A whitelist `["title"]`, policy B whitelist `["body"]` thành `["title", "body"]`.
- Policy A whitelist `["title"]`, policy B `["*"]` thành `["*"]`, mở toàn bộ fields.
- Nếu có mix include/exclude, ví dụ `["*"]` và `["-secret"]`, bước merge hiện trả `["*"]`, làm mất exclusion. Đây là gap cần sửa nếu dùng blacklist field nghiêm túc.

### 2.3. Presets

Presets merge bằng object spread:

```ts
{ ...a.presets, ...b.presets }
```

Nếu nhiều policy set cùng field, policy được merge sau thắng. Vì bindings đã sort theo priority trước khi lấy `policyIds`, nhưng permission rows sau đó query bằng `inArray` không đảm bảo order DB theo priority, nên thứ tự thắng thực tế có thể không ổn định.

Rủi ro:

- Cùng field preset khác value có thể bị override im lặng.
- Priority không được enforce chắc chắn ở query permission rows.
- Conflict checker hiện block conflicting preset cùng field khi attach role/user policy, nhưng import/DB direct write vẫn cần kiểm tra.

### 2.4. Validation

Validation merge cũng bằng object spread:

```ts
{ ...a.validation, ...b.validation }
```

Cập nhật hardening 2026-06-03: `ItemService` hiện đã áp dụng `perm.validation` trong create/update. Validation trong permission rows vẫn được merge bằng object spread, nên conflict checker/import dry-run vẫn cần chặn case cùng field khác value trước khi runtime nhận cấu hình đó.

Rủi ro:

- Cùng field validation khác value có thể bị override im lặng nếu ghi trực tiếp DB/import mà không qua conflict checker.

### 2.5. Sources

Mỗi compiled permission có `sources` gồm policy id/name đã đóng góp vào effective permission. Đây là trace tối thiểu cho Permission Matrix, chưa phải audit trace đầy đủ theo từng field/rule/preset.

## 3. Policy active guard

Policy active guard hiện hỗ trợ:

- `validFrom` / `validUntil` ở cột policy hoặc fallback từ `policy.rules`.
- `ipAllow` / `ipDeny` ở cột policy hoặc fallback từ `policy.rules`.
- IPv4, IPv6, CIDR.
- `ipDeny` thắng `ipAllow`.
- Nếu `ipAllow` non-empty mà request không có IP, policy bị loại.

Quan trọng: policy không active bị loại khỏi chain, không deny toàn bộ principal. Điều này phù hợp pattern "policy chỉ mở thêm khi ở VPN".

## 4. Magic vars và DSL hiện tại

Magic vars đang hỗ trợ:

- `$CURRENT_USER`
- `$CURRENT_SITE`
- `$CURRENT_ROLE`
- `$IP`
- `$NOW`
- `$HEADERS.<name>`

Chưa hỗ trợ:

- `$CURRENT_ROLES`
- `$CURRENT_POLICIES`
- `$CURRENT_API_KEY`
- Nested `$CURRENT_USER.*`
- `$NOW(+/- duration)`

Unknown magic var hiện được giữ nguyên dạng string literal. Trong SQL comparison thường sẽ không match, nhưng đây không phải fail-closed rõ ràng. Với một số operator hoặc dữ liệu literal trùng placeholder, hành vi có thể gây hiểu nhầm.

Operators hiện hỗ trợ trong permission DSL:

- Logic: `_and`, `_or`, `_not`
- Compare: `_eq`, `_neq`, `_in`, `_nin`, `_gt`, `_gte`, `_lt`, `_lte`, `_contains`, `_starts_with`, `_ends_with`, `_between`

Unknown operator trong `compileWhere()` được compile thành `false`; trong `evaluate()` trả `false`. Đây là fail-closed cho operator chưa biết.

Chưa hỗ trợ trong permission DSL:

- `_null`, `_nnull`, `_empty`, `_nempty`, `_regex`
- Case-insensitive variants rõ ràng ngoài các string operators đang dùng lowercase/ILIKE.

## 5. Cách quyền được áp vào ItemService

### 5.1. Read/list/detail

`list()` và `detail()` gọi permission action `read`.

- `whereFor(perm)` compile rule thành SQL WHERE.
- SQL query có tenant scope, collection id, deleted filter, filter từ client, và permission WHERE.
- Sau khi query, `maskItem()` áp field mask theo schema fields.
- Encrypted fields chỉ decrypt nếu principal có `read_decrypted`.

Đây là đường enforce đầy đủ nhất hiện tại.

### 5.2. Create

`create()` gọi permission action `create`.

- Enforce field whitelist trên user-submitted `data`, `status`, `sort`.
- `applyPresets()` apply server presets vào payload.
- `matches()` kiểm tra snapshot sau presets có thỏa create rule.
- Sau đó chạy hooks, schema validation, permission validation, encrypt và insert.

Hook mutation vẫn chạy trước schema/permission validation, nên dữ liệu hook cũng bị chặn trước khi insert nếu vi phạm.

### 5.3. Update/replace

`patch()` / `replace()` hiện gọi `this.perm(collectionName, 'update')`.

- Load raw row theo `siteId + collectionId + id + deletedAt is null + row-level permission WHERE`.
- Enforce field whitelist trên user-submitted `data`, `status`, `sort`.
- Chạy schema validation partial cho user patch và hook patch.
- Chạy permission validation trên final snapshot.
- Update bằng `siteId + collectionId + id + deletedAt is null + row-level permission WHERE`.

### 5.4. Delete

`softDelete()` hiện gọi `this.perm(collectionName, 'delete')`.

- Row-level delete rule được đưa vào query kiểm tra trước hook.
- Hook chỉ chạy sau khi row qua delete permission.
- Soft-delete update cũng dùng cùng site/collection/id/deletedAt/permission WHERE.

### 5.5. Revisions

`listRevisions()` chưa gọi permission gate riêng. `revertRevision()` đi qua `replace()` nên đã thừa hưởng update gate.

## 6. Các case có thể mở rộng quyền im lặng

1. **Unrestricted rule mở rộng restricted rule**
   - Một permission `{}` hoặc null rule cùng collection/action có thể mở rộng policy restricted.
   - Conflict checker đã block khi attach qua role/user endpoint, nhưng engine vẫn additive.

2. **Field `*` làm mất whitelist**
   - Bất kỳ source nào có `["*"]` biến effective fields thành all fields.

3. **Blacklist field có thể bị mất khi merge**
   - `mergeFieldLists()` trả `["*"]` nếu một bên có `*`, không giữ `-field`.

4. **Preset/validation cùng field bị override**
   - Object spread không biểu diễn conflict hoặc AND semantics.
   - Query permission rows không order rõ theo binding priority.

5. **Direct DB write/import bỏ qua conflict checker**
   - Runtime engine không reject overlap; chỉ attach endpoint hiện có preview/enforce.

6. **Cache stale tối đa 60 giây**
   - Invalidate không thể clear theo prefix; khi thay đổi policy/permission có thể còn principal cache cũ tới TTL.

7. **Role legacy admin/app access vẫn bypass/allow**
   - Dù đã thêm policy flags, role-level `adminAccess/appAccess` vẫn được dùng làm compatibility fallback.

8. **Revision list chưa có permission gate riêng**
   - Revert đã đi qua replace/update gate; list revisions vẫn cần quyết định quyền riêng.

## 7. Khuyến nghị thứ tự hardening

1. Sửa `mergeFieldLists()` để giữ exclusion khi có `*`.
2. Làm permission row query deterministic theo policy binding priority.
3. Thêm permission gate riêng cho revision list.
4. Chuyển unknown magic vars sang fail-closed rõ ràng, có lỗi preview trong builder.
5. Mở rộng DSL operators theo roadmap.
6. Bắt buộc import/dry-run chạy conflict checker giống attach endpoint.
