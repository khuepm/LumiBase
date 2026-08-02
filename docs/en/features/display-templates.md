---
version: 1
lastUpdated: 2026-07-25T08:16:45.923Z
sourceLang: vi
translatedFrom: vi
sourceHash: 966520420fa8b01d
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T08:16:45.923Z
codeVerifiedHash: 966520420fa8b01d
codeVerifiedClaims: 2
---

# Display Templates

> A Display Template is the rule for rendering an item into a string or a component — used in list views, relation pickers, detail headers, and breadcrumbs.

## 1. Two template tiers

### 1.1 Mustache (simple, the default)
- Stored in `collections.displayTemplate`, e.g. `"{{title}} — {{status | upper}}"`.
- Built-in filters: `upper`, `lower`, `date('YYYY-MM-DD')`, `truncate(50)`, `default('—')`.
- Nested references work: `{{author.first_name}} {{author.last_name}}` (auto-joins when a relation exists).

### 1.2 Component template (advanced, USP)
- Stored as a JSON DSL:
```json
{
  "kind": "component-template",
  "template": [
    { "if": "$.cover", "render": { "type": "Image", "src": "$.cover.url", "size": "sm" } },
    { "render": { "type": "Stack", "direction": "col", "children": [
      { "type": "Text", "value": "$.title", "variant": "title" },
      { "type": "Row", "children": [
        { "type": "Badge", "value": "$.status", "variant": "$status_variant" },
        { "type": "Text", "value": "by {{author.full_name}}", "muted": true }
      ]}
    ]}}
  ]
}
```
- The client-side renderer uses CVA tokens (`packages/ui`).
- Conditions are evaluated with JSONata.

## 2. Where they are used

- **Tabular list view**: a cell template per column (overriding the display).
- **Cards/Kanban layout**: the card template *is* a component template.
- **Detail header**: an optional template replacing the default title.
- **Relation picker**: rendering the related item.
- **Delivery API**: returns an extra `__display` field when the request asks for `?fields=*,__display`.

## 3. UI editor

- In Collection settings → the **Display Template** tab:
  - Mustache mode: a textarea with autocomplete for field names and filters.
  - Component mode: a GUI block-based editor (drag a block, set bindings) plus a JSON tab.
- Live preview against 3 sample items (first/last/random).

## 4. Server-side rendering

- `POST /utils/render-template` with body `{ template, items }` → returns an array of `__display` values.
- Cached by `(siteId, collectionId, templateHash, itemId, updatedAt)`.

## 5. Security

- A template can only reach fields the user may read; a masked field renders through the `default` filter instead.

## 6. Tasks: Phase MVP-B (mustache) + POST-MVP-F (component DSL).
