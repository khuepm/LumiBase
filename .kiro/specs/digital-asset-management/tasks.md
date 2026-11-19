# Digital asset management parity — tasks (epic #670)

Nguồn: `.kiro/research/competitor-features-2026-07.md` (D01–D08). Doc người dùng:
`docs/en/features/digital-asset-management.md` (+ `docs/vi/`).

## Quyết định thiết kế

- **Replace giữ nguyên storage key** (không chỉ id): field `file` của Studio lưu
  `filename_disk` trong item data, đổi key là gãy tham chiếu. Byte cũ được chép
  sang `sites/<site>/file-versions/<id>/v<n>` trước, row chuyển version dưới
  optimistic lock, rồi mới ghi đè key sống; ghi lỗi ⇒ rollback row.
- **Phân quyền theo thư mục = rule policy trên collection `files`**, không thêm
  bảng ACL riêng: rule đánh giá trên `folder`, `folder_path` (`/a/b/`), `uploaded_by`,
  `mime`, `id`. Site admin bypass. Không có grant `files` ⇒ như trước (403).
- **"Dùng ở đâu" bằng khớp chuỗi con nguyên văn** trên `items.data::text` và
  `pages.layout_config::text` (không có FK để theo); báo thừa được, không báo thiếu.
- **Metadata parser thuần TS** (không native) để chạy trên cả Workers lẫn Node;
  gỡ GPS giữ nguyên độ dài/cấu trúc file (orientation còn nguyên).
- **Scanner là tài nguyên cấp deployment** (env), tenant chỉ bật/tắt cho site mình
  ⇒ không có bề mặt SSRF. Lỗi scanner mặc định fail closed.

## Tasks

- [x] D03 #703 — `PUT /files/:id/content`, versions + restore, purge cache file +
  collection tham chiếu, `GET /files/:id/content` (pin `?v=`), migration `0038_dam_assets`.
- [x] D06 #706 — `content_hash`, `GET /files/duplicates`, `GET /files/:id/usage`,
  safe delete (`deletePolicy` `confirm`/`block`), prompt trùng lặp trong Studio.
- [x] D05 #705 — EXIF/IPTC/XMP vào `metadata.embedded` + `searchText`, tìm kiếm
  thư viện, `stripGpsOnPublic` trên route phân phối.
- [x] D01 #701 — cây thư mục, đổi tên/di chuyển (chặn vòng), xoá thư mục rỗng,
  kéo-thả trong Studio, phân quyền theo thư mục qua rule `files`.
- [x] D02 #702 — hàng đợi upload (3 song song, retry/backoff, lỗi từng file,
  gộp thông báo tiến độ), `POST /files/bulk` + dialog sửa metadata hàng loạt.
- [x] D08 #708 — `MediaPicker` + `MediaPickerProvider`/`useMediaPicker`,
  `getStudioHost().openMediaPicker()` trong `@lumibase/extension-sdk`, field
  `file`/`files` dùng chung picker. Rich text (R03) chưa nhúng — chờ issue R03.
- [x] D07 #707 — `modules/malware-scan` (HTTP adapter, job quét, audit),
  gate `423` khi phân phối, `POST /files/:id/scan`, profile compose `malware-scan`.
- [x] D04 #704 — TUS 1.0 `/files/tus` (creation, termination, expiration) trên
  `MultipartStorage` (R2 + S3), bảng `lumibase_upload_sessions` + lease một-writer,
  sweeper `upload-expiry`, Studio dùng TUS cho file ≥ 32 MiB. Backlog B220 đã xong.
- [ ] D04 #704 — upload resumable (TUS / R2 multipart). **Chưa làm** — backlog B220.
- [ ] #871 video pipeline. Phần 2 (PR này): track phụ đề/caption WebVTT gắn
  locale (`lumibase_file_captions`, `/files/:id/captions`, loại upload `text/vtt`).
  Phần 1 (transcode, PR #937) và phần 3 (Studio) là PR riêng.

## Theo dõi sau

- B219 key upload có chữ ký chưa có tiền tố tenant (upload TUS đã dùng
  `sites/<site>/uploads/…`; đường presigned vẫn còn).
- B221 lọc rule `files` trong bộ nhớ (trần 5000 dòng) → biên dịch sang SQL.
- B222 sweeper quét lại file `pending` bị kẹt.
