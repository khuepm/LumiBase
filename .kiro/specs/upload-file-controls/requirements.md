# Requirements Document — Upload File Controls

## Introduction

Kiểm soát tệp tải lên cho LumiBase: đảm bảo mọi đường ghi bytes vào storage đều
đi qua một lớp guard thống nhất (chặn public role, giới hạn định dạng/kích thước,
content-sniff, chặn nội dung động), và cho admin cấu hình allowlist per-site qua
UI. Mục tiêu bảo mật: **hạ tầng chặn lạm dụng lưu mã độc bất kể logic ứng dụng
(kể cả do AI viết) có sơ hở**.

Tính năng đã được triển khai và merge trong **PR #203**. Tài liệu này là **hub**
(spec/design/tasks) gom các artifact rải rác thành một khối — theo nguyên tắc
**single source of truth**, nó **tham chiếu** tới nguồn chân lý thay vì sao chép.

## Nguồn chân lý (single source — đừng sao chép, hãy ref)

| Mối quan tâm | Nguồn chân lý |
|---|---|
| Quy tắc enforce guard (chi tiết, checklist, completion criteria) | `docs/en/security/runtime-security-guards-plan.md` §3 "File upload policy" (+ `docs/vi/...`) |
| Thứ tự chuỗi middleware/guard | `docs/en/security/route-guards.md` |
| Catalogue đuôi/MIME + zod + helper (dùng chung server + client) | `packages/shared/src/schemas/upload-policy.ts` |
| Logic guard | `apps/cms/src/middleware/file-upload-policy.ts` |
| Resolve/persist policy (DB→env→default, cache) | `apps/cms/src/services/upload-policy-service.ts` |
| Endpoint cấu hình | `apps/cms/src/routes/uploads.ts`; ref API: `docs/en/api/hono-api-spec.md` §6 |
| Serve media an toàn + round-trip Content-Type | `apps/cms/src/routes/media.ts`; adapters `packages/runtime/src/adapters/{cloudflare,docker}/storage.ts` |
| UI cấu hình + picker | `apps/studio/src/modules/settings/uploads-page.tsx`; `apps/studio/src/modules/files/index.tsx` |
| Đánh giá setup impact | mục cục bộ tại `./setup-impact.md`; **Registry trung tâm**: `.kiro/specs/admin-setup-wizard/setup-impact.md` dòng #68 |

## Glossary

- **Upload_Surface**: đường request có thể ghi bytes/tạo metadata upload. Tập
  hiện tại (gom về `classifyUploadSurface()`): `POST /api/v1/files` (metadata),
  `PUT /api/v1/files/upload/:key` (signed bytes), `POST /api/v1/media/:key`
  (media bytes).
- **Upload_Policy**: cấu hình hiệu lực `{ maxBytes, allowedMimeTypes }` của một
  site.
- **Type_Catalogue**: danh mục loại file platform biết validate an toàn (MIME →
  extensions + label), tại `@lumibase/shared/schemas`.
- **Content_Sniffing**: kiểm tra magic bytes thực tế của payload thay vì tin
  `Content-Type` client khai.
- **Active_SVG**: SVG nhúng script/handler/entity có thể thực thi khi render.

## Requirements

### R1 — Mọi upload surface đi qua guard
- **R1.1** Guard `withFileUploadPolicy` PHẢI chạy trước handler trên mọi
  Upload_Surface; tập surface tập trung ở `classifyUploadSurface()` và được ghim
  bởi test hồi quy.
- **R1.2** Thêm route nhận-bytes mới mà không phân loại trong
  `classifyUploadSurface()` PHẢI làm test hồi quy fail.

### R2 — Chặn public role
- **R2.1** Public role (không auth / role rỗng / `public`/`$public`) KHÔNG được
  tạo metadata upload hoặc đẩy bytes media; bị `403 PUBLIC_UPLOAD_FORBIDDEN` +
  audit `file_upload_policy_denied`.
- **R2.2** Signed upload (`/files/upload/*`) được loại trừ khỏi kiểm tra public
  (authZ bằng JWT); áp public block ở đây sẽ chặn nhầm mọi signed upload.

### R3 — Giới hạn kích thước
- **R3.1** Vượt cap PHẢI bị `413 UPLOAD_TOO_LARGE`.
- **R3.2** Với surface nhận bytes thô, cap PHẢI kiểm theo **số byte thật của
  body**, không chỉ `Content-Length` do client khai.

### R4 — Giới hạn định dạng + validate nội dung
- **R4.1** MIME ngoài allowlist → `415 UPLOAD_MIME_FORBIDDEN`.
- **R4.2** Đuôi file không khớp MIME → `415 UPLOAD_EXTENSION_MISMATCH`.
- **R4.3** Bytes không khớp magic bytes của MIME khai báo → `415
  UPLOAD_CONTENT_MISMATCH`; signature executable (PE/ELF/Mach-O) bị chặn thẳng.
- **R4.4** SVG chứa nội dung động (`<script>`, `on*=`, `javascript:`,
  `<foreignObject>`, `<iframe>`/`<embed>`, `<!DOCTYPE>`/`<!ENTITY>`) → `415
  UPLOAD_UNSAFE_SVG`.

### R5 — Serve an toàn
- **R5.1** Media trả về PHẢI kèm `Content-Disposition: attachment` +
  `X-Content-Type-Options: nosniff` để không render/exec inline dưới origin app.
- **R5.2** `Content-Type` PHẢI round-trip đúng qua cả hai storage adapter (R2
  `httpMetadata` / S3 `ContentType`); object cũ fallback về custom metadata.

### R6 — Cấu hình per-site (DB) + UI
- **R6.1** Upload_Policy resolve theo thứ tự **DB (settings `upload_policy`) →
  env (`FILE_UPLOAD_*`) → default**; resolve fail-safe (không throw, không
  fail-open) khi DB/cache không sẵn sàng.
- **R6.2** `GET /api/v1/uploads/config` trả policy hiệu lực + catalogue cho mọi
  member (để UI ràng `accept`); `PUT` chỉ site admin, chỉ nhận MIME trong
  catalogue.
- **R6.3** Studio có trang **Settings → Uploads** để chọn loại file + max size;
  ô upload ràng `accept` và pre-check theo policy.
- **R6.4** Catalogue là **một nguồn dùng chung** server + client (Type_Catalogue)
  để allowlist và picker không lệch nhau.

## Acceptance criteria (đã đạt — xem `./tasks.md`)

Toàn bộ R1–R6 đã có test tự động (guard/service/route + adapter round-trip) và
tài liệu tương ứng; xem trạng thái chi tiết trong `./tasks.md`.
