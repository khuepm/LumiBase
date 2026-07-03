# Design Document — Translation Memory UI

## Overview

Backend TM đã đủ (service + fuzzy match + pipeline + routes). Spec này tập trung FE và vài endpoint quản lý còn thiếu: hoàn thiện TM page (PATCH/DELETE + phân trang), tích hợp TM suggestion + auto-translate vào content editor, side-by-side locale editing, completion %. Trục: **tái dùng `/tm/lookup` và `/tm/translate` sẵn có**; chỉ thêm UI + endpoint CRUD còn thiếu; threshold default 75 là hằng chung.

## Architecture

### Endpoint bổ sung (`apps/cms/src/routes/translation-memory.ts`)

```
(giữ) GET /api/v1/tm, POST /api/v1/tm, POST /api/v1/tm/lookup, POST /api/v1/tm/translate
+ PATCH  /api/v1/tm/:id      sửa targetText/quality/context (filter siteId)
+ DELETE /api/v1/tm/:id
+ GET /api/v1/tm hỗ trợ limit/offset + meta phân trang
```
Permission: reuse guard translations/admin.

### Hằng chung threshold (`packages/shared`)

```ts
export const TM_DEFAULT_THRESHOLD = 75;   // dùng ở service bestMatch default VÀ FE lookup default
```
Service `bestMatch(..., threshold = TM_DEFAULT_THRESHOLD)` import từ shared (đảm bảo không lệch).

### SDK (`packages/sdk`)

```ts
export interface TmEntry { id; siteId; sourceLang; targetLang; sourceText; targetText; context?; quality; source; provider?; hits; updatedAt }
export interface TmSuggestion { targetText: string; similarity: number; source: TmEntry['source']; entryId?: string }
// methods: listTm(filter), upsertTm(input), updateTm(id, patch), deleteTm(id), lookupTm(input), translate(input)
```
Backward-compatible (chỉ thêm).

## Component tree (Studio `modules/translations/` + `modules/content/`)

```
modules/translations/
├─ tm-page.tsx (hoàn thiện)
│   ├─ TmTable — list + lọc lang pair/source + search; sửa/xoá; phân trang; empty state
│   ├─ UpsertForm (giữ)
│   └─ LookupPanel (giữ)
modules/content/
├─ item-detail.tsx (sửa) — thêm Translation mode toggle + locale selector
├─ translation-mode.tsx (mới) — side-by-side source|target cho mỗi Translatable_Field + Completion_Pct
├─ tm-suggest-popover.tsx (mới) — focus field → /tm/lookup (debounce) → suggestion (similarity% + source badge) + Apply; "Auto-translate" → /tm/translate
└─ translatable-fields.ts (helper) — xác định field nào translatable từ schema collection
```

### Luồng suggestion (sequence)

```
focus target field (locale=fr), source(en) có text
  → debounce 300ms → SDK.lookupTm({ sourceLang:en, targetLang:fr, text, threshold:75 })
      BE: bestMatch trên translation_memory (siteId) → [{targetText, similarity, source}]
  → popover hiển thị suggestion (sắp theo similarity desc)
  Apply → set field value; mark dirty + source=human (để Req6.1 upsert khi save)
  Không có match ≥75 → nút Auto-translate → SDK.translate(...) (TM→glossary→MT) → fill, source=mt
huỷ request cũ khi text đổi (AbortController / React Query)
```

### Lưu lại TM khi save (Req 6.1)

```
Save item (Translation mode) → lưu bản dịch qua cơ chế đa ngữ hiện hành (translations route)
  → nếu cấu hình bật "learn TM": với mỗi field human-edited → SDK.upsertTm({source:human, quality:100})
```
Cấu hình bật/tắt "learn TM": settings key (mặc định bật) — tránh ghi rác khi chưa muốn.

### Completion %

```
translatable = translatableFields(collectionSchema)
done = translatable.filter(f => target[f] có giá trị).length
Completion_Pct = round(done / translatable.length * 100)
```
Hiển thị ở Translation mode header; (tuỳ chọn) badge ở item list nếu rẻ.

## Quyết định mở

1. **Cơ chế lưu đa ngữ:** xác minh translations route hiện lưu field translations thế nào (field suffix vs bảng riêng) khi implement — Translation mode lưu theo đúng cơ chế đó, KHÔNG tạo mới.
2. **"Learn TM" config:** settings key `translations.learnTm` default true.
3. **MT provider thực:** providers hiện là stub — auto-translate dùng provider đã cấu hình; nếu chưa có key, UI hiển thị "MT not configured" thay vì lỗi cứng.

## Error handling

- `/tm/lookup` lỗi → popover hiển thị "no suggestions", không chặn gõ.
- Auto-translate khi provider chưa cấu hình → thông báo nhẹ, giữ field trống.
- PATCH/DELETE TM cross-tenant → 404.

## Testing strategy

- Route: PATCH/DELETE TM filter siteId, 404 cross-tenant; GET phân trang trả meta.
- FE: tm-suggest-popover debounce + huỷ request cũ; Apply điền đúng; Auto-translate gọi /translate; threshold default 75 dùng chung.
- Completion %: tính đúng theo translatable fields.
- Learn TM: save human → upsertTm gọi với source=human khi config bật; không gọi khi tắt.
