# Implementation Plan: Translation Memory UI

> **Status (PR #208, 2026-07-06):** Task 1 (backend CRUD + `TM_DEFAULT_THRESHOLD`) pre-existed. This PR added: **task 2** (SDK `listTm`/`upsertTm`/`updateTm`/`deleteTm`/`lookupTm`/`translate`), **task 4** (`TmSuggestPopover` debounced lookup + Apply, integrated into `TranslatableText`), **task 6** (`completionPct` in `translatable-fields`), **task 7** (`learn-tm` settings-gated human feedback on save). Task 3 TM-page edit/pagination UI + task 5 full side-by-side mode remain as follow-up. Setup Impact recorded (registry #41, settings key `translations.learnTm`, default ON).

## Overview

Gap-focused trên backend TM sẵn có. Thứ tự: hằng chung + endpoint CRUD → SDK → TM page → suggestion editor → side-by-side → completion → learn-TM → chất lượng.

## Tasks

- [ ] 1. Hằng chung + endpoint quản lý
  - [ ] 1.1 `TM_DEFAULT_THRESHOLD = 75` ở `packages/shared`; `bestMatch` default import từ đó
    - _Requirements: 3.4, 6.3_
  - [ ] 1.2 `PATCH /api/v1/tm/:id` + `DELETE /api/v1/tm/:id` (filter siteId, permission); `GET /api/v1/tm` thêm limit/offset + meta phân trang
    - _Requirements: 2.1, 2.2, 2.3_
  - [ ] 1.3 Route test: PATCH/DELETE filter siteId + 404 cross-tenant; GET phân trang meta
    - **Validates: Requirements 2.1, 2.2**

- [ ] 2. SDK
  - [ ] 2.1 Types `TmEntry`/`TmSuggestion` + methods listTm/upsertTm/updateTm/deleteTm/lookupTm/translate (backward-compatible)
    - _Requirements: 6.2_

- [ ] 3. TM management page
  - [ ] 3.1 `tm-page.tsx`: TmTable list + lọc lang pair/source + search + phân trang; sửa/xoá; source badge; empty state (giữ UpsertForm/LookupPanel)
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [ ] 4. TM suggestion trong editor
  - [ ] 4.1 `translatable-fields.ts`: xác định Translatable_Field từ schema collection
    - _Requirements: 3.1, 4.1_
  - [ ] 4.2 `tm-suggest-popover.tsx`: focus field → debounce /tm/lookup → suggestion (similarity% + source badge) + Apply (1 nhấp); huỷ request cũ
    - _Requirements: 3.1, 3.2, 3.5_
  - [ ] 4.3 "Auto-translate" → /tm/translate (mark source=mt); threshold hiển thị/chỉnh (default 75)
    - _Requirements: 3.3, 3.4_
  - [ ] 4.4 Component test: debounce + huỷ; Apply điền đúng; Auto-translate gọi /translate
    - **Validates: Requirements 3.1, 3.2, 3.3**

- [ ] 5. Side-by-side locale editing
  - [ ] 5.1 `translation-mode.tsx`: source|target cạnh nhau mỗi field; locale selector từ locale site; lưu qua cơ chế đa ngữ hiện hành (xác minh translations route, KHÔNG tạo mới)
    - _Requirements: 4.1, 4.2, 4.3_
  - [ ] 5.2 `item-detail.tsx`: Translation mode toggle + tích hợp popover suggestion vào field target
    - _Requirements: 4.1, 3.1_

- [ ] 6. Completion %
  - [ ] 6.1 Completion_Pct header Translation mode; (tuỳ chọn) badge item list
    - _Requirements: 5.1, 5.2_
  - [ ] 6.2 Test: completion tính đúng theo translatable fields
    - **Validates: Requirements 5.1**

- [ ] 7. Learn TM khi save
  - [ ] 7.1 Settings key `translations.learnTm` (default true); save human → upsertTm(source=human, quality=100) khi bật
    - _Requirements: 6.1_
  - [ ] 7.2 Test: bật → gọi upsertTm; tắt → không gọi
    - **Validates: Requirements 6.1**

- [ ] 8. Chất lượng & Setup Impact
  - [ ] 8.1 `pnpm typecheck` + `pnpm test` pass; cập nhật `docs/en/api/hono-api-spec.md` (tm PATCH/DELETE/phân trang)
    - _Requirements: 6.4_
  - [ ] 8.2 **Setup Impact** (DoD): rà soát 6 câu hỏi. Settings key `translations.learnTm` (Q2) — cân nhắc seed default + có cần bước wizard không (dự kiến không). Thêm dòng registry sau
    - _Requirements: DoD_
