# Requirements Document — Content Versioning

## Introduction

Directus có **content versioning** mức item: nhiều named version song song của cùng một item (như nhánh draft), diff giữa version với main, và promote một version thành main. LumiBase đã có hạ tầng **revisions** (lịch sử tuyến tính, append-only) nhưng chưa có *named branches* song song.

Spec này thêm lớp **named versions** trên nền revisions sẵn có — KHÔNG thay thế revisions. Revisions vẫn là provenance log; versions là không gian làm việc song song (draft branch) có tên, để biên tập viên soạn thay đổi lớn mà không đụng bản live, so sánh, rồi promote.

Hiện trạng tận dụng được (xác minh trong codebase):
- Bảng `revisions` (`packages/database/src/schema/cms.ts:217-259`) — delta JSONB, parentId, provenance đầy đủ.
- `GET /items/:collection/:id/revisions` + `POST /items/:collection/:id/revert/:revisionId` (`apps/cms/src/routes/items.ts:197-222`).
- `RevisionsDiff` (`apps/studio/src/modules/content/revisions-diff.tsx:26-41`) — field-level diff, tái dùng làm Version_Diff.
- `RevisionsPanel` (`apps/studio/src/modules/content/revisions-panel.tsx`) — panel có toggle `diff | raw`.
- SDK `RevisionRow` (`packages/sdk/src/types.ts:466-488`).

## Glossary

- **Version**: Một bản nhánh có tên của một item, lưu snapshot data tách khỏi bản main (live). Item có 0..n version.
- **Main**: Trạng thái live của item (row trong `items`). Version KHÔNG ảnh hưởng main cho tới khi promote.
- **Promote**: Áp data của một Version lên Main (ghi một revision provenance), rồi đóng/xoá Version.
- **Version_Diff**: Diff field-level giữa data của Version và Main — render bằng `RevisionsDiff` hiện có.
- **Revision**: Bản ghi lịch sử append-only đã tồn tại; KHÔNG đổi nghĩa trong spec này.

## Requirements

### Requirement 1: Mô hình dữ liệu Version

**User Story:** Là biên tập viên, tôi muốn tạo nhiều bản nháp có tên cho một item, để soạn thay đổi lớn song song mà không đụng bản đang live.

#### Acceptance Criteria

1. THE system SHALL có bảng `contentVersions` với cột: `id` (nanoid), `siteId`, `itemId`, `collectionId`, `key` (slug ổn định), `name` (nhãn người đọc), `data` (JSONB snapshot), `hash` (sha của data lúc tạo, để phát hiện main đã đổi), `createdBy` (userId), `createdAt`, `updatedAt`.
2. THE bảng `contentVersions` SHALL có unique index trên `(siteId, collectionId, itemId, key)` và index trên `(siteId, itemId)`.
3. THE migration SHALL được viết tay (theo [[migrations-are-hand-written]]) kèm sửa journal — KHÔNG dùng drizzle-kit generate.
4. Mọi query version SHALL filter theo `siteId` (multi-tenancy, non-negotiable rule CLAUDE.md).

### Requirement 2: API quản lý Version

**User Story:** Là client/Studio, tôi muốn CRUD version qua REST, để hiển thị và thao tác nhánh nội dung.

#### Acceptance Criteria

1. THE system SHALL hỗ trợ `GET /api/v1/items/:collection/:id/versions` — liệt kê version của item (kèm `key`, `name`, `createdBy`, `updatedAt`, cờ `mainChanged` = `hash` khác hash hiện tại của main).
2. THE system SHALL hỗ trợ `POST /api/v1/items/:collection/:id/versions` body `{ key, name }` — tạo version, snapshot `data` = bản main hiện tại; trả 409 nếu `key` trùng.
3. THE system SHALL hỗ trợ `GET /api/v1/items/:collection/:id/versions/:key` — trả 1 version đầy đủ (data).
4. THE system SHALL hỗ trợ `PATCH /api/v1/items/:collection/:id/versions/:key` body `{ data?, name? }` — cập nhật snapshot/nhãn của version (KHÔNG đụng main); cập nhật `updatedAt`.
5. THE system SHALL hỗ trợ `DELETE /api/v1/items/:collection/:id/versions/:key` — xoá version.
6. Mọi endpoint SHALL trả `{ data: T }` hoặc `{ errors: [...] }` (response format CLAUDE.md) và chịu permission check như mutate item (reuse PermissionService của items route).

### Requirement 3: So sánh và promote

**User Story:** Là biên tập viên, tôi muốn xem version của tôi khác main ở field nào và promote nó thành live, để xuất bản thay đổi đã soạn.

#### Acceptance Criteria

1. THE system SHALL hỗ trợ `GET /api/v1/items/:collection/:id/versions/:key/compare` — trả `{ main, version, changes }` nơi `changes` là mảng field-diff (cùng shape `Change` của `revisions-diff.tsx`: `{ key, state, before, after }`).
2. THE system SHALL hỗ trợ `POST /api/v1/items/:collection/:id/versions/:key/promote` — áp `version.data` lên main qua **ItemService.update** (để revision + cache invalidation + RLS chạy đúng), ghi một revision với `authorType='human'`, rồi xoá version đó; trả item đã cập nhật.
3. IF khi promote phát hiện main đã đổi kể từ lúc tạo version (`hash` không khớp main hiện tại), THEN THE response SHALL kèm cảnh báo `meta.mainDiverged=true` nhưng vẫn cho promote (last-write-wins; UI cảnh báo ở Req 4.5).
4. Promote SHALL đi qua HITL nếu collection/skill yêu cầu (giữ nguyên hành vi mutate item hiện hành — KHÔNG bypass `ai_approvals`).

### Requirement 4: UI Versions trên content editor

**User Story:** Là biên tập viên, tôi muốn chuyển giữa các version ngay trong editor, thấy diff và promote bằng một nút, để làm việc với nhánh nội dung mà không rời màn editor.

#### Acceptance Criteria

1. THE item editor SHALL có Version switcher (dropdown) hiển thị "Main" + danh sách version; chọn version load `data` của nó vào editor ở chế độ chỉnh sửa version (lưu gọi PATCH version, KHÔNG gọi update item).
2. THE Version switcher SHALL có hành động "New version" (mở dialog nhập `name`; `key` auto-slug từ name, sửa được) và "Delete version".
3. WHEN đang ở một version, THE editor SHALL hiển thị nút "Compare with main" mở panel Version_Diff (tái dùng `RevisionsDiff`) và nút "Promote to main".
4. WHEN đang ở một version, THE editor SHALL có banner phân biệt rõ "Đang chỉnh version «name», chưa ảnh hưởng bản live".
5. IF `mainChanged=true` (main đã đổi từ lúc tạo version), THEN THE editor SHALL hiển thị cảnh báo trong banner và trong dialog promote trước khi xác nhận.
6. THE SDK SHALL được mở rộng (backward-compatible) với type `ContentVersion` và các method `listVersions/createVersion/getVersion/updateVersion/deleteVersion/compareVersion/promoteVersion` để Studio không gọi fetch thô.

### Requirement 5: Phối hợp FE↔BE & toàn vẹn

#### Acceptance Criteria

1. Type `Change` dùng ở compare API (BE) và `RevisionsDiff` (FE) SHALL giống nhau về shape — nếu lệch, SDK type là nguồn truth và FE/BE phải khớp nó.
2. WHEN promote thành công, THE FE SHALL invalidate cả query item, query revisions, và query versions (version vừa promote biến mất, revision mới xuất hiện).
3. THE feature SHALL không phá vỡ revisions hiện có: revisions tiếp tục ghi như cũ; versions là bảng/route/UI tách biệt.
