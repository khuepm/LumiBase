# Requirements Document — Content Preview (B102)

## Introduction

Biên tập viên hiện không xem được bản **draft** hiển thị trên website trước khi xuất bản. Nghiệm thu RC.3 (`docs/review-agent/2026-09-29-rc3-scaffold-acceptance.md`) chạy trọn luồng tạo → gửi duyệt → duyệt → xuất bản trong Studio, nhưng editor chỉ có **Share**, không có **Preview**. Người duyệt vì vậy phải duyệt nội dung dạng form, không phải dạng trang thật. Backlog: B102.

### Hiện trạng trong code (đã đọc, 2026-09-29)

- `GET /deliver/...` đã hiểu `?preview=true` / `?draft=true`, nhưng chỉ để **bỏ qua cache** (`apps/cms/src/routes/deliver.ts:481`). Nó không cấp quyền đọc draft.
- **Share links** (`apps/cms/src/routes/shares.ts`, `services/share-service.ts`, bảng `lumibase_shares`) đã có sẵn:
  - token lưu dạng hash, plaintext chỉ trả một lần;
  - `validFrom` / `validUntil`, `maxUses`, thu hồi;
  - quyền đọc = **giao** của role gắn với share và quyền của người tạo (`whereFor` của cả hai), có mask field.
- Hai ràng buộc hiện có của share chặn trường hợp preview:
  - Role của share **không được** có `adminAccess` hoặc `appAccess` (`assertShareRoleCanRead`).
  - Role public do starter tạo có `publishedOnly`, nên không đọc được draft.
- Starter Next.js chỉ có `app/page.tsx`, chưa có route preview và chưa dùng draft mode.

### Ngoài phạm vi

- Môi trường preview theo branch/deploy (epic #362, #352).
- Live preview đồng bộ từng phím gõ, hay chỉnh sửa trực quan (visual editing) trên trang.
- Preview cho Pages (`/deliver`). Có thể mở rộng sau theo cùng cơ chế token; spec này chỉ làm item của collection.

## Glossary

- **Preview_URL_Template**: chuỗi cấu hình theo collection, ví dụ `http://localhost:3000/api/preview?token={token}&slug={slug}`. Placeholder lấy từ item: `{id}`, `{slug}`, `{collection}`, `{locale}`, `{token}`.
- **Preview_Token**: token share với `purpose = 'preview'`, sống ngắn, gắn với một item. Đọc item theo quyền của **người tạo**, gồm cả draft nếu người tạo đọc được.
- **Preview_Consumer**: website của người dùng. Nó đổi Preview_Token lấy nội dung draft rồi bật chế độ draft của framework (Next.js `draftMode()`).

## Requirements

### Requirement 1 — Cấu hình Preview URL theo collection

**User story:** Là admin, tôi đặt URL preview cho một collection, để editor mở được đúng trang của item.

1. Collection SHALL lưu `meta.previewUrl` (chuỗi, tuỳ chọn). Mặc định không có, và khi đó Studio không hiện nút Preview.
2. WHEN lưu `meta.previewUrl`, THE CMS SHALL chỉ chấp nhận URL `http:` hoặc `https:` và chỉ các placeholder trong Glossary, nếu không thì trả 400 `VALIDATION`.
3. THE Data model UI SHALL cho sửa `previewUrl` ở phần cài đặt collection, kèm ví dụ placeholder.
4. `cms:bootstrap` của starter Next.js SHALL đặt `previewUrl` cho `posts`, trỏ về route preview của starter (Req 5).

### Requirement 2 — Token preview sống ngắn

**User story:** Là editor, tôi cần một link preview tự hết hạn và không mở rộng quyền của tôi.

1. `POST /api/v1/items/:collection/:id/preview` SHALL tạo Preview_Token cho **user principal** đang đăng nhập. API key và principal ẩn danh SHALL bị từ chối 403.
2. Người gọi SHALL có quyền `read` trên item đó. Không có quyền thì 403, và không tạo bản ghi nào.
3. Token SHALL hết hạn sau tối đa **15 phút**, cấu hình được bằng settings `preview.ttlSeconds`, trần 3600. `maxUses` mặc định 20.
4. Nội dung đọc qua token SHALL bằng **giao** của quyền người tạo tại thời điểm đọc và row filter của item. Token không bao giờ đọc được item khác, collection khác hay site khác.
5. Token preview SHALL NOT dùng được cho `GET /api/v1/shares/:token` thông thường và ngược lại, vì `purpose` khác nhau.
6. Tạo và dùng token SHALL được audit (`preview.created`, `preview.read`), không ghi token plaintext.
7. Mỗi request đọc bằng token SHALL trả `Cache-Control: no-store` và không đi qua app cache, edge cache hay search index.

### Requirement 3 — Đổi token lấy nội dung

**User story:** Là website, tôi đổi token lấy đúng bản đang được biên tập.

1. `GET /api/v1/preview/:token` (public, không cần bearer) SHALL trả `{ data: { collection, item } }`, trong đó item là bản hiện tại trong DB, gồm cả `status: 'draft'`.
2. Token hết hạn, bị thu hồi, vượt `maxUses` hoặc không tồn tại SHALL trả **cùng một** 404 với cùng một body, để không thành oracle phân biệt các trường hợp.
3. Người tạo mất quyền read (bị đổi role hoặc gỡ khỏi site) sau khi tạo token SHALL làm token trả 404 ở lần đọc kế tiếp.
4. Endpoint SHALL áp rate limit theo IP như các route public khác.

### Requirement 4 — Nút Preview trong Studio

**User story:** Là editor, tôi bấm Preview và thấy trang thật của bản draft.

1. WHEN collection có `meta.previewUrl` VÀ người dùng có quyền read, THE item editor SHALL hiện nút **Preview** cạnh Share.
2. WHEN bấm Preview trong lúc form còn thay đổi chưa lưu, THE Studio SHALL báo "Save your changes first." giống Submit for review, và không mở preview của bản cũ mà người dùng tưởng là bản mới.
3. WHEN bấm Preview, THE Studio SHALL gọi Req 2.1, thay placeholder và mở URL ở tab mới (`noopener`).
4. Lỗi tạo token SHALL hiện ngay trong editor, không mở tab trống.

### Requirement 5 — Preview trong starter Next.js

**User story:** Là người vừa cài starter, tôi preview được bài draft mà không phải tự viết code.

1. Starter SHALL có `app/api/preview/route.ts`. Route này nhận `token` và `slug`, gọi Req 3.1 **phía server**, bật `draftMode()` rồi redirect về trang bài.
2. Trang bài SHALL đọc bản draft bằng token khi đang ở draft mode, và bằng publishable key khi không ở draft mode. Token SHALL NOT xuất hiện trong HTML hay bundle phía client.
3. Starter SHALL có `app/api/exit-preview/route.ts` để tắt draft mode.
4. `cms:verify` SHALL kiểm thêm hai điều: token preview đọc được draft, và publishable key vẫn **không** đọc được draft đó.
5. Starter hiện chỉ có trang danh sách, nên SHALL thêm `app/posts/[slug]/page.tsx` làm đích của preview.

### Requirement 6 — Không thoái lui

1. Share link hiện có SHALL giữ nguyên hành vi, gồm ràng buộc role không có `appAccess`/`adminAccess`.
2. Public read bằng publishable key SHALL tiếp tục chỉ thấy item đã publish.
3. Route mới SHALL được phân loại theo DoD §2c: `/preview/:token` là public content plane có test khi `auth === undefined`; `/items/:c/:id/preview` là content plane dưới `withAuth`.
