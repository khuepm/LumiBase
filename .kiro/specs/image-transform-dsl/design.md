# Design Document — Image Transform DSL

## Overview

Thêm on-the-fly image transform vào delivery (`GET /media/:key?...`), với adapter runtime (CF Images / Sharp) qua abstraction, cache theo tag (ADR-004), preset có tên, và signed transform chống abuse. Trục: **runtime abstraction** (không phân nhánh CF/Docker trong business logic), **DSL chung FE/BE** (Zod ở shared), **chặn abuse** (trần kích thước + signed/preset-only).

## Architecture

### DSL chung (`packages/shared/src/schemas/transform.ts`)

```ts
export const transformDslSchema = z.object({
  width: z.number().int().min(1).max(MAX_DIM).optional(),
  height: z.number().int().min(1).max(MAX_DIM).optional(),
  quality: z.number().int().min(1).max(100).optional(),
  format: z.enum(['webp','avif','jpeg','png']).optional(),
  fit: z.enum(['cover','contain','inside','outside']).optional(),
  focal: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
});
export type TransformDsl = z.infer<typeof transformDslSchema>;
export const MAX_DIM = 4000;                         // trần cấu hình (override qua settings)
export function transformKey(dsl: TransformDsl): string;   // hash ổn định → cache key + path segment
```

### Image_Adapter (runtime)

```ts
// runtime abstraction — runtime cung cấp adapter
export interface ImageAdapter {
  transform(source: ReadableStream|ArrayBuffer, dsl: TransformDsl): Promise<{ body: BodyInit; contentType: string }>;
}
// CF: dùng cf.image / Cloudflare Images resize
// Docker: dùng sharp(buffer).resize(...).toFormat(...)
```
Lấy qua `c.get('runtime').image` — thêm `image` vào runtime interface (`packages/runtime/src/`) bên cạnh `cache`/`storage`. Business logic KHÔNG biết CF hay Docker.

> **Cross-ref bảo mật (upload-file-controls task F1).** Cùng `ImageAdapter` này
> là nền cho tính năng **re-encode ảnh để sanitize** — chống polyglot ("ảnh cài
> shell") không false-positive bằng cách re-encode bản gốc, bóc mọi thứ trừ
> pixel. Khía cạnh xử lý ảnh ở spec này; khía cạnh bảo mật + quyết định
> sync-vs-async ở `docs/en/security/runtime-security-guards-plan.md` §3 và
> `.kiro/specs/upload-file-controls/tasks.md` (F1). Hiện guard đã chặn polyglot
> bằng deep byte-scan đồng bộ (`imageHasEmbeddedActivePayload`); re-encode là bản
> nâng cấp không-FP phụ thuộc adapter này.

### Preset store

Quyết định: **bảng mới `transformPresets`** (linh hoạt hơn settings key cho CRUD + per-site).
```ts
export const transformPresets = pgTable('transform_presets', {
  id: text('id').primaryKey(),                       // nanoid()
  siteId: text('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),                        // slug: 'hero', 'thumbnail'
  name: text('name').notNull(),
  dsl: jsonb('dsl').$type<TransformDsl>().notNull(),
  createdAt, updatedAt,
}, t => ({ uniq: uniqueIndex('transform_presets_key_unique').on(t.siteId, t.key) }));
```
Migration viết tay + journal. Seed preset mặc định `thumbnail` (300x300) để thay hardcoded → Setup Impact.

### Delivery flow (`media.ts`)

```
GET /media/:key?preset=hero | ?width=&height=&...&sig=
 1) parse params → nếu preset → load preset.dsl (siteId) ; else parse transformDslSchema
 2) nếu signedMode bật & không preset → verify HMAC(sig) trên params ; sai → 403
 3) nếu presetOnly bật & không preset → 403
 4) validate trần (MAX_DIM)
 5) cacheKey = `${key}:${transformKey(dsl)}` → runtime.cache.get
       hit → trả (Cache-Control + tag)
       miss → load gốc từ storage → runtime.image.transform(src, dsl) → cache.put(tag: file:<key>) → trả
 6) không param → ảnh gốc (backward-compatible)
```
Tag cache = `file:<key>` → khi PATCH/DELETE file gốc, invalidate tag → mọi biến thể bay (ADR-004).

### Routes preset

```
GET/POST /api/v1/transform-presets
PATCH/DELETE /api/v1/transform-presets/:id
```
filter siteId, permission admin/files, response `{ data }`/`{ errors }`.

### Signed transform

```
sig = HMAC_SHA256(secret, `${key}|${canonicalParams}`)  // secret per-site hoặc env
verify hằng-thời-gian; bật/tắt qua settings key `media.signedTransform` (default off cho dev, khuyến nghị on prod)
```

## Component tree (Studio `modules/files/`)

```
modules/files/
├─ media-detail.tsx (sửa) — preview + preset list (Copy URL) + Custom transform panel
├─ transform-panel.tsx (mới) — width/height/quality/format/fit + focal picker → preview live (dùng mediaUrl) + Copy URL
├─ focal-picker.tsx (mới) — click ảnh đặt focal {x,y} (0..1), preview fit=cover
└─ preset-manager.tsx (mới) — CRUD transform presets

SDK: mediaUrl(key, dslOrPreset, { sign? }) → URL transform (ghép params + sig nếu cần)
```

## Quyết định mở

1. **Preset store:** chọn bảng `transformPresets` (đã chốt trên). Nếu muốn nhẹ hơn → settings key; bảng linh hoạt hơn.
2. **Signed default:** off ở dev, on khuyến nghị prod; bounded MAX_DIM=4000 (override settings).
3. **AVIF support:** phụ thuộc adapter; nếu Sharp/CF không bật AVIF → fallback webp.
4. **Thumbnail hardcoded:** chuyển thành preset `thumbnail` mặc định; ảnh cũ vẫn đọc thumbnail cũ (không phá).

## Error handling

- Param sai/quá trần → 400 `{ errors }`.
- Preset không tồn tại → 404.
- Signed sai/thiếu (khi bật) → 403.
- Adapter lỗi format → fallback hoặc 400 rõ ràng.
- File gốc không tồn tại → 404 (giữ hành vi hiện tại).

## Testing strategy

- DSL schema: reject width > MAX_DIM, quality ngoài 1-100, format/fit lạ.
- `transformKey` ổn định (cùng dsl → cùng key bất kể thứ tự param).
- Delivery: transform đúng size/format (mock adapter); cache hit lần 2; invalidate tag khi file đổi.
- Signed: sig đúng pass, sai 403; preset-only chặn custom.
- Adapter: Docker Sharp resize đúng; CF adapter gọi đúng API (mock).
- FE: focal picker đặt {x,y}; mediaUrl ghép URL + sig đúng; preset-only ẩn custom.
