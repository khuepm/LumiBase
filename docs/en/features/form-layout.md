---
version: 2
lastUpdated: 2026-11-15T11:59:59.297Z
sourceLang: en
contentHash: 652c956ad412697f
codeVerified: 2026-11-15T17:12:05.588Z
codeVerifiedHash: 652c956ad412697f
codeVerifiedClaims: 24
---

# Form Layout: Tabs, Groups and Conditional Fields

A collection's item form can be arranged into **tabs**, **groups** (optionally collapsible) and **dividers**, and any of those, or a single field, can be shown only when other fields hold certain values. The layout is schema-level configuration: it is stored in the collection's `meta.formLayout`, validated with Zod, and needs no migration.

A collection without a layout renders exactly as before. Fields the layout does not place keep rendering in a default section above it, so you can adopt a layout one field at a time.

## Building a layout in the Studio

Open **Data model → _collection_ → Form layout**.

- **Add tab / Add group / Add divider** create nodes at the top level. Inside a container, **+ group** and **+ divider** nest a node.
- Drag a field from **Unplaced fields** onto a container's drop zone (or the top-level zone). Without a pointer, use the field's **Place…** picker. Placing a field that is already placed moves it, so a field can never appear twice.
- The **settings** button on a node opens its visibility rules, the required/hidden-value options, the collapse options (groups) and a **Move to** picker. The arrows reorder siblings.
- **Visibility** is a rule list ("show when all/any of these rules match"). Conditions that need `not` or nesting are edited with **Edit as JSON**.
- **Save layout** validates in the browser first (the same validator the server runs); **Remove layout** returns the collection to the classic form.

Consecutive tab nodes form one tab strip. The item editor renders tabs as WAI-ARIA tabs: one tab stop with a roving `tabindex`, Arrow Left/Right (wrapping), Home and End, `aria-selected`/`aria-controls` on each tab and `role="tabpanel"` on the panel. A tab that contains an invalid field shows an error badge with the error count. Collapsible groups expose `aria-expanded`; dividers render as `role="separator"`.

## Layout format

```json
{
  "version": 1,
  "nodes": [
    {
      "type": "tab", "id": "content", "label": "Content",
      "children": [
        { "type": "field", "field": "title" },
        { "type": "field", "field": "kind" },
        { "type": "divider", "id": "sep", "label": "Link details" },
        {
          "type": "group", "id": "link", "label": "Link",
          "collapsible": true, "collapsed": false,
          "visibleWhen": { "field": "kind", "op": "eq", "value": "link" },
          "skipRequiredWhenHidden": true,
          "children": [{ "type": "field", "field": "url" }]
        }
      ]
    },
    { "type": "tab", "id": "seo", "label": "SEO",
      "children": [{ "type": "field", "field": "seo_title", "hiddenValue": "clear" }] }
  ]
}
```

| Node | Keys |
|---|---|
| `field` | `field` (field key), `visibleWhen?`, `skipRequiredWhenHidden?`, `hiddenValue?` |
| `tab` | `id`, `label`, `children`, `visibleWhen?`, `skipRequiredWhenHidden?`, `hiddenValue?` |
| `group` | `id`, `label?`, `collapsible?`, `collapsed?`, `children`, `visibleWhen?`, `skipRequiredWhenHidden?`, `hiddenValue?` |
| `divider` | `id`, `label?`, `visibleWhen?` |

Validation rules (rejected with `INVALID_FORM_LAYOUT`, HTTP 400):

- every field is placed **at most once**, and every placed field must exist in the collection;
- every field a condition reads must exist, and a field cannot be conditioned on its own value;
- node `id`s are unique (lowercase letters, digits, `-`, `_`);
- containers nest at most 6 levels, a layout has at most 500 nodes, and a condition at most 8 levels / 64 nodes;
- unknown keys and unknown node types are refused (`strict` schemas).

Renaming a field rewrites its placements and condition references. Deleting a field leaves a dangling reference: the editor ignores it, and the builder drops the placement on load (conditions that read the deleted field must be fixed before the next save).

## Conditions

`visibleWhen` is a declarative tree evaluated against the values of the item's own fields. There is no `eval`, no `Function` and no regex built from configuration: it is data interpreted by a `switch`, and only the item's own keys are read (never the prototype chain).

```json
{ "and": [
  { "field": "type", "op": "in", "value": ["video", "audio"] },
  { "not": { "field": "url", "op": "empty" } }
] }
```

| `op` | `value` | True when |
|---|---|---|
| `eq` / `neq` | one scalar | strictly equal / not equal (no type coercion; unset equals `null`) |
| `in` / `nin` | array | the value is / is not in the list (multi-value fields: any overlap) |
| `empty` / `nempty` | none | unset, `null`, `""`, `[]`, `{}` count as empty (`0` and `false` do not) |
| `gt` `lt` `gte` `lte` | number or string | both sides are numbers, or both strings (ISO dates order correctly); mixed types are false |
| `contains` | one scalar | an array field contains it, or a string field contains the substring |

Combinators: `and` (all, at least one child), `or` (any), `not`. A node is hidden when its own condition is false **or** any ancestor is hidden.

The engine lives in `packages/contracts/src/form-layout/` and the Studio and the CMS import the same code, so the form hides exactly the fields the server treats as hidden.

## Required fields and hidden values

**Required validation.** A field hidden by a condition is still required by default. It skips the required check **only** when `skipRequiredWhenHidden: true` is set on the field node or inherited from the nearest ancestor that sets it (a nearer explicit `false` wins). Type and rule checks still run on any value a hidden field carries. On create the condition reads the submitted data; on update (`PATCH`) it reads the stored item merged with the patch, so a patch that only clears `url` is still checked against the stored `kind`.

The Studio runs the same rule before saving and shows the error inline and on the tab badge; a server `VALIDATION` error is mapped back to its field the same way.

**Stale values (`hiddenValue`).** When a field is hidden, its old value can be:

- `keep` (default): stored untouched, so it reappears if the field is shown again;
- `clear`: removed from the item on save.

`hiddenValue` inherits like `skipRequiredWhenHidden`. The server applies it on create and on every update that writes data (a status-only update leaves data alone). A value the required rule still demands (required, not skipping) is never cleared. The clear is a schema rule and applies whoever writes the item, including API keys and agents.

A stored layout that does not parse is ignored: every field falls back to the default section and required rules apply in full.

## API

| Method | Path | Permission | Body / response |
|---|---|---|---|
| `GET` | `/api/v1/collections/:name/form-layout` | `schema:read` | `{ data: { layout: FormLayout \| null } }` |
| `PUT` | `/api/v1/collections/:name/form-layout` | `schema:update` | body `{ layout: FormLayout \| null }` → `{ data: { layout } }` |

`PUT` with `null` removes the layout. Other `meta` keys are preserved. Writing `meta.formLayout` through `PATCH /api/v1/collections/:name` or `PUT /api/v1/collections/:name/schema` runs the same validation. The SDK exposes `client.schema.getFormLayout(name)` and `client.schema.setFormLayout(name, layout)`.

## Multi-tenancy

The layout is a key in the collection row (`lumibase_collections`, which carries `site_id`), so it is isolated per site like the rest of the collection's configuration: every read and write goes through `SchemaService`, whose queries are scoped by site, and no new table, cache key or shared resource is added. The condition engine is code shared by the deployment; it holds no state. Verified by the site-scoped `SchemaService` lookups the endpoints reuse (`getCollection`, `listFields`) and by `apps/cms/src/services/__tests__/form-layout-schema.test.ts`.

## Source

- Condition engine and layout schema: `packages/contracts/src/form-layout/condition.ts`, `packages/contracts/src/form-layout/layout.ts`
- Server validation: `apps/cms/src/services/validation.ts`, `apps/cms/src/services/item-service.ts`, `apps/cms/src/services/schema-service.ts`, `apps/cms/src/routes/collections.ts`
- Studio: `apps/studio/src/modules/content/form-layout-renderer.tsx`, `apps/studio/src/modules/data-model/form-layout-tab.tsx`
