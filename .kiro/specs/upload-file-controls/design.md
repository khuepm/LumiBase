# Design Document — Upload File Controls

## Overview

Thiết kế **mở rộng** hạ tầng sẵn có, không viết lại. Nguyên tắc: một guard duy
nhất chặn ở biên trước handler; catalogue đuôi/MIME là **một nguồn dùng chung**
server + client; cấu hình per-site qua DB với fallback fail-safe; serve an toàn
để nội dung đã lưu không thể render/exec dưới origin app.

> Chi tiết quy tắc enforce (đầy đủ, có completion criteria) là ở
> `docs/en/security/runtime-security-guards-plan.md` §3. Tài liệu này mô tả
> **kiến trúc + điểm chạm**, không lặp lại quy tắc.

## Architecture

### Bản đồ thành phần

```
┌───────────── Studio (apps/studio) ─────────────┐
│ settings/uploads-page.tsx  → chọn loại + max size│
│ files/index.tsx            → accept + pre-check   │
│        │ @lumibase/sdk (client.uploads)           │
└────────┼──────────────────────────────────────────┘
         ▼
┌───────────── CMS (apps/cms, Hono) ─────────────┐
│ middleware/file-upload-policy.ts  ← GUARD (mọi surface)  │
│   ├─ classifyUploadSurface()  (tập surface + test ghim)  │
│   ├─ public block · size(byte thật) · MIME · ext         │
│   ├─ content-sniff magic bytes · exe · unsafe SVG        │
│   └─ imageHasEmbeddedActivePayload()  ← polyglot scan     │
│ services/upload-policy-service.ts ← DB→env→default + cache│
│ routes/uploads.ts   GET config (member) · PUT (admin)     │
│ routes/media.ts     serve: attachment + nosniff + CT round │
└────────┬──────────────────────────────────────────────────┘
         │ shared catalogue (single source)
         ▼
  packages/shared/src/schemas/upload-policy.ts
  packages/runtime/src/adapters/{cloudflare,docker}/storage.ts (CT native field)
```

### Luồng enforce (guard)

Thứ tự trong `withFileUploadPolicy` (ref code cho chi tiết):
1. `classifyUploadSurface(path, method)` → bỏ qua nếu không phải upload surface.
2. Public block (metadata-create + media-upload; signed-upload loại trừ vì JWT).
3. Resolve policy (`resolveUploadPolicy`: DB→env→default, cache, fail-safe).
4. Size theo `Content-Length` → rồi **byte thật** của body (surface bytes thô).
5. MIME allowlist → đuôi↔MIME.
6. Content-sniff magic bytes; exe signature; **unsafe SVG**.
7. **Polyglot scan** (`imageHasEmbeddedActivePayload`) cho raster image: quét
   toàn bộ bytes tìm `<?php` / `<script` / `<html` / `<!doctype html`.

### Resolve + cache policy

`resolveUploadPolicy({ db, cache, siteId, env })`:
- Đọc cache `upload-policy:{siteId}` → nếu miss, đọc row `settings.upload_policy`
  (scope site) → nếu vắng/không hợp lệ, fallback env (`FILE_UPLOAD_*`) → default.
- **Fail-safe**: mọi lỗi (thiếu db/cache, DB down, value hỏng) → trả env/default,
  không throw, không fail-open. Nhờ đó guard chạy được cả trong test không có DB.

### Serve an toàn (media)

`GET /media/:key`: `Content-Disposition: attachment` + `X-Content-Type-Options:
nosniff`; `Content-Type = obj.contentType ?? obj.metadata?.contentType` (fallback
cho object cũ). Storage adapter map `contentType` sang field native (R2
`httpMetadata` / S3 `ContentType`) để round-trip.

### Single source: catalogue

`@lumibase/shared/schemas/upload-policy.ts` giữ `UPLOAD_TYPE_CATALOGUE`,
`DEFAULT_*`, `MIME_EXTENSIONS`, helper (`resolveMaxBytes`, `resolveMimeAllowlist`,
`isMimeAllowed`, `extensionMatchesMime`, `acceptAttribute`), và
`UploadPolicyConfigSchema`/`UploadPolicyUpdateSchema`. Guard (server) và picker
(client) đều import từ đây → không lệch.

## Ranh giới runtime

Guard + polyglot scan là **pure bytes**, chạy đồng bộ trước storage write, giống
nhau trên CF Workers và Docker (không native dep, không cửa sổ async). Serve +
storage round-trip đi qua `StorageProvider` abstraction (không import binding CF
trong business logic — Strict Rule #3).

## Quyết định thiết kế: polyglot scan (sync) vs re-encode (deferred)

- **Đã chọn (làm ngay):** deep content-scan đồng bộ tại guard. Ưu: dual-runtime,
  không cửa sổ async, không native dep, testable. Nhược: heuristic theo marker →
  FP cực hiếm (một ảnh thật chứa đúng chuỗi `<?php` theo xác suất ~1e-5). Đã thu
  hẹp scope về raster image + tập marker high-signal để giảm FP; và serve
  attachment+nosniff đã trung hoà phần lớn vector render.
- **Hoãn (tracked):** **re-encode ảnh** để bóc mọi thứ trừ pixel — cách chống
  polyglot không-FP. Không làm ngay vì: (a) `MediaProcessor` hiện chỉ **sinh URL
  transform** (imgproxy/CF Image Resizing), chưa có pipeline tải→re-encode→ghi
  đè; (b) native `sharp` chỉ chạy Docker; (c) làm async sẽ tạo cửa sổ file thô
  nằm trong storage. Việc này phụ thuộc `ImageAdapter` (Sharp/CF Images) của spec
  `image-transform-dsl` và cần quyết định kiến trúc riêng. Xem `./tasks.md` §
  "Nâng cấp tương lai" + cross-ref `.kiro/specs/image-transform-dsl/` và
  `docs/en/security/runtime-security-guards-plan.md`.

## Mã lỗi (ref)

`PUBLIC_UPLOAD_FORBIDDEN` (403) · `UPLOAD_TOO_LARGE` (413) ·
`UPLOAD_MIME_FORBIDDEN` / `UPLOAD_EXTENSION_MISMATCH` / `UPLOAD_CONTENT_MISMATCH`
/ `UPLOAD_UNSAFE_SVG` / `UPLOAD_EMBEDDED_PAYLOAD` (415). Audit event chung:
`file_upload_policy_denied` với `reason` tương ứng.
