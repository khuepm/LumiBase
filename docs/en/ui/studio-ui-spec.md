---
version: 1
lastUpdated: 2026-07-27T23:51:24.891Z
sourceLang: vi
translatedFrom: vi
sourceHash: 3063b8b0f3d50f6c
mtEngine: claude
syncStatus: machine-translated
---

# Studio UI Specification (apps/studio)

> Stack: **React 18 + Vite + TypeScript**, **TailwindCSS + shadcn/ui + CVA**, **TanStack Query + Router**, **Zustand** for local state, **Monaco** for the raw editor, **dnd-kit** for drag-and-drop.

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

- ModuleBar: a vertical icon rail that also hosts mounted extension modules.
- Cmd-K: search collections, items, users, settings, and docs.
- The presence chip shows realtime avatars of everyone viewing the same page.

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

## 3. Modules in detail

### 3.1 Content module

- **List page** (`/content/:collection`):
  - Layout switcher: tabular / cards / kanban / calendar / map (an extensible registry).
  - Toolbar: search, filter builder, sort, preset dropdown, refresh, "Subscribe realtime" toggle.
  - Bulk actions: edit, delete, export, change status.
  - Empty state with "Create first item".

- **Detail editor** (`/content/:collection/:itemId`):
  - Two-column layout: the main form plus a side panel (Comments, Activity, Revisions, Translations, Raw JSON).
  - Sticky action bar: Save / Save & Stay / Save as Draft / Discard.
  - Tabs by field `group`, or tabs per locale (translations).
  - Realtime presence: show who is editing, with a lock warning on conflict.

### 3.2 Collection Builder (`Settings → Data model`)

See `features/collections-builder.md`. The UI is a canvas + inspector + JSON pane.

### 3.3 Access Control

- **Roles list**: a card grid you can drag users onto.
- **Policy editor**: two modes
  - GUI: rows per (collection, action), field whitelist, rule builder (block-based query), preset form, validation form.
  - JSON: Monaco with schema autocomplete.
- **Matrix**: an overview grid; click a cell to open the drawer.
- **Test sandbox**: pick a user, simulate a request → log allow/deny.

### 3.4 Users / Teams

See `features/user-management.md`.

### 3.5 Files

- Grid + folder tree.
- Upload: drag-and-drop, multi-file, progress bar (presigned R2).
- Detail: preview (image/video/pdf), metadata editing, replace file, focal point, usage list.

### 3.6 Settings

Tab-based; each tab maps to a category in `system-config.md`.

### 3.7 Insights (Phase 2)

A dashboard panel registry (extension type `panel`).

## 4. Component library (packages/ui)

- Re-exports shadcn plus custom components: `FormField`, `RawToggle`, `JsonEditor`, `FilterBuilder`, `MustachePreview`, `PresenceAvatars`, `RevisionDiff`, `RelationPicker`, `ConditionalFieldRenderer`.

## 5. State

- **TanStack Query** for server state, with `siteId` in every key.
- **Zustand stores**:
  - `useAuthStore` — user, token, permission matrix.
  - `useSiteStore` — current site, settings.
  - `useRealtimeStore` — subscriptions.
  - `usePresetStore` — current view state per collection.

## 6. Realtime hooks

- `useRealtimeSubscription(collection, query)` — returns a list that updates live.
- `usePresence(scope)` — the users currently in that scope.

## 7. Theming

- Driven by CSS variables (light/dark); branding tokens come from `settings.branding`.
- CVA for component variants.

## 8. Accessibility

- Every interactive element meets WCAG AA, with a clearly visible focus ring.
- Full Cmd-K and keyboard navigation.
- Form errors are readable by screen readers (`aria-describedby`).

## 9. Performance budgets

- Initial bundle < 300KB gz (modules lazy-loaded).
- Studio TTI < 2s with 1k collections.
- A 50-row list renders in < 100ms (virtualized above 50).

## 10. Tests

- Unit: Vitest for hooks and utilities.
- Integration: React Testing Library for each module's main page.
- E2E: Playwright covering the flow create collection → field → role → policy → item CRUD → realtime → raw edit.
