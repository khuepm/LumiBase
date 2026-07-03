# Requirements Document — Image Transform DSL

## Introduction

Directus cho phép transform ảnh on-the-fly qua URL params (`?width=300&quality=80&format=webp&fit=cover`), với **stored transforms** (preset có tên) và focal point. LumiBase hiện CHỈ có thumbnail hardcoded (150/300/600) sinh fire-and-forget khi upload (`apps/cms/src/routes/media.ts`), KHÔNG có on-the-fly transform DSL.

Spec này thêm **Image Transform DSL**: tham số transform trên URL delivery, transform-key đã ký để chống abuse, cache theo tag (ADR-004), preset transform có tên, và adapter runtime (Cloudflare Images cho CF / Sharp cho Docker — qua runtime abstraction).

Hiện trạng tận dụng được (xác minh trong codebase):
- Bảng `files` (`packages/database/src/schema/platform.ts:41-65`): width, height, metadata JSONB.
- `media.ts` (`apps/cms/src/routes/media.ts`): `GET /media/:key` download (Content-Type/Length), `POST /media/:key` upload + enqueue thumbnail (sizes hardcoded 150/300/600, queue `media-processing`/`generate-thumbnails`).
- `deliver.ts` (`apps/cms/src/routes/deliver.ts`): "1-Roundtrip Rule".
- `files.ts` (`apps/cms/src/routes/files.ts`): CRUD file record + presigned-url.
- Runtime abstraction (ADR-002): `c.get('runtime')` cho cache/storage; KHÔNG import CF binding trong business logic.
- Tag-based cache invalidation (ADR-004).

## Glossary

- **Transform_DSL**: Tập tham số biến đổi ảnh: `width`, `height`, `quality`, `format` (`webp|avif|jpeg|png`), `fit` (`cover|contain|inside|outside`), `focal` (`x,y`).
- **Transform_Key**: Chuỗi mô tả một bộ transform (vd hash của params) dùng làm cache key + path segment.
- **Transform_Preset**: Bộ Transform_DSL có tên, cấu hình per-site (vd `thumbnail`, `hero`).
- **Image_Adapter**: Adapter runtime thực hiện transform: Cloudflare Images (CF) / Sharp (Docker).
- **Signed_Transform**: Transform params kèm chữ ký (HMAC) để chặn việc tạo vô hạn biến thể (abuse/DoS).

## Requirements

### Requirement 1: Transform DSL trên URL delivery

**User Story:** Là frontend dev, tôi muốn lấy ảnh ở kích thước/định dạng mong muốn bằng query params, để không cần pre-generate mọi biến thể.

#### Acceptance Criteria

1. THE system SHALL hỗ trợ `GET /media/:key?width=&height=&quality=&format=&fit=&focal=` trả ảnh đã transform với `Content-Type` đúng format đích.
2. THE params SHALL được validate (width/height ≤ trần cấu hình, quality 1-100, format/fit trong enum); param lỗi → 400 `{ errors }`.
3. WHEN không có param transform, THE endpoint SHALL trả ảnh gốc (hành vi hiện tại giữ nguyên — backward-compatible).
4. THE response SHALL có `Cache-Control` phù hợp và transform được cache (Req 4).

### Requirement 2: Image adapter qua runtime abstraction

**User Story:** Là maintainer, tôi muốn transform chạy đúng trên cả CF và Docker, để dual-deployment không phân nhánh trong business logic.

#### Acceptance Criteria

1. THE system SHALL có `Image_Adapter` interface với `transform(input, dsl): Promise<{ body, contentType }>`.
2. THE CF adapter SHALL dùng Cloudflare Images / `cf.image` resize; THE Docker adapter SHALL dùng Sharp.
3. THE business logic (route/service) SHALL gọi adapter qua `c.get('runtime')` — KHÔNG import CF binding trực tiếp (ADR-002).
4. WHEN một format đích không hỗ trợ bởi adapter, THE system SHALL fallback format an toàn (vd jpeg) hoặc trả 400 rõ ràng.

### Requirement 3: Transform presets có tên

**User Story:** Là quản trị viên, tôi muốn định nghĩa preset transform có tên (vd `hero`), để FE chỉ tham chiếu tên thay vì lặp params và để kiểm soát biến thể.

#### Acceptance Criteria

1. THE system SHALL lưu Transform_Preset per-site (bảng mới `transformPresets` HOẶC settings key — quyết định ở design): `key`, `name`, `dsl` (Transform_DSL).
2. THE `GET /media/:key?preset=hero` SHALL áp DSL của preset; preset không tồn tại → 400/404.
3. THE system SHALL có API quản lý preset (`GET/POST/PATCH/DELETE`) filter siteId, response `{ data }`/`{ errors }`.
4. IF chế độ "chỉ-preset" được bật (settings), THEN THE on-the-fly params tuỳ ý SHALL bị từ chối — chỉ preset hợp lệ được transform (chống abuse).

### Requirement 4: Cache + chống abuse

**User Story:** Là maintainer, tôi muốn transform được cache và không cho phép tạo vô hạn biến thể, để tránh DoS và chi phí tính toán.

#### Acceptance Criteria

1. THE ảnh đã transform SHALL được cache theo Transform_Key qua runtime cache, gắn tag để invalidate khi file gốc đổi/xoá (ADR-004 tag-based invalidation).
2. WHEN file gốc bị cập nhật/xoá, THE mọi biến thể transform của nó SHALL bị invalidate qua tag.
3. THE system SHALL hỗ trợ Signed_Transform (HMAC) — khi bật, on-the-fly params phải kèm chữ ký hợp lệ; thiếu/sai chữ ký → 403.
4. THE width/height SHALL bị chặn trần (cấu hình) để chặn upscale vô lý / kích thước khổng lồ.

### Requirement 5: UI media với transform

**User Story:** Là biên tập viên, tôi muốn xem preview các kích thước/preset của một ảnh và copy URL transform, để dùng trong nội dung.

#### Acceptance Criteria

1. THE media detail (Studio `modules/files/`) SHALL hiển thị preview ảnh + danh sách Transform_Preset, mỗi preset có nút "Copy URL" (URL transform, kèm chữ ký nếu bật).
2. THE media detail SHALL có panel "Custom transform" (chỉnh width/height/quality/format/fit, focal point picker) hiển thị preview live và copy URL.
3. WHEN chế độ chỉ-preset bật, THE panel custom SHALL ẩn/disabled.
4. THE focal point picker SHALL cho click lên ảnh đặt `focal x,y` và preview `fit=cover` theo focal.

### Requirement 6: Phối hợp FE↔BE & toàn vẹn

#### Acceptance Criteria

1. THE Transform_DSL type + validate schema SHALL dùng chung FE/BE (`@lumibase/shared`, Zod) — FE chỉ sinh params hợp lệ.
2. THE SDK SHALL có helper `mediaUrl(key, dsl|presetKey)` (kèm ký nếu cần) để FE không tự ghép URL sai.
3. THE thumbnail hardcoded hiện có SHALL được giữ hoặc chuyển thành preset mặc định (không phá vỡ ảnh đã có thumbnail).
4. `pnpm typecheck` + `pnpm test` pass; runtime abstraction tuân thủ; mọi query filter siteId; response `{ data }`/`{ errors }`.
