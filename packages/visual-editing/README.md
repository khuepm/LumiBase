# @lumibase/visual-editing

Click-to-edit overlay and origin-validated `postMessage` bridge between the
LumiBase Studio preview pane and your frontend (epic #667).

```ts
import { enableVisualEditing, fieldAttributes } from '@lumibase/visual-editing';

// Only in draft/preview mode. Exact Studio origin — never '*'.
const handle = enableVisualEditing({
  studioOrigins: ['https://studio.example.com'],
  enabled: isDraftMode,
  onPatch: ({ collection, itemId, fields }) => { /* re-render those fields */ },
  onReload: () => router.refresh(),
});

// Mark editable elements:
<h1 {...fieldAttributes({ collection: 'posts', itemId: post.id, field: 'title' })}
    data-lumibase-live="text">{post.data.title}</h1>
```

- Messages are accepted only from `window.parent`, from an origin on the exact
  allowlist, within 64 KiB, and when they match the strict Zod schema
  (`@lumibase/visual-editing/protocol`). Everything else is dropped and passed
  to `onReject` (default: `console.warn`).
- Outbound messages are always posted to an explicit origin.
- Patches are field-level, coalesced once per animation frame, and bounded:
  a backlog over `maxPendingFields` becomes a single reload. `data-lumibase-live="text"`
  elements are updated through `textContent` only — a patch is never HTML.
- No-op outside an iframe or when `enabled` is false. ≤ 15 kB gzip (checked in CI).

Guide: `docs/en/features/visual-editing.md` · Threat model:
`docs/en/architecture/decisions/adr-014-preview-bridge-threat-model.md`.
