# Implementation Plan: Translation Memory UI

## Overview

Gap-focused trên backend TM sẵn có. Thứ tự: hằng chung + endpoint CRUD → SDK → TM page → suggestion editor → side-by-side → completion → learn-TM → chất lượng.

## Tasks

- [x] 1. Hằng chung + endpoint quản lý  _(đã có từ trước)_
  - [x] 1.1 `TM_DEFAULT_THRESHOLD = 75` ở `packages/shared`; `bestMatch` default import từ đó
    - _Requirements: 3.4, 6.3_
  - [x] 1.2 `PATCH /api/v1/tm/:id` + `DELETE /api/v1/tm/:id` (filter siteId, permission); `GET /api/v1/tm` thêm limit/offset + meta phân trang
    - _Requirements: 2.1, 2.2, 2.3_
  - [x] 1.3 Route test: PATCH/DELETE filter siteId + 404 cross-tenant; GET phân trang meta
    - **Validates: Requirements 2.1, 2.2**

- [x] 2. SDK
  - [x] 2.1 Types `TmEntry`/`TmSuggestion` + namespace `tm` (list/upsert/update/delete/lookup/translate; lookup chuẩn hoá score→similarity; list trả `meta`)
    - _Requirements: 6.2_

- [x] 3. TM management page
  - [x] 3.1 `tm-page.tsx`: list + lọc lang pair/entrySource + edit inline + xoá + phân trang; source badge; empty state (giữ UpsertForm/LookupPanel/TranslatePanel); chuyển sang SDK `tm.*`
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 4. TM suggestion trong editor
  - [x] 4.1 `translatable-fields.ts`: xác định Translatable_Field (`interface==='translatable-text'`) + helper locale value/completion
    - _Requirements: 3.1, 4.1_
  - [x] 4.2 `tm-suggest-popover.tsx`: debounce /tm/lookup (React Query key drop stale) → suggestion (similarity% + source badge) + Apply (1 nhấp)
    - _Requirements: 3.1, 3.2, 3.5_
  - [x] 4.3 "Auto-translate" → /tm/translate (mark source=mt); threshold default 75 (shared)
    - _Requirements: 3.3, 3.4_
  - [x] 4.4 Component test: lookup + Apply(human); Auto-translate gọi /translate(mt); same-locale không gọi
    - **Validates: Requirements 3.1, 3.2, 3.3**

- [x] 5. Side-by-side locale editing
  - [x] 5.1 `translation-mode.tsx`: source|target cạnh nhau mỗi field; locale selector từ settings `locales`; lưu qua shape `data[field][locale]` sẵn có (KHÔNG tạo mới)
    - _Requirements: 4.1, 4.2, 4.3_
  - [x] 5.2 `item-detail.tsx`: Translation tab (chỉ hiện khi có translatable field) + target-locale selector + popover trên field target
    - _Requirements: 4.1, 3.1_

- [x] 6. Completion %
  - [x] 6.1 Completion_Pct header Translation mode (badge item list: bỏ qua — list không tải `data`, tránh over-fetch)
    - _Requirements: 5.1, 5.2_
  - [x] 6.2 Test: completion tính đúng theo translatable fields
    - **Validates: Requirements 5.1**

- [x] 7. Learn TM khi save
  - [x] 7.1 Settings key `translations.learnTm` (default true khi vắng); save human-edited → upsertTm(source=human, quality=100) best-effort (Promise.allSettled)
    - _Requirements: 6.1_
  - [ ] 7.2 Test: bật → gọi upsertTm; tắt → không gọi  _(chưa: cần integration test cho item-detail save; helper + popover đã test)_
    - **Validates: Requirements 6.1**

- [x] 8. Chất lượng & Setup Impact
  - [x] 8.1 `turbo run typecheck` (recursive) pass + tests pass; `docs/en/api/hono-api-spec.md` §12a đã đủ (PATCH/DELETE/phân trang/filter)
    - _Requirements: 6.4_
  - [x] 8.2 **Setup Impact** (DoD): cập nhật row #22 — settings key `translations.learnTm` (default ON, không seed/wizard/backfill); locale dùng settings `locales` (không cột mới)
    - _Requirements: DoD_

> **Ghi chú phạm vi:** (a) `/tm/lookup` trả 1 match tốt nhất — popover hiển thị match đó, không top-N (ngoài acceptance criteria). (b) Task 7.2 (integration test cho learn-on-save trong item-detail) còn để lại; logic đã implement + typecheck.
