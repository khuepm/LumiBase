# Translations & i18n

## 1. Ba lớp i18n

1. **UI strings** — Studio interface, dịch qua bảng `translations` namespace `ui` + fallback packs đi kèm bundle.
2. **Schema labels** — `fields.translations.<locale>.label/help`, `collections.translations` (qua field `meta.translations`).
3. **Content** — dịch giá trị field. Hai chiến lược:
   - **Field-level repeat** (Directus translations pattern): tạo collection liên kết `<col>_translations` (m2o → parent, m2o → languages).
   - **JSONB locale map** (đơn giản hơn cho content nhỏ): field type `text` + interface `translatable-text` lưu `{ en: "...", vi: "..." }`.

LumiBase hỗ trợ **cả hai**, mặc định JSONB cho field đơn lẻ, collection-link cho item phức tạp.

## 2. Locale management

- `settings.locales.available = ["en","vi","ja"]`, `settings.locales.default = "en"`.
- Trang **Settings → Locales**: thêm/xoá locale, set default, fallback chain.

## 3. Glossary & Translation Memory (USP)

- Bảng `translation_memory` (Phase 2): `siteId`, `sourceLang`, `targetLang`, `source`, `target`, `context`.
- Glossary: thuật ngữ cố định không được dịch.

## 4. Machine translation plug-in

- Interface `MTProvider`: `translate(text, from, to, glossary?)`.
- Built-in: DeepL, OpenAI, Workers AI. Cấu hình ở Settings.
- Editor có nút "Translate from <lang>" → gọi MT, đánh dấu `status: machine-translated` để reviewer duyệt.

## 5. Workflow status per locale

- Mỗi giá trị dịch có `status`: `missing | machine | draft | review | approved`.
- List view có badge phần trăm hoàn thành dịch.

## 6. API

- `GET /translations?namespace=ui&language=vi`
- `POST /translations/bulk` (upsert)
- `POST /translations/auto` body: `{ collection, item, fromLocale, toLocale }` → trả candidates.

## 7. UI

- Module **Translations**:
  - Tab *UI Strings* — bảng key/value per locale, search, missing filter.
  - Tab *Content* — chọn collection → ma trận item × locale → click cell mở editor.
  - Tab *Glossary*.
  - Tab *Memory*.
- Editor item: tab locale dọc bên trái, side-by-side compare với default locale.

## 8. Tasks: Phase MVP-C2 (UI strings + JSONB content) → POST-MVP-F (MT, memory).
