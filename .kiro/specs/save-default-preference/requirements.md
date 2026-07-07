# Requirements Document

## Introduction

Tài liệu yêu cầu cho **Save-Action Default Preference** trong LumiBase — khả năng cấu hình hành vi mặc định của nút **Save** trên màn hình sửa nội dung (content edit form) của Studio, ưu tiên là **per-user preference** với fallback cấp site.

Bối cảnh (complaint thực tế kiểu Directus): "Khi đánh giá sản phẩm, nút save trên content là *save & return to list*. Điều này làm phiền writer. Có cách nào để mặc định nó thành *save and stay* không? Có thể là một user preference được không?". Mỗi writer có thói quen khác nhau: người sửa liên tục một item muốn ở lại form (*stay*), người tạo hàng loạt muốn *save and create new*, người duyệt lướt qua muốn *return to list*. Một mặc định cứng không thể làm hài lòng tất cả.

LumiBase đã có sẵn hạ tầng cho mô hình này — feature này **không thêm bảng/cột mới cho user**, mà tận dụng cơ chế đã có:

- `users.preferences` (JSONB, `packages/database/src/schema/core.ts:62`) đã tồn tại, mặc định `{}`, được mô tả là chứa `{ language, theme, timezone, defaultPresets }`. Key mới `saveAction` chỉ thêm vào object này.
- Mô hình kế thừa theme/appearance kiểu Directus đã được mã hoá ở `packages/shared/src/schemas/site-config.ts:5-11`: **SITE giữ default toàn cục** (appearance/theme/branding), **per-user override** sống trong `users.preferences` và đè lúc render. Feature mirror đúng pattern: site giữ một `defaultSaveAction`, user preference đè lên.
- Studio content edit form (`apps/studio/src/modules/content/item-detail.tsx`) hiện sau khi save **giữ nguyên ở form** (`saveMutation.onSuccess` chỉ invalidate query, không navigate — `item-detail.tsx:148-153`); nút "Save changes" ở `item-detail.tsx:268-282`. Hiện không có lựa chọn *return* hay *create new*.

Phạm vi feature: thêm enum `saveAction` vào preferences (persistence + validation), một default cấp site, logic phân giải kế thừa (resolve), hành vi điều hướng sau save trên form, một control split-button cho hành động one-off, và một trang settings để đổi mặc định cá nhân. **Ngoài phạm vi:** autosave/draft behaviour, keyboard shortcut binding, per-collection override (cân nhắc ở v2 — xem open question trong design).

## Glossary

- **Studio**: Ứng dụng Admin UI tại `apps/studio` (React + TanStack Router).
- **CMS**: Backend Hono tại `apps/cms` phục vụ REST API ở prefix `/api/v1`.
- **Save_Action**: Hành vi điều hướng sau khi lưu một item thành công, thuộc enum `'stay' | 'return' | 'create_new'`.
  - `stay` — ở lại form đang sửa (Directus "save and stay").
  - `return` — quay về danh sách collection (hành vi hiện tại — Directus "save and return to list").
  - `create_new` — lưu xong mở form tạo item mới trong cùng collection.
- **User_Save_Action**: Giá trị `Save_Action` cá nhân của một user, lưu tại `users.preferences.saveAction`.
- **Site_Default_Save_Action**: Giá trị `Save_Action` mặc định cấp site, áp cho user chưa đặt `User_Save_Action`. Lưu ở bảng `sites` (cột `default_save_action`) — mirror `defaultAppearance` (`core.ts:38`).
- **Effective_Save_Action**: Giá trị `Save_Action` thực sự áp dụng tại runtime, phân giải theo thứ tự ưu tiên: `User_Save_Action` → `Site_Default_Save_Action` → hằng số hardcode `'return'`.
- **Hardcoded_Fallback**: Giá trị cuối cùng khi cả user lẫn site đều không có cấu hình; cố định `'return'` để bảo toàn hành vi hiện hữu.
- **Preferences_Endpoint**: Endpoint CMS đọc/ghi `users.preferences` của chính user đang đăng nhập (dưới prefix `/api/v1/me`, cùng họ với `GET /api/v1/me` tại `apps/cms/src/routes/auth.ts:621`).
- **Save_Control**: Split-button (nút chính + dropdown) trên content edit form cho phép (a) lưu theo `Effective_Save_Action`, (b) chọn one-off một hành động khác, (c) đặt hành động vừa chọn làm mặc định cá nhân.
- **Preferences_Schema**: Zod schema cho `users.preferences` tại `packages/shared`, validate `saveAction` enum và bỏ qua key lạ (forward compat).

## Requirements

### Requirement 1: Lưu Save-Action preference cá nhân

**User Story:** Là một writer, tôi muốn đặt mặc định cho nút Save (ở lại / về danh sách / tạo mới), để mỗi lần lưu không bị điều hướng đi nơi tôi không muốn.

#### Acceptance Criteria

1. THE Preferences_Endpoint SHALL expose một endpoint authenticated `PATCH /api/v1/me/preferences` nhận body một phần (`partial`) và persist vào `users.preferences` của chính user đang đăng nhập, trả `{ data: <preferences đã merge> }`.
2. THE Preferences_Endpoint SHALL merge `saveAction` vào object `users.preferences` hiện có mà KHÔNG ghi đè các key khác (`language`, `theme`, `timezone`, `defaultPresets`).
3. THE Preferences_Endpoint SHALL scope ghi theo `userId` của request (`c.get('auth').userId`); một user không bao giờ ghi được preferences của user khác.
4. WHEN một user chưa từng đặt preference nào, THE Preferences_Endpoint SHALL ghi vào object mặc định `{}` (cột `preferences` mặc định `{}` per `core.ts:62`) mà không lỗi.
5. THE Preferences_Endpoint SHALL trả về preferences đã persist trong response, KHÔNG bao gồm `passwordHash`, `tfa`, hay bất kỳ trường nhạy cảm nào của bản ghi `users`.

### Requirement 2: Validate giá trị Save-Action

**User Story:** Là một developer, tôi muốn giá trị `saveAction` được validate chặt, để một giá trị sai không lọt vào DB và làm hỏng hành vi điều hướng của Studio.

#### Acceptance Criteria

1. THE Preferences_Schema SHALL định nghĩa `saveAction` là enum `z.enum(['stay', 'return', 'create_new'])` `.optional()`, đặt tại `packages/shared/src/schemas` và export type tương ứng.
2. WHEN body PATCH chứa `saveAction` không thuộc enum, THE Preferences_Endpoint SHALL từ chối với HTTP 422 và body `{ errors: [{ code: 'VALIDATION_ERROR', path: ['saveAction'] }] }`, không ghi DB.
3. WHEN body PATCH KHÔNG chứa key `saveAction`, THE Preferences_Endpoint SHALL giữ nguyên giá trị `saveAction` hiện có trong DB (partial update, không xoá).
4. WHEN một bản ghi `users.preferences` cũ thiếu key `saveAction` (forward compat), THE Preferences_Schema SHALL coi `saveAction` là `undefined` mà KHÔNG reject toàn bộ object (key vắng = chưa cấu hình).
5. THE Preferences_Schema SHALL bỏ qua (strip hoặc passthrough, theo quy ước schema hiện có) các key lạ không khai báo, để bản ghi preferences chứa trường tương lai không làm validation fail.

### Requirement 3: Default Save-Action cấp site

**User Story:** Là một admin, tôi muốn đặt một mặc định Save-Action cho cả site, để writer mới chưa cấu hình cá nhân vẫn nhận hành vi nhóm tôi mong muốn.

#### Acceptance Criteria

1. THE CMS SHALL lưu `Site_Default_Save_Action` ở cột `sites.default_save_action` (text, enum `'stay' | 'return' | 'create_new'`), mirror cột `defaultAppearance` (`core.ts:38`).
2. THE `sites.default_save_action` column SHALL có `DEFAULT 'return'` và `NOT NULL`, để mọi site (kể cả đã tạo trước) có giá trị hợp lệ tương đương hành vi hiện tại mà không cần can thiệp thủ công.
3. THE `SiteConfigSchema` (`packages/shared/src/schemas/site-config.ts:162`) SHALL thêm trường `defaultSaveAction: z.enum(['stay', 'return', 'create_new'])` để endpoint `GET/PATCH /api/v1/site` đọc/ghi được, mirror `defaultAppearance` (`site-config.ts:169`).
4. WHERE một site được cập nhật `defaultSaveAction` qua `PATCH /api/v1/site`, THE CMS SHALL validate enum và persist scoped theo `siteId` của request.
5. THE Studio Settings → Site page SHALL hiển thị một control chọn `defaultSaveAction` (mirror control `defaultAppearance` hiện có), kèm chú thích rằng per-user preference sẽ đè giá trị này.

### Requirement 4: Phân giải Effective Save-Action (kế thừa & fallback)

**User Story:** Là một writer, tôi muốn nút Save luôn hành xử nhất quán theo cấu hình của tôi nếu có, hoặc theo site nếu tôi chưa cấu hình, để không bao giờ rơi vào trạng thái không xác định.

#### Acceptance Criteria

1. THE Studio SHALL phân giải `Effective_Save_Action` theo thứ tự ưu tiên: `User_Save_Action` (nếu là enum hợp lệ) → `Site_Default_Save_Action` → `Hardcoded_Fallback` (`'return'`).
2. WHEN `users.preferences.saveAction` là `undefined` hoặc không thuộc enum hợp lệ, THE Studio SHALL bỏ qua nó và dùng `Site_Default_Save_Action`.
3. WHEN cả `User_Save_Action` lẫn `Site_Default_Save_Action` đều vắng/không hợp lệ, THE Studio SHALL dùng `Hardcoded_Fallback` `'return'` (bảo toàn hành vi hiện tại — `item-detail.tsx` save hiện ở lại form, nhưng `'return'` là mặc định an toàn được chọn; xem design open question về lựa chọn default).
4. THE phân giải `Effective_Save_Action` SHALL là một hàm thuần (pure) nhận `(userPref, siteDefault)` và trả một `Save_Action`, để unit test mọi tổ hợp không cần DB hay render.
5. THE Studio SHALL không bao giờ throw hay treo UI khi gặp giá trị preference lạ; mọi giá trị ngoài enum được xử lý như "chưa cấu hình".

### Requirement 5: Hành vi điều hướng sau khi save

**User Story:** Là một writer, tôi muốn nút Save thực thi đúng hành động tôi đã chọn (ở lại / về danh sách / tạo mới) sau khi lưu thành công, để workflow biên tập của tôi liền mạch.

#### Acceptance Criteria

1. WHEN một lần save item thành công AND `Effective_Save_Action='stay'`, THE Studio SHALL giữ nguyên ở content edit form, invalidate query của item/list như hiện tại (`item-detail.tsx:148-152`), và reset cờ dirty.
2. WHEN một lần save item thành công AND `Effective_Save_Action='return'`, THE Studio SHALL điều hướng về danh sách collection (`/content/$collection`, mirror điều hướng của `deleteMutation.onSuccess` tại `item-detail.tsx:161`).
3. WHEN một lần save item thành công AND `Effective_Save_Action='create_new'`, THE Studio SHALL điều hướng tới form tạo item mới trong cùng collection (route "new" của collection đang sửa).
4. WHEN save thất bại (mutation error), THE Studio SHALL giữ nguyên ở form, hiển thị lỗi (như `item-detail.tsx:286-288` hiện có), và KHÔNG điều hướng bất kể `Effective_Save_Action`.
5. THE điều hướng SHALL chỉ chạy trong nhánh `onSuccess` của save mutation, để không có race giữa invalidate query và navigation.

### Requirement 6: Save Control với one-off và đặt mặc định

**User Story:** Là một writer, tôi muốn thỉnh thoảng làm một hành động save khác mặc định của tôi, và đặt mặc định ngay tại chỗ, để không phải vào trang settings mỗi lần đổi ý.

#### Acceptance Criteria

1. THE Save_Control SHALL là một split-button: nút chính thực thi `Effective_Save_Action`, nhãn phản ánh hành động đó (ví dụ "Save & stay", "Save & return", "Save & create new").
2. THE Save_Control SHALL có một dropdown liệt kê cả ba `Save_Action`, cho phép user chọn one-off một hành động khác mà KHÔNG đổi `User_Save_Action` đã lưu.
3. THE Save_Control SHALL có một mục "Set as default" để đặt `Save_Action` vừa chọn làm `User_Save_Action` qua `PATCH /api/v1/me/preferences` (Req 1).
4. THE Save_Control SHALL disable mọi hành động khi form không dirty hoặc đang lưu hoặc user không có quyền update (giữ điều kiện `!isDirty || saveMutation.isPending || !canUpdate` tại `item-detail.tsx:271`).
5. WHEN user đặt mặc định mới qua "Set as default", THE Studio SHALL cập nhật state cục bộ ngay (optimistic) để nhãn nút chính phản ánh `Effective_Save_Action` mới mà không cần reload trang.

### Requirement 7: Trang Settings đổi mặc định cá nhân

**User Story:** Là một writer, tôi muốn một nơi trong settings để xem và đổi mặc định Save-Action của mình, để cấu hình một lần và quên đi.

#### Acceptance Criteria

1. THE Studio SHALL cung cấp một control trong khu vực settings cá nhân (account/preferences) để chọn `User_Save_Action` trong ba lựa chọn, kèm tuỳ chọn "Use site default" (xoá override cá nhân).
2. WHEN user chọn "Use site default", THE Studio SHALL gửi `PATCH /api/v1/me/preferences` đặt `saveAction` về `null`/bỏ key, để `Effective_Save_Action` rơi về `Site_Default_Save_Action`.
3. THE settings control SHALL hiển thị giá trị `Site_Default_Save_Action` hiện hành như nhãn của lựa chọn "Use site default" (ví dụ "Use site default (Return to list)"), để user biết mình sẽ kế thừa gì.
4. WHEN `PATCH /api/v1/me/preferences` thành công, THE Studio SHALL phản hồi trạng thái lưu (toast/inline) và đồng bộ giá trị hiển thị với DB.

### Requirement 8: Round-trip & forward compatibility

**User Story:** Là một developer, tôi muốn đọc–ghi preferences không làm mất dữ liệu key khác và không vỡ với bản ghi cũ, để feature an toàn khi rollout lên instance đang chạy.

#### Acceptance Criteria

1. FOR ALL giá trị `Save_Action` hợp lệ, ghi qua `PATCH /api/v1/me/preferences` rồi đọc lại (`GET /api/v1/me` hoặc preferences read) SHALL trả đúng giá trị vừa ghi (round-trip property).
2. WHEN một bản ghi `users.preferences` chứa các key có sẵn (`language`, `theme`, `timezone`, `defaultPresets`), THE Preferences_Endpoint SHALL bảo toàn nguyên vẹn các key đó sau khi ghi `saveAction` (merge, không replace toàn object).
3. WHEN một bản ghi `users.preferences` cũ KHÔNG có key `saveAction`, THE phân giải `Effective_Save_Action` SHALL rơi về site default/hardcoded mà không lỗi (Req 4) — instance cũ không cần backfill user rows.
4. WHEN body PATCH chứa key không nằm trong `Preferences_Schema`, THE Preferences_Endpoint SHALL không reject toàn request vì key lạ (Req 2.5).

### Requirement 9: Setup Impact Registry

**User Story:** Là một maintainer, tôi muốn feature này được rà soát theo Setup Impact Registry, để biết nó có yêu cầu khởi tạo gì khi setup instance mới hay backfill instance cũ không.

#### Acceptance Criteria

1. WHEN feature save-default-preference hoàn thành, THE feature SHALL được rà soát theo 6 câu hỏi trong `.kiro/specs/admin-setup-wizard/setup-impact.md` và ghi một dòng vào bảng Registry (kể cả `n/a`).
2. THE rà soát SHALL xác định: feature KHÔNG thêm bảng cần seed (dùng `users.preferences` JSONB sẵn có), KHÔNG thêm settings key bắt buộc, KHÔNG cần bước UI wizard mới, KHÔNG capability flag mới.
3. WHERE feature thêm cột `sites.default_save_action`, THE rà soát SHALL khẳng định cột có `DEFAULT 'return' NOT NULL` nên migration là additive idempotent (`ADD COLUMN IF NOT EXISTS`), instance cũ KHÔNG cần backfill (Req 3.2, 8.3); migration được viết tay theo quy ước repo cho migration 0032+ (không `drizzle-kit generate`).
