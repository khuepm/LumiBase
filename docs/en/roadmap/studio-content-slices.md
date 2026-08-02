---
version: 1
lastUpdated: 2026-07-28T00:00:42.369Z
sourceLang: vi
translatedFrom: vi
sourceHash: 0ff1ace0a8b1cf21
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T00:00:42.369Z
codeVerifiedHash: 0ff1ace0a8b1cf21
codeVerifiedClaims: 22
---

# Studio Content Module — Slice Tracking

> The Content module in LumiBase Studio manages the dynamic data of a single collection. Development is split into "slices" (incremental delivery, each slice building on the previous one).

## Overview

| Slice | Description | Status | Key files |
|-------|-------------|--------|-----------|
| 1 | SDK items API + Content module list view | ✅ Done | `packages/sdk/src/`, `apps/studio/src/modules/content/items-list.tsx` |
| 2 | Detail editor shell + Revisions tab + Raw JSON tab | ✅ Done | `apps/studio/src/modules/content/item-detail.tsx`, `revisions-panel.tsx`, `raw-json-panel.tsx` |
| 3 | Interface registry part 1 (text, number, toggle, select, datetime, json-raw) | ✅ Done | `apps/studio/src/modules/content/interfaces/` |
| 4 | Interface registry part 2 (relation, code, wysiwyg, markdown, file, repeater, presentation) | ✅ Done | `apps/studio/src/modules/content/interfaces/` |
| 5 | Display registry + Raw toggle + Bulk raw editor | ✅ Done | `apps/studio/src/modules/content/displays/`, `bulk-raw-editor.tsx`, `raw-toggle.tsx` |
| 6 | Revisions diff viewer + Mustache display | ✅ Done | `apps/studio/src/modules/content/revisions-diff.tsx`, `displays/mustache.tsx` |
| 7 | Update docs/features/field-types-and-config.md | ✅ Done | `docs/features/field-types-and-config.md` |

---

## Slice 1 — SDK items API + Content module list view

**Goal:** establish the SDK items API and the content list view.

### SDK items API
- **File:** `packages/sdk/src/client.ts`
- **APIs:**
  - `listItems(siteId, collectionId, options)` — list items with filter/sort/pagination
  - `getItem(siteId, collectionId, itemId)` — item detail
  - `createItem(siteId, collectionId, data)` — create a new item
  - `updateItem(siteId, collectionId, itemId, data)` — update an item
  - `deleteItem(siteId, collectionId, itemId)` — delete an item
  - `listFields(siteId, collectionId)` — the collection's fields

### Content module list view
- **File:** `apps/studio/src/modules/content/items-list.tsx`
- **Features:**
  - Tabular view of items
  - Filter, sort, pagination
  - Click a row → navigate to the detail editor
  - PAGE_SIZE = 25

---

## Slice 2 — Detail editor shell + Revisions tab + Raw JSON tab

**Goal:** build the detail editor shell with three tabs: Fields, Revisions, Raw JSON.

### Item detail editor
- **File:** `apps/studio/src/modules/content/item-detail.tsx`
- **Tabs:**
  - **FieldsTab:** the field edit form (wired into the interface registry in slice 3+)
  - **RevisionsTab:** the revision list, with revert
  - **RawJsonTab:** view/edit the item's raw JSON

### Revisions panel
- **File:** `apps/studio/src/modules/content/revisions-panel.tsx`
- **Features:**
  - List revisions (from the SDK: `listRevisions()`)
  - Show the JSON delta (before/after)
  - A button to revert to an older revision
  - Diff viewer (added in slice 6)

### Raw JSON panel
- **File:** `apps/studio/src/modules/content/raw-json-panel.tsx`
- **Features:**
  - Monaco Editor for viewing/editing raw JSON
  - Validate the JSON before saving
  - Stay in sync with FieldsTab

---

## Slice 3 — Interface registry part 1

**Goal:** build the interface registry and implement the basic interfaces.

### Interface registry
- **File:** `apps/studio/src/modules/content/interfaces/registry.tsx`
- **Contract:** `InterfaceComponent<T>` receives `{ value, onChange, field }`
- **Helper:** `readOptions<T>(field)` reads options out of `field.meta.options`

### Interfaces implemented (Phase A + Phase B slice 3)
| Interface | File | Description |
|-----------|------|-------------|
| `input` | `text.tsx` | Basic text input |
| `input-multiline` | `text.tsx` | Textarea |
| `toggle` | `toggle.tsx` | Boolean toggle |
| `select-dropdown` | `select.tsx` | Select dropdown with options |
| `datetime` | `datetime.tsx` | Date/time picker |
| `json-raw` | `json-raw.tsx` | Monaco Editor for JSON |
| `input-number` | `number.tsx` | Number input |
| `slug` | `slug.tsx` | Slug field with auto-generate |
| `color` | `color.tsx` | Colour picker |
| `rating` | `rating.tsx` | Star rating |
| `tags` | `tags.tsx` | Tag input with autocomplete |

---

## Slice 4 — Interface registry part 2

**Goal:** implement the more complex interfaces: relation, code, wysiwyg, markdown, file, repeater, presentation.

### Interfaces implemented (Phase B slice 4)
| Interface | File | Description |
|-----------|------|-------------|
| `relation-m2o` | `relation-m2o.tsx` | Many-to-one relation selector |
| `relation-o2m` | `relation-many.tsx` | One-to-many relation list |
| `relation-m2m` | `relation-many.tsx` | Many-to-many relation list |
| `code` | `code.tsx` | Code editor (Monaco) |
| `wysiwyg` | `wysiwyg.tsx` | Rich text editor (document.execCommand) |
| `markdown` | `markdown.tsx` | Markdown editor with preview |
| `file` | `file.tsx` | File upload (drag-and-drop, placeholder URL: `lumibase://pending/<name>`) |
| `repeater` | `repeater.tsx` | Repeater field with drag-and-drop (dnd-kit) |
| `presentation-divider` | `presentation.tsx` | Divider UI (read-only) |
| `presentation-notice` | `presentation.tsx` | Notice UI (read-only) |

**Note:** the file interface is UI-only — it does not perform a real upload. TODO: `phase-e/storage`

---

## Slice 5 — Display registry + Raw toggle + Bulk raw editor

**Goal:** build the display registry for the list view, a per-field raw toggle, and the bulk raw editor.

### Display registry
- **File:** `apps/studio/src/modules/content/displays/registry.tsx`
- **Contract:** `DisplayProps<T>` receives `{ value, field, row? }`
- **Purpose:** render field values in the list view (read-only, stateless)

### Displays implemented
| Display | File | Description |
|---------|------|-------------|
| `formatted-value` | `text.tsx` | Basic text display |
| `boolean-icon` | `boolean-icon.tsx` | Icon for a boolean |
| `badge` | `badge.tsx` | Badge for enum/status |
| `relation-related-values` | `relation.tsx` | Show related item values |
| `datetime` | `formatted-date.tsx` | Formatted date/time |
| `color-swatch` | `color-swatch.tsx` | Colour swatch |
| `rating-stars` | `rating-stars.tsx` | Star rating display |
| `labels` | `tags-pills.tsx` | Tag pills |
| `mustache-template` | `mustache.tsx` (slice 6) | Mustache template interpolation |

### Per-field raw toggle
- **File:** `apps/studio/src/modules/content/interfaces/raw-toggle.tsx`
- **Features:**
  - Toggle between the interface component and Monaco Editor (raw JSON)
  - Preserve the user's edits even while the JSON is invalid
  - Wired into item-detail's FieldsTab

### Bulk raw editor
- **File:** `apps/studio/src/modules/content/bulk-raw-editor.tsx`
- **Features:**
  - Select multiple items from the list view
  - Edit the raw JSON of every selected item at once
  - Validate the JSON before saving
  - Wired into items-list behind an "Edit raw (N)" button

---

## Slice 6 — Revisions diff viewer + Mustache display

**Goal:** implement the revision diff viewer and the mustache display template.

### Revisions diff viewer
- **File:** `apps/studio/src/modules/content/revisions-diff.tsx`
- **Features:**
  - Compare a revision's `delta.before` and `delta.after`
  - Highlight changes (added/removed/modified)
  - Toggle between the diff view and raw JSON
  - A "Show unchanged" filter
  - Wired into RevisionsPanel

### Mustache display
- **File:** `apps/studio/src/modules/content/displays/mustache.tsx`
- **Features:**
  - Mustache template interpolation using `field.meta.displayTemplate`
  - Access to sibling fields through the `row` prop
  - Wired into the display registry

---

## Slice 7 — Update docs/features/field-types-and-config.md

**Goal:** update the documentation to reflect what has been implemented.

### Tasks
- [x] Update the interface list to what actually exists
- [x] Update the display list to what actually exists
- [x] Add a note about the raw toggle, bulk raw editor and diff viewer
- [x] Sync with the current code

---

## Dependencies & tech stack

- **React + Vite** — frontend framework
- **@tanstack/react-query** — data fetching & caching
- **@monaco-editor/react** — code editor (JSON, code interface)
- **@lumibase/sdk** — workspace dependency for the API
- **dnd-kit** — drag-and-drop for the repeater
- **Tailwind CSS** — styling
- **Mustache.js** — template interpolation (mustache display)

---

## Where the slice definitions came from

The slice definitions are not in the task docs (`docs/roadmap/tasks.md` only has phases). They were produced by an AI assistant based on:
1. LumiBase Studio's actual requirements
2. Best practices for incremental development
3. A clear separation between: SDK → UI shell → interface registry → display registry → advanced features

**Reference:** the design spec at `docs/features/field-types-and-config.md`
