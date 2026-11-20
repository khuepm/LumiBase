---
version: 3
lastUpdated: 2026-11-20T01:40:56.111Z
sourceLang: en
contentHash: 99c1393a2a14232d
codeVerified: 2026-11-20T01:40:56.111Z
codeVerifiedHash: 99c1393a2a14232d
codeVerifiedClaims: 12
---

# Page composer

> Compose a delivery page from registered blocks, without code. The output is
> plain `lumibase_pages.layoutConfig` JSON, so
> `GET /api/v1/deliver/page/:site_id/:slug` is unchanged. Epic #667, V06 #684.

**Status:** shipped — layout format, write-time validation, block palette API,
the Studio composer (**Pages** in the sidebar) and page preview.

## 1. Register blocks

A page block is an ordinary collection whose fields are the block's schema
(the same idea as a [dynamic zone](./dynamic-zones.md) block template). Mark it
with `meta.pageBlock: true`:

```http
PATCH /api/v1/collections/hero
{ "meta": { "pageBlock": true } }
```

`GET /api/v1/pages/blocks` lists the site's page blocks and their fields. This
is the composer palette. Hidden, encrypted and pii/phi fields are left out:
block data is stored in clear inside the page.

In the Studio: **Data model → (collection) → Display → Use as a page block**.

## 2. Compose a page in the Studio

**Pages** (sidebar) lists the site's pages; **New page** creates one with an
empty composer layout. Open a page to compose it:

- **Blocks** (left) lists the registered page blocks. Pick a region under
  **Add to region**, then click a block to add it at the end of that region.
  **New region** adds a region (lowercase key such as `sidebar`); an empty
  region other than `main` can be removed.
- **Layout** (middle) shows each region's sections in order. Drag a section by
  its handle (the keyboard works too: focus the handle, Space, arrows, Space),
  or use the up/down buttons. The region menu on a section moves it to another
  region. Sections can be duplicated or removed.
- **Section settings** (right) edits the selected section's fields with the
  same editors as item forms, so `blocks` fields inside a block nest further
  blocks. **Visible in** limits the section to some locales (none checked:
  every locale). **Data source** binds the section to a collection's latest
  published items (`data.items` in delivery).
- **Save** stores the layout. The server validates it, and each problem is
  shown on its section with the field it concerns.
- **Preview** opens the page beside the composer (see §5). It reloads after
  each save.

A page created without the composer opens with each section's `id`,
`component`, `data`, `styleConfig` and `source`. Saving it stores them as a
composer layout, which is then validated. The v1 format is strict, so any other
key (a top-level `theme`, a section's `analyticsKey`) cannot be kept: the
composer lists those keys before the first save, so you can move them into a
block's fields first. Section data the block does not define (a field deleted
since, or a legacy key) is listed under **Not part of this block** with a
**Remove** button, because the server refuses it.

## 3. Layout format (v1)

```json
{
  "version": 1,
  "regions": [{ "key": "main" }, { "key": "sidebar", "label": "Sidebar" }],
  "sections": [
    {
      "id": "s1",
      "component": "hero",
      "data": { "title": "Welcome" },
      "styleConfig": { "region": "main" }
    },
    {
      "id": "s2",
      "component": "grid",
      "data": { "heading": "Latest", "cards": [{ "id": "c1", "type": "card", "data": { "label": "One" } }] },
      "styleConfig": { "region": "sidebar", "locales": ["vi"] },
      "source": { "collection": "posts", "limit": 5, "orderBy": "-createdAt" }
    }
  ]
}
```

| Key | Meaning |
|---|---|
| `version: 1` | Marks a composer layout; only these are validated strictly. |
| `regions` | The slots of the page (default: one region, `main`). Keys are unique. |
| `sections[].component` | A registered page block. |
| `sections[].data` | That block's field values, validated against its fields. A `blocks` field inside the block nests further blocks (the block tree). |
| `styleConfig.region` | The region the section renders in (default `main`). |
| `styleConfig.locales` | If set, the section is visible only in these locales. |
| `styleConfig.*` | Any other presentation keys you use, kept as-is. |
| `source` | Optional data binding hydrated by delivery: `collection`, `limit` (≤ 50), `orderBy` (`field` or `-field`), `seo`. Published items only. |

On `POST /api/v1/pages` and `PATCH /api/v1/pages/:id`, a v1 layout is rejected
with `400` when a block is not registered, block data does not match its fields
(unknown keys, missing required values, wrong types, nested block errors),
a region is undeclared, a section id repeats, a `source` names a missing
collection or asks for anything other than published items, or block data
fills an encrypted or pii/phi field. Each error has a `field` path such as
`sections.1.data.title`. Layouts without `version` are stored untouched, as
before.

## 4. Render it

Delivery returns `sections` in order with `id`, `component`, `styleConfig` and
`data` (plus `data.items` for a section with a `source`). Pick a region's
sections for the current locale with the helper from `@lumibase/contracts`:

```ts
import { selectPageSections } from '@lumibase/contracts';

const page = await fetch(`${CMS}/api/v1/deliver/page/${siteId}/home`).then((r) => r.json());
const main = selectPageSections(page.sections, { region: 'main', locale: 'vi' });
const sidebar = selectPageSections(page.sections, { region: 'sidebar', locale: 'vi' });
```

A section without `styleConfig.region` belongs to `main`; one without
`styleConfig.locales` shows in every locale.

## 5. Preview

Set **Settings → Preview → Page URL** (`pageUrl`, for example
`https://www.example.com/{slug}`, or `PUT /api/v1/preview/settings`) so the
composer can open the page beside the editor. Pages are public, so no preview
token is involved. `{slug}` keeps the `/` separators of a nested slug (`about/team`).

Saving a page drops the site's cached page payloads (app cache and edge), but
a CDN in front of your own frontend may still hold the old page. Have your
frontend fetch `/api/v1/deliver/page/...?preview=true` when it renders inside
the Studio frame: preview reads skip every cache and answer
`Cache-Control: no-store`, so a just-saved layout shows at once. The template
follows the same rules as a collection's [Preview URL](./visual-editing.md):
absolute `http(s)`, known placeholders only.
