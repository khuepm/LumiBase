---
version: 1
lastUpdated: 2026-11-18T06:17:04.462Z
sourceLang: en
contentHash: cf046ee898a17fad
codeVerified: 2026-11-18T06:17:04.462Z
codeVerifiedHash: cf046ee898a17fad
codeVerifiedClaims: 12
---

# Page composer

> Compose a delivery page from registered blocks, without code. The output is
> plain `lumibase_pages.layoutConfig` JSON, so
> `GET /api/v1/deliver/page/:site_id/:slug` is unchanged. Epic #667, V06 #684.

**Status:** the layout format, write-time validation, the block palette API and
the page preview URL setting are shipped. The Studio composer screen follows in
a separate change.

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

## 2. Layout format (v1)

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

## 3. Render it

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

## 4. Preview

Set the page URL template (`pageUrl`, for example
`https://www.example.com/{slug}`) with `PUT /api/v1/preview/settings`, so the
composer can open the page beside the editor. The template follows the same rules as a collection's
[Preview URL](./visual-editing.md): absolute `http(s)`, known placeholders
only.
