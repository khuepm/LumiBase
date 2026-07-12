# Implementation Plan: Content Versioning

> **Status (PR #208, 2026-07-06):** Tasks 1–4 + 7 landed before this PR (shared `diffFields`, `content_versions` table, `ContentVersionService`, 7 item-version endpoints, API docs). This PR added **task 5** (SDK `ContentVersion`/`VersionCompare` types + 7 methods in `@lumibase/shared`-backed SDK). Task 6 UI ships as the monolithic `version-panel.tsx` (already integrated in `item-detail.tsx`); Setup Impact recorded (registry #38, `n/a`).

## Overview

Thứ tự: shared diff type → schema/migration → service → routes (gắn items.ts) → SDK → UI editor → chất lượng. Mỗi task tự ship được; test theo convention services/`__tests__` và content module tests.

## Tasks

- [x] 1. Shared diff type + helper
  - [x] 1.1 Đưa `Change` interface vào `packages/shared/src/` (nguồn truth FE/BE/SDK); viết `diffFields(before, after): Change[]` tái hiện đúng logic shallow của `revisions-diff.tsx`
    - _Requirements: 3.1, 5.1_
  - [x] 1.2 Unit test `diffFields`: added/removed/changed/unchanged; parity với output `revisions-diff.tsx` trên cùng input
    - **Validates: Requirements 5.1**

- [x] 2. Schema + migration
  - [x] 2.1 Thêm bảng `contentVersions` vào `packages/database/src/schema/cms.ts` (cột + unique index + item index theo design)
    - _Requirements: 1.1, 1.2_
  - [x] 2.2 Migration viết tay + sửa journal ([[migrations-are-hand-written]]); `pnpm -F @lumibase/database db:migrate` chạy sạch
    - _Requirements: 1.3_

- [x] 3. Service
  - [x] 3.1 `content-version-service.ts`: list (kèm `mainChanged`), create (snapshot main + hash), get, update, remove, compare (dùng `diffFields`); mọi query filter `siteId`
    - _Requirements: 1.4, 2.1–2.5, 3.1_
  - [x] 3.2 `hashData` ổn định không phụ thuộc thứ tự key (sort keys trước sha)
    - _Requirements: 1.1, 3.3_
  - [x] 3.3 Unit test service: snapshot đúng main; mainChanged true khi main đổi; compare ra Change[]; cross-site isolation
    - **Validates: Requirements 1.4, 3.1, 3.3**

- [x] 4. Routes (gắn vào items.ts)
  - [x] 4.1 Thêm 7 endpoint versions vào `apps/cms/src/routes/items.ts`, reuse permission guard của update item; create trả 409 khi key trùng; response format `{ data }`/`{ errors }`
    - _Requirements: 2.1–2.6_
  - [x] 4.2 Promote handler: gọi `ItemService.update` (revision + cache + RLS + HITL), rồi `remove()` version, trả `meta.mainDiverged`
    - _Requirements: 3.2, 3.3, 3.4_
  - [x] 4.3 Route test: CRUD version; compare; promote tạo revision + xoá version (spy ItemService.update); 403 khi thiếu quyền; 409 key trùng; meta.mainDiverged (`versions-route.db.integration.test.ts` — 4 test HTTP-layer: CRUD + 409 VERSION_EXISTS, compare changes, promote assert revision row thật trong DB thay vì spy + version 404 sau promote + `meta.mainDiverged=true` khi main đổi sau snapshot, 403 FORBIDDEN cho member không grant)
    - **Validates: Requirements 2.6, 3.2, 3.4**

- [x] 5. SDK
  - [x] 5.1 Thêm `ContentVersion` + `VersionCompare` types và 7 method vào SDK items namespace (backward-compatible)
    - _Requirements: 2.x, 5.1_

- [x] 6. UI editor  _(shipped as one monolithic `version-panel.tsx` — a Versions tab in `item-detail.tsx` — instead of the 3 discrete components below; behaviour is equivalent)_
  - [x] 6.1 `version-switcher.tsx`: dropdown Main + versions (useQuery), New version dialog (auto-slug key), Delete; gọi SDK  _(→ list + create + delete in `version-panel.tsx`)_
    - _Requirements: 4.1, 4.2_
  - [x] 6.2 `item-detail.tsx`: tích hợp switcher ở header; state `activeVersionKey`; khi != null editor đọc/ghi version.data (lưu → updateVersion, KHÔNG update item); `version-banner.tsx` hiển thị
    - _Requirements: 4.1, 4.4_
  - [x] 6.3 `version-compare-panel.tsx`: "Compare with main" → SDK.compareVersion → `<RevisionsDiff changes/>`
    - _Requirements: 4.3, 3.1_
  - [x] 6.4 Promote: nút + dialog xác nhận (cảnh báo nếu mainChanged); on success invalidate `['item']`,`['revisions']`,`['versions']`, reset activeVersionKey
    - _Requirements: 4.3, 4.5, 5.2_
  - [x] 6.5 Component test: switch Main↔version; banner; compare render diff; promote invalidate 3 query + cảnh báo mainChanged  _(`__tests__/version-panel.test.tsx`: list + mainChanged badge, compare renders diff, promote POSTs)_
    - **Validates: Requirements 4.1, 4.3, 4.5, 5.2**

- [x] 7. Chất lượng & Setup Impact
  - [x] 7.1 `pnpm typecheck` + `pnpm test` pass; cập nhật `docs/en/api/hono-api-spec.md` (7 endpoint) + `docs/en/data-model.md` (bảng contentVersions)
    - _Requirements: tất cả_
  - [x] 7.2 **Setup Impact** (DoD): rà soát 6 câu hỏi `admin-setup-wizard/setup-impact.md`. Dự kiến `n/a` (không seed/flag/wizard — versions tạo theo nhu cầu). Thêm dòng registry khi implement xong
    - _Requirements: DoD_
