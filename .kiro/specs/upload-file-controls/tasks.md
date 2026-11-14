# Implementation Plan — Upload File Controls

Quy ước: `[x]` xong · `[ ]` chưa · `[~]` một phần. Tuân thủ DoD
(`.kiro/steering/definition-of-done.md`), đặc biệt cập nhật Registry trung tâm
`.kiro/specs/admin-setup-wizard/setup-impact.md` (dòng #68) và `./setup-impact.md`.

Mỗi task ref `(Rx; design §…)`. Nguồn chân lý chi tiết: xem bảng ở
`./requirements.md`.

## Phase 1 — Guard hardening (PR #203) — **xong**

- [x] 1.1 Phủ `POST /api/v1/media/:key` trong `withFileUploadPolicy`; gom tập
  surface về `classifyUploadSurface()` + test hồi quy ghim (R1)
- [x] 1.2 Public block cho metadata-create + media-upload; loại trừ signed
  upload (JWT) (R2)
- [x] 1.3 Cap size theo **byte thật** của body cho surface bytes thô (R3.2)
- [x] 1.4 MIME allowlist + đuôi↔MIME + content-sniff magic bytes + chặn exe (R4.1–4.3)
- [x] 1.5 Chặn SVG nội dung động → `UPLOAD_UNSAFE_SVG` (R4.4)
- [x] 1.6 Serve media: `attachment` + `nosniff`; round-trip Content-Type qua R2/S3
  adapter + fallback metadata (R5)
- [x] 1.7 Test: guard (public/exe/svg/mime/size/happy), adapter round-trip

## Phase 2 — Cấu hình DB + UI (PR #203) — **xong**

- [x] 2.1 Catalogue + zod + helper dùng chung (`@lumibase/shared/schemas/upload-policy.ts`) (R6.4)
- [x] 2.2 `upload-policy-service`: resolve DB→env→default + cache + fail-safe; persist + invalidate (R6.1)
- [x] 2.3 `routes/uploads.ts`: `GET /uploads/config` (member) + `PUT` (site admin, catalogue-restricted) (R6.2)
- [x] 2.4 Studio Settings → Uploads + ràng `accept`/pre-check ở Files & Media (R6.3)
- [x] 2.5 SDK `uploads` resource; test service + route + guard-đọc-DB

## Phase 3 — Polyglot deep-scan (PR này) — **xong**

- [x] 3.1 `imageHasEmbeddedActivePayload()` quét toàn bộ bytes raster image tìm
  `<?php`/`<script`/`<html`/`<!doctype html`; reject `UPLOAD_EMBEDDED_PAYLOAD`
  (415) + audit `embedded_payload`. Đồng bộ, dual-runtime, không cửa sổ async
  (design § "Quyết định thiết kế")
- [x] 3.2 Test unit (marker detection) + middleware (PNG polyglot + PHP shell)

## Phase 4 — MIME sniffing, SVG sanitiser, polyglot corpus (#740, epic #674 S11) — **xong**

- [x] 4.1 `services/upload-security/content-sniff.ts`: `sniffContentKind` +
  `compareDeclaredMime` — loại khai báo phải khớp loại dò được; text không được
  là HTML/SVG/PHP; loại ngoài catalogue (env) không được là exe/HTML/SVG/PHP ngụy
  trang. Thêm Mach-O, `#!`.
- [x] 4.2 `detectPolyglot`: EOCD ZIP/JAR ở đuôi (GIFAR), marker markup trong
  ảnh/video, `%PDF-` trong 1 KiB đầu, dữ liệu sau PNG `IEND`, PDF có
  `/JavaScript`/`/JS`/`/Launch`/`/RichMedia`/URI `javascript:` (cả tên escape
  `#xx` và object stream Flate, giải nén có giới hạn) → `UPLOAD_EMBEDDED_PAYLOAD`
  / `UPLOAD_ACTIVE_PDF`.
- [x] 4.3 `svg-sanitizer.ts`: tokenizer allow-list, Workers-safe; upload reject
  khi có nội dung active (`UPLOAD_UNSAFE_SVG`), serve gỡ tham chiếu external;
  SVG sạch giữ nguyên từng byte. Transform in-process làm sạch nguồn SVG trước.
- [x] 4.4 `validateUploadFilename` (contracts): NUL/control, bidi override,
  traversal, chấm/khoảng trắng cuối, đuôi nguy hiểm ở mọi vị trí →
  `UPLOAD_UNSAFE_FILENAME` (guard + `POST /files/presigned-url`).
- [x] 4.5 `serve-policy.ts`: `inline` chỉ cho PNG/JPEG/GIF/WebP/AVIF/MP4/WebM,
  còn lại `attachment`; luôn `nosniff` + CSP `sandbox`; `filename*` RFC 5987.
  `withSecurityHeaders` giữ CSP riêng của route và thêm baseline (append).
- [x] 4.6 Catalogue thêm `video/mp4`, `video/webm` với `defaultEnabled: false`.
- [x] 4.7 Corpus sinh trong test (không blob nhị phân):
  `services/upload-security/__tests__/corpus.ts`; test qua guard thật trên cả hai
  surface bytes thô (`middleware/__tests__/file-upload-polyglot-corpus.test.ts`)
  chứng minh corpus bị chặn và file hợp lệ tới handler nguyên byte.
  Docs: `docs/{en,vi}/security/upload-security.md`.

## Nâng cấp tương lai (chưa làm)

- [ ] F1. **Re-encode ảnh để sanitize (chống polyglot không-FP).** Tải object →
  re-encode qua image adapter → ghi đè bản gốc, bóc mọi thứ trừ pixel. **Phụ
  thuộc** `ImageAdapter` (Sharp/CF Images) của `.kiro/specs/image-transform-dsl/`
  (design § "Image_Adapter"). Cần quyết định: chạy đồng bộ (chi phí CPU/native
  dep) hay async trong queue `media-processing` (chấp nhận cửa sổ file thô, đã
  giảm nhẹ bởi serve attachment+nosniff). Khía cạnh bảo mật ghi ở
  `docs/en/security/runtime-security-guards-plan.md` §3 (mục "Planned"). Khi làm:
  cross-ref hai chiều giữa spec này ↔ image-transform-dsl ↔ security-guards-plan.
- [ ] F2. (Tuỳ chọn) Hook quét virus/ClamAV ngoài cho tenant regulated — tham
  chiếu `.kiro/specs/regulated-content-readiness/` nếu triển khai.
- [ ] F3. (Tuỳ chọn) UI per-field `accept` trong field builder đọc từ catalogue
  chung (hiện `file` interface đã hỗ trợ `opts.accept` per-field, chưa có UI chọn).

## Setup impact

Xem `./setup-impact.md` (đánh giá cục bộ) + Registry trung tâm dòng #68. Kết luận:
`n/a` — không seed/bước wizard/migration bắt buộc; settings key mới `upload_policy`
dùng bảng `settings` sẵn có, vắng row → fallback env/default.
