# Implementation Plan: Presets Inheritance

> **Status (PR #208, 2026-07-06):** Greenfield-on-existing-schema, delivered in this PR: **task 1** (`PresetService.roleChain`/`effective`/`bookmarks` with cycle guard + precedence + unit tests), **task 2** (`GET /presets/effective` + `/bookmarks`, scope-ownership RBAC on POST/PATCH/DELETE), **task 3** (SDK `getEffectivePreset`/`listBookmarks`/`saveUserView`/`create`/`update`/`deleteBookmark`), **task 4** (`BookmarkSwitcher` + `SaveBookmarkDialog` + `presets/api.ts` `viewDiffers` + tests), **task 5** (`RolePresets` admin panel), and **task 4.1** (items-list applies the effective preset on mount + debounced `saveUserView` on view drift). All task groups complete. Setup Impact recorded (registry #44, `n/a`).

## Overview

Gap-focused: schema sẵn có, thêm resolution + quyền + UI. Thứ tự: service resolution → endpoint → quyền scope → SDK → UI → admin role presets → chất lượng.

## Tasks

- [x] 1. Preset service resolution
  - [x] 1.1 `preset-service.ts`: `roleChain()` (parent qua roles.parentId, cycle guard, filter siteId)
    - _Requirements: 1.2, 5.x_
  - [x] 1.2 `effective(collection)`: precedence user > role-gần > role-xa > global; empty khi không có; sourceScope
    - _Requirements: 1.1, 1.3, 1.4, 1.5_
  - [x] 1.3 `bookmarks(collection)`: user + role-chain + global, kèm scope
    - _Requirements: 2.1, 2.4_
  - [x] 1.4 Unit test: roleChain (+cycle); effective precedence + empty; bookmarks scope đúng; cross-tenant
    - **Validates: Requirements 1.1, 1.2, 2.1**

- [x] 2. Endpoints + quyền scope
  - [x] 2.1 `GET /api/v1/presets/effective` + `GET /api/v1/presets/bookmarks` (filter siteId, response chuẩn)
    - _Requirements: 1.1, 2.1_
  - [x] 2.2 Áp quyền theo scope ở POST/PATCH/DELETE: user tự quản; role/global cần admin; không sửa preset user khác
    - _Requirements: 2.2, 2.3, 4.1, 4.2, 4.3_
  - [x] 2.3 Route test: effective/bookmarks; 403 khi tạo role/global không quyền; 403 sửa preset user khác
    - **Validates: Requirements 4.1, 4.2, 2.3**

- [x] 3. SDK
  - [x] 3.1 `getEffectivePreset`, `listBookmarks`, `saveUserView`, `createBookmark`, `updateBookmark`, `deleteBookmark` (backward-compatible)
    - _Requirements: 6.2_

- [x] 4. UI collection view  _(wired into the existing `content/items-list.tsx` collection view — not a new `collection-view.tsx`)_
  - [x] 4.1 on mount áp `getEffectivePreset`; on change debounce `saveUserView` (chỉ khi khác effective; bỏ qua khi đang xem bookmark)  _(`items-list.tsx`)_
    - _Requirements: 3.1, 3.2, 6.1, 6.3_
  - [x] 4.2 `bookmark-switcher.tsx`: dropdown bookmark khả kiến (scope badge) + Default view + Reset to default  _(mounted in items-list)_
    - _Requirements: 5.1, 3.3, 2.4_
  - [x] 4.3 `save-bookmark-dialog.tsx`: tên + scope (user luôn; role/global nếu quyền); không ghi đè im lặng bookmark role/global  _(opened from items-list Save button; scope gated on `perms.isAdmin`)_
    - _Requirements: 5.2, 5.3_
  - [x] 4.4 "Reset to default" xoá user-default → getEffectivePreset lại  _(`resetToDefault` in items-list: deletes own user preset, refetches effective)_
    - _Requirements: 3.3_
  - [x] 4.5 Component test: áp effective state; saveUserView debounce + chỉ khi khác; scope badge; Reset
    - **Validates: Requirements 3.1, 3.3, 5.1**

- [x] 5. Admin role/global presets
  - [x] 5.1 `role-presets.tsx` (settings/role detail): list + sửa/xoá preset role/global (admin)
    - _Requirements: 5.4, 4.1_

- [x] 6. Chất lượng & Setup Impact
  - [x] 6.1 `pnpm typecheck` + `pnpm test` pass; cập nhật `docs/en/api/hono-api-spec.md` (effective/bookmarks)
    - _Requirements: 6.4_
  - [x] 6.2 **Setup Impact** (DoD): rà soát 6 câu hỏi. Cân nhắc seed global-default preset cho collection hệ thống (Q1/Q3) — dự kiến `n/a` (preset tạo theo nhu cầu). Thêm dòng registry sau
    - _Requirements: DoD_
