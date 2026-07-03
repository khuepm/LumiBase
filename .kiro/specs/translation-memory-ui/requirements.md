# Requirements Document — Translation Memory UI

## Introduction

Directus có trải nghiệm dịch song ngữ với gợi ý. LumiBase đã có **backend Translation Memory đầy đủ**: bảng `translation_memory`, `TranslationMemoryService` với pipeline TM→glossary→MT, fuzzy match (`similarity()` Levenshtein, threshold 75), và routes (`/tm`, `/tm/lookup`, `/tm/translate`). UI hiện CHỈ partial (`tm-page.tsx`: form upsert + lookup panel) và CHƯA tích hợp vào content editor.

Spec này gap-focused: (1) hoàn thiện **TM management page**, (2) tích hợp **TM suggestion vào content editor** khi dịch field (gợi ý từ TM khi similarity ≥ threshold, một-cú-nhấp để áp), (3) **side-by-side locale editing** cho field đa ngữ, (4) hiển thị **% hoàn thành dịch** per item/locale.

Hiện trạng tận dụng được (xác minh trong codebase):
- Bảng `translation_memory` (`packages/database/src/schema/platform.ts:217-245`): sourceLang, targetLang, sourceText, targetText, context, quality, source (`human|mt|imported`), provider, hits.
- `translation-memory.ts` service: `similarity(a,b)` Levenshtein 0-100; `bestMatch(query, candidates, threshold=75)`; `TranslationMemoryService.translate(input)` pipeline TM→glossary→MT; providers DeepL/OpenAI/WorkersAI (stub).
- Routes (`apps/cms/src/routes/translation-memory.ts`): `GET/POST /api/v1/tm`, `POST /api/v1/tm/lookup`, `POST /api/v1/tm/translate`.
- Routes translations (`apps/cms/src/routes/translations.ts`).
- UI (`apps/studio/src/modules/translations/tm-page.tsx`): UpsertForm + LookupPanel (partial); route `translationMemoryRoute`.

## Glossary

- **TM_Entry**: Một cặp dịch trong bảng `translation_memory` (source/target + lang pair + quality + source).
- **TM_Suggestion**: Gợi ý dịch trả từ `/tm/lookup` với `similarity` ≥ threshold; gồm `targetText`, `similarity`, `source`.
- **Translate_Pipeline**: `/tm/translate` — TM exact/fuzzy → glossary → MT provider fallback.
- **Translatable_Field**: Field của collection cần dịch theo locale (đa ngữ).
- **Completion_Pct**: % field đã có bản dịch cho một locale của một item.

## Requirements

### Requirement 1: TM management page hoàn chỉnh

**User Story:** Là người quản lý dịch, tôi muốn duyệt/lọc/sửa/xoá TM entry, để bảo trì kho dịch.

#### Acceptance Criteria

1. THE TM page SHALL liệt kê TM_Entry với lọc theo lang pair (`?source=&target=`), tìm theo sourceText, và hiển thị quality/source/hits/updatedAt.
2. THE TM page SHALL cho tạo (form sẵn có), sửa, và xoá TM_Entry; mọi thao tác qua API `/api/v1/tm` (cần thêm PATCH/DELETE nếu chưa có).
3. THE TM page SHALL hiển thị `source` badge (`human`/`mt`/`imported`) và cho lọc theo nó.
4. WHEN chưa có entry, THE page SHALL hiển thị empty state.

### Requirement 2: API bổ sung cho quản lý TM

**User Story:** Là Studio, tôi muốn sửa/xoá TM entry qua API, để page quản lý đầy đủ.

#### Acceptance Criteria

1. THE system SHALL hỗ trợ `PATCH /api/v1/tm/:id` (sửa targetText/quality/context) và `DELETE /api/v1/tm/:id`, filter `siteId`, response `{ data }`/`{ errors }`.
2. THE `GET /api/v1/tm` SHALL hỗ trợ phân trang (`limit/offset`) và trả `meta` phân trang (response format CLAUDE.md).
3. Mọi endpoint TM SHALL chịu permission check (quản lý dịch là quyền admin hoặc role có quyền translations).

### Requirement 3: TM suggestion trong content editor

**User Story:** Là biên tập viên, khi dịch một field tôi muốn thấy gợi ý từ TM (và MT fallback) ngay tại field, để tái dùng bản dịch cũ và dịch nhanh.

#### Acceptance Criteria

1. WHEN người dùng focus một Translatable_Field ở locale đích và source locale đã có nội dung, THE editor SHALL gọi `/tm/lookup` (source text + lang pair) và hiển thị TM_Suggestion (targetText + similarity% + source badge) trong popover cạnh field.
2. THE suggestion SHALL có nút "Apply" điền targetText vào field (một cú nhấp); applied SHALL đánh dấu để có thể lưu vào TM khi save (source=`human`).
3. WHEN không có TM match ≥ threshold, THE editor SHALL có nút "Auto-translate" gọi `/tm/translate` (pipeline đầy đủ, dùng MT provider) và điền kết quả (đánh dấu source=`mt`).
4. THE threshold SHALL hiển thị và (tuỳ chọn) chỉnh được; default 75 khớp backend.
5. THE lookup SHALL debounce và huỷ request cũ để không spam khi gõ.

### Requirement 4: Side-by-side locale editing

**User Story:** Là biên tập viên, tôi muốn chỉnh field nguồn và đích cạnh nhau, để dịch trong ngữ cảnh.

#### Acceptance Criteria

1. THE content editor SHALL có chế độ Translation hiển thị source locale (read-only hoặc editable) và target locale cạnh nhau cho mỗi Translatable_Field.
2. THE người dùng SHALL chọn được target locale từ danh sách locale của site.
3. WHEN lưu, THE editor SHALL lưu bản dịch theo cơ chế đa ngữ hiện hành (qua translations route / field translations) — KHÔNG tạo cơ chế lưu mới nếu đã có.

### Requirement 5: Completion % per locale

**User Story:** Là người quản lý, tôi muốn biết item đã dịch bao nhiêu % cho mỗi locale, để theo dõi tiến độ.

#### Acceptance Criteria

1. THE editor (Translation mode) SHALL hiển thị Completion_Pct = (số Translatable_Field có target) / (tổng Translatable_Field) cho locale đang chọn.
2. THE item list (tuỳ chọn) SHALL hiển thị badge completion per locale nếu dữ liệu sẵn có rẻ để tính.

### Requirement 6: Phối hợp FE↔BE & lưu lại TM

#### Acceptance Criteria

1. WHEN một bản dịch human được lưu trong editor, THE system SHALL (tuỳ chọn theo cấu hình) upsert vào TM (`source=human`, quality cao) để tái dùng lần sau — qua `POST /api/v1/tm`.
2. THE SDK SHALL mở rộng (backward-compatible) types `TmEntry`/`TmSuggestion` + methods `listTm/upsertTm/updateTm/deleteTm/lookupTm/translate` để editor không fetch thô.
3. THE threshold default (75) SHALL là hằng số dùng chung FE/BE để không lệch.
4. `pnpm typecheck` + `pnpm test` pass; mọi query filter `siteId`; response `{ data }`/`{ errors }`.
