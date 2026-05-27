# Studio UI Specification (apps/studio)

> Stack: **React 18 + Vite + TypeScript**, **TailwindCSS + shadcn/ui + CVA**, **TanStack Query + Router**, **Zustand** cho local state, **Monaco** cho raw editor, **dnd-kit** cho drag-drop.

## 1. App shell

```
┌──────────────────────────────────────────────────────────┐
│ TopBar: site switcher · search (cmd-k) · presence · me   │
├──────────┬───────────────────────────────────────────────┤
│ ModuleBar│ Content area                                   │
│ - Content│   Header (breadcrumb, actions)                 │
│ - Files  │   ┌─────────────────────────────────────────┐  │
│ - Users  │   │ Page-specific layout (list/detail/...)  │  │
│ - Access │   └─────────────────────────────────────────┘  │
│ - Insights│  Drawer (right): inspectors, raw, comments    │
│ - Settings│                                                │
│ - Apps   │                                                │
└──────────┴───────────────────────────────────────────────┘
```

- ModuleBar: icon vertical, hỗ trợ extension module mount.
- Cmd-K: search collections, items, users, settings, docs.
- Presence chip hiện avatar realtime người đang xem cùng trang.

## 2. Routing (TanStack Router)

```
/sites/:siteId
  /content
    /:collection               → list view
    /:collection/:itemId       → detail editor
    /:collection/:itemId/revisions
  /files
    /:folderId?
    /detail/:fileId
  /users
    /:userId
    /teams/:teamId
  /access
    /roles/:roleId
    /policies/:policyId
    /matrix
    /test
  /insights
    /:dashboardId
  /settings
    /general | locales | security | files | webhooks | extensions | activity | branding
  /apps/:extensionId           // extension modules
```

## 3. Modules chi tiết

### 3.1 Content module

- **List page** (`/content/:collection`):
  - Layout switcher: tabular / cards / kanban / calendar / map (registry mở rộng).
  - Toolbar: search, filter builder, sort, preset dropdown, refresh, "Subscribe realtime" toggle.
  - Bulk actions: edit, delete, export, change status.
  - Empty state với "Create first item".

- **Detail editor** (`/content/:collection/:itemId`):
  - Layout 2 cột: form chính + side panel (Comments, Activity, Revisions, Translations, Raw JSON).
  - Sticky action bar: Save / Save & Stay / Save as Draft / Discard.
  - Tabs theo `group` field hoặc tabs theo locale (translations).
  - Realtime presence: hiển thị ai đang edit, lock cảnh báo conflict.

### 3.2 Collection Builder (`Settings → Data model` hoặc `/access?`)

Xem `features/collections-builder.md`. UI dùng canvas + inspector + JSON pane.

### 3.3 Access Control

- **Roles list**: card grid, drag user vào.
- **Policy editor**: 2 chế độ
  - GUI: rows per (collection, action), field whitelist, rule builder (block-based query), preset form, validation form.
  - JSON: Monaco với schema autocomplete.
- **Matrix**: bảng tổng quan, click ô mở drawer.
- **Test sandbox**: chọn user, simulate request → log allow/deny.

### 3.4 Users / Teams

Xem `features/user-management.md`.

### 3.5 Files

- Grid + tree folder.
- Upload: drag-drop, multi, progress bar (presigned R2).
- Detail: preview (image/video/pdf), metadata edit, replace file, focal point, usage list.

### 3.6 Settings

Tab-based, mỗi tab map sang category trong `system-config.md`.

### 3.7 Insights (Phase 2)

Dashboard panel registry (extension type `panel`).

## 4. Component library (packages/ui)

- Re-export shadcn + custom: `FormField`, `RawToggle`, `JsonEditor`, `FilterBuilder`, `MustachePreview`, `PresenceAvatars`, `RevisionDiff`, `RelationPicker`, `ConditionalFieldRenderer`.

## 5. State

- **TanStack Query** cho server state, key bao gồm `siteId`.
- **Zustand stores**:
  - `useAuthStore` — user, token, permissions matrix.
  - `useSiteStore` — current site, settings.
  - `useRealtimeStore` — subscriptions.
  - `usePresetStore` — current view state per collection.

## 6. Realtime hooks

- `useRealtimeSubscription(collection, query)` — return list cập nhật live.
- `usePresence(scope)` — danh sách user đang ở scope.

## 7. Theming

- CSS variables driven (light/dark), token branding lấy từ `settings.branding`.
- CVA cho variant component.

## 8. Accessibility

- Tất cả interactive đạt WCAG AA, focus ring rõ ràng.
- Cmd-K + keyboard navigation đầy đủ.
- Form lỗi đọc được bởi screen reader (`aria-describedby`).

## 9. Performance budgets

- Bundle initial < 300KB gz (lazy load modules).
- Studio TTI < 2s với 1k collections.
- List 50 rows render < 100ms (virtualize > 50).

## 10. Tests

- Unit: Vitest cho hooks, util.
- Integration: React Testing Library cho mỗi module trang chính.
- E2E: Playwright cho luồng: tạo collection → field → role → policy → item CRUD → realtime → raw edit.
