# Implementation Plan: Content Versioning

## Overview

Thứ tự: shared diff type → schema/migration → service → routes (gắn items.ts) → SDK → UI editor → chất lượng. Mỗi task tự ship được; test theo convention services/`__tests__` và content module tests.

## Tasks

- [ ] 1. Shared diff type + helper
  - [ ] 1.1 Đưa `Change` interface vào `packages/shared/src/` (nguồn truth FE/BE/SDK); viết `diffFields(before, after): Change[]` tái hiện đúng logic shallow của `revisions-diff.tsx`
    - _Requirements: 3.1, 5.1_
  - [ ] 1.2 Unit test `diffFields`: added/removed/changed/unchanged; parity với output `revisions-diff.tsx` trên cùng input
    - **Validates: Requirements 5.1**

- [ ] 2. Schema + migration
  - [ ] 2.1 Thêm bảng `contentVersions` vào `packages/database/src/schema/cms.ts` (cột + unique index + item index theo design)
    - _Requirements: 1.1, 1.2_
  - [ ] 2.2 Migration viết tay + sửa journal ([[migrations-are-hand-written]]); `pnpm -F @lumibase/database db:migrate` chạy sạch
    - _Requirements: 1.3_

- [ ] 3. Service
  - [ ] 3.1 `content-version-service.ts`: list (kèm `mainChanged`), create (snapshot main + hash), get, update, remove, compare (dùng `diffFields`); mọi query filter `siteId`
    - _Requirements: 1.4, 2.1–2.5, 3.1_
  - [ ] 3.2 `hashData` ổn định không phụ thuộc thứ tự key (sort keys trước sha)
    - _Requirements: 1.1, 3.3_
  - [ ] 3.3 Unit test service: snapshot đúng main; mainChanged true khi main đổi; compare ra Change[]; cross-site isolation
    - **Validates: Requirements 1.4, 3.1, 3.3**

- [ ] 4. Routes (gắn vào items.ts)
  - [ ] 4.1 Thêm 7 endpoint versions vào `apps/cms/src/routes/items.ts`, reuse permission guard của update item; create trả 409 khi key trùng; response format `{ data }`/`{ errors }`
    - _Requirements: 2.1–2.6_
  - [ ] 4.2 Promote handler: gọi `ItemService.update` (revision + cache + RLS + HITL), rồi `remove()` version, trả `meta.mainDiverged`
    - _Requirements: 3.2, 3.3, 3.4_
  - [ ] 4.3 Route test: CRUD version; compare; promote tạo revision + xoá version (spy ItemService.update); 403 khi thiếu quyền; 409 key trùng; meta.mainDiverged
    - **Validates: Requirements 2.6, 3.2, 3.4**

- [ ] 5. SDK
  - [ ] 5.1 Thêm `ContentVersion` + `VersionCompare` types và 7 method vào SDK items namespace (backward-compatible)
    - _Requirements: 2.x, 5.1_

- [ ] 6. UI editor
  - [ ] 6.1 `version-switcher.tsx`: dropdown Main + versions (useQuery), New version dialog (auto-slug key), Delete; gọi SDK
    - _Requirements: 4.1, 4.2_
  - [ ] 6.2 `item-detail.tsx`: tích hợp switcher ở header; state `activeVersionKey`; khi != null editor đọc/ghi version.data (lưu → updateVersion, KHÔNG update item); `version-banner.tsx` hiển thị
    - _Requirements: 4.1, 4.4_
  - [ ] 6.3 `version-compare-panel.tsx`: "Compare with main" → SDK.compareVersion → `<RevisionsDiff changes/>`
    - _Requirements: 4.3, 3.1_
  - [ ] 6.4 Promote: nút + dialog xác nhận (cảnh báo nếu mainChanged); on success invalidate `['item']`,`['revisions']`,`['versions']`, reset activeVersionKey
    - _Requirements: 4.3, 4.5, 5.2_
  - [ ] 6.5 Component test: switch Main↔version; banner; compare render diff; promote invalidate 3 query + cảnh báo mainChanged
    - **Validates: Requirements 4.1, 4.3, 4.5, 5.2**

- [ ] 7. Chất lượng & Setup Impact
  - [ ] 7.1 `pnpm typecheck` + `pnpm test` pass; cập nhật `docs/en/api/hono-api-spec.md` (7 endpoint) + `docs/en/data-model.md` (bảng contentVersions)
    - _Requirements: tất cả_
  - [ ] 7.2 **Setup Impact** (DoD): rà soát 6 câu hỏi `admin-setup-wizard/setup-impact.md`. Dự kiến `n/a` (không seed/flag/wizard — versions tạo theo nhu cầu). Thêm dòng registry khi implement xong
    - _Requirements: DoD_
