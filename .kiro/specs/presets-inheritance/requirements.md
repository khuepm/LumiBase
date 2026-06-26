# Requirements Document — Presets Inheritance

## Introduction

Directus presets lưu view state per collection ở 3 scope: global (mặc định hệ thống), role, user — với độ ưu tiên user > role > global, và bookmark có tên. LumiBase đã có bảng `presets` (đầy đủ cột: userId, roleId, layout, layoutQuery, filter, bookmark...) và roles có `parentId` (role hierarchy). NHƯNG routes presets chỉ CRUD thô, CHƯA có **resolution logic** (gộp theo scope + kế thừa role parent) và UI chưa khai thác.

Spec này gap-focused: thêm **resolution endpoint** trả preset hiệu lực cho (user, collection) theo precedence + role inheritance, **bookmark** quản lý, và **UI** lưu/khôi phục view state + chia sẻ bookmark role-level.

Hiện trạng tận dụng được (xác minh trong codebase):
- Bảng `presets` (`packages/database/src/schema/platform.ts:67-95`): bookmark, collection, userId, roleId, layout (`tabular|cards|kanban|calendar|map`), layoutQuery, layoutOptions, search, filter, icon, color, refreshInterval; index `presets_scope_idx (userId, roleId)`.
- Bảng `roles` (`packages/database/src/schema/access.ts:26-53`): `parentId` (role inheritance), adminAccess, appAccess.
- Routes (`apps/cms/src/routes/presets.ts`): GET (list, `?collection=`), GET/:id, POST, PATCH/:id, DELETE/:id — CRUD thô, không resolution.
- `permission-service.ts` (đã resolve role) — tham khảo cách resolve role hierarchy nếu có.

## Glossary

- **Preset**: View state lưu của một collection (layout, filter, sort, columns...). Bảng `presets`.
- **Scope**: Phạm vi áp dụng preset: `global` (userId=null, roleId=null), `role` (roleId set), `user` (userId set).
- **Bookmark**: Preset có `bookmark` (tên) — view đã lưu người dùng chọn chủ động; preset không có bookmark = default view của scope.
- **Effective_Preset**: Preset hiệu lực cho (user, collection) sau khi gộp theo precedence + role inheritance.
- **Role_Chain**: Chuỗi role từ role của user lên các parent (`roles.parentId`) — dùng để kế thừa preset role.
- **Precedence**: user > role-gần > role-xa (parent) > global.

## Requirements

### Requirement 1: Resolution Effective_Preset

**User Story:** Là người dùng, tôi muốn mở một collection và thấy view mặc định phù hợp (của tôi, hoặc role tôi, hoặc hệ thống), để không phải cấu hình lại mỗi lần.

#### Acceptance Criteria

1. THE system SHALL hỗ trợ `GET /api/v1/presets/effective?collection=<name>` trả Effective_Preset cho user hiện tại theo Precedence: user-default → role-default (theo Role_Chain, gần trước xa) → global-default.
2. THE resolution SHALL dựng Role_Chain từ role của user lên parent qua `roles.parentId` (filter siteId); không có vòng lặp vô hạn (cycle guard).
3. THE resolution SHALL chỉ xét preset không-bookmark cho default view; bookmark được trả riêng (Req 2).
4. IF không có preset nào ở mọi scope, THEN THE response SHALL trả default rỗng/null rõ ràng (FE dùng default hệ thống).
5. Mọi query SHALL filter `siteId`.

### Requirement 2: Bookmark management

**User Story:** Là người dùng, tôi muốn lưu nhiều view có tên (bookmark) và chọn nhanh, để chuyển giữa các góc nhìn của cùng collection.

#### Acceptance Criteria

1. THE system SHALL hỗ trợ `GET /api/v1/presets/bookmarks?collection=<name>` trả các bookmark khả kiến cho user: bookmark user của họ + bookmark role (theo Role_Chain) + bookmark global.
2. THE tạo bookmark SHALL qua POST preset hiện có với `bookmark` set; user thường chỉ tạo được bookmark scope user; admin/role-manager tạo được bookmark scope role/global.
3. WHEN user xoá/sửa bookmark, THE system SHALL chỉ cho thao tác trên preset họ có quyền (user của họ; role/global cần quyền admin) — thiếu quyền → 403.
4. THE bookmark SHALL hiển thị scope badge (user/role/global) để biết nguồn.

### Requirement 3: Lưu/khôi phục view state

**User Story:** Là người dùng, tôi muốn thay đổi layout/filter/sort của collection được nhớ lại, để lần sau mở vẫn như cũ.

#### Acceptance Criteria

1. WHEN user thay đổi view state (layout, filter, search, columns/layoutOptions), THE Studio SHALL lưu vào user-default preset của collection (upsert scope user, bookmark=null) — debounce để không spam.
2. THE Studio SHALL áp Effective_Preset khi mở collection (Req 1) làm state khởi tạo.
3. THE user SHALL có nút "Reset to default" xoá user-default preset → quay về role/global default.

### Requirement 4: Quyền tạo preset role/global

**User Story:** Là quản trị viên, tôi muốn đặt view mặc định và bookmark cho cả role, để chuẩn hoá trải nghiệm team.

#### Acceptance Criteria

1. THE tạo/sửa/xoá preset scope `role` hoặc `global` SHALL yêu cầu quyền admin (hoặc quyền quản lý preset role).
2. THE tạo preset scope `user` cho user khác SHALL bị từ chối trừ admin (user thường chỉ thao tác preset của chính mình).
3. THE resolution + bookmark list SHALL nhất quán quyền: user chỉ thấy preset role áp cho role họ thuộc + global + user của họ.

### Requirement 5: UI presets/bookmark trong collection view

**User Story:** Là người dùng, tôi muốn chọn bookmark và quản lý view ngay trên trang collection, để làm việc theo góc nhìn ưa thích.

#### Acceptance Criteria

1. THE collection list view SHALL có bookmark switcher (dropdown) liệt kê bookmark khả kiến (scope badge) + "Default view" + "Save current as bookmark".
2. THE "Save as bookmark" SHALL mở dialog nhập tên + chọn scope (user luôn được; role/global nếu có quyền).
3. THE view state hiện tại (layout/filter/sort) SHALL phản ánh bookmark đang chọn; đổi state khi đang ở bookmark → hỏi lưu hoặc tạo bookmark mới (không ghi đè im lặng bookmark role/global).
4. THE admin SHALL có chỗ quản lý preset role/global (trong settings hoặc role detail) — danh sách + sửa/xoá.

### Requirement 6: Phối hợp FE↔BE & toàn vẹn

#### Acceptance Criteria

1. THE precedence + Role_Chain resolution SHALL nằm ở backend (`preset-service.ts`) — FE KHÔNG tự gộp scope (tránh lệch luật).
2. THE SDK SHALL có `getEffectivePreset(collection)`, `listBookmarks(collection)`, `saveUserView(collection, state)`, CRUD bookmark (backward-compatible).
3. THE view state shape (layout/layoutQuery/layoutOptions/filter/search) SHALL khớp cột bảng `presets` — không thêm field FE-only không persist được.
4. `pnpm typecheck` + `pnpm test` pass; mọi query filter siteId; response `{ data }`/`{ errors }`.
