---
sourceLang: en
version: 1
lastUpdated: 2026-11-19T06:34:14.857Z
contentHash: 79e001eacf6a5421
codeVerified: 2026-11-19T06:34:14.857Z
codeVerifiedHash: 79e001eacf6a5421
codeVerifiedClaims: 16
---

# Figma import: from a frame to a block

Point LumiBase at a Figma frame and it creates a **block template**: a hidden
collection whose fields come from the frame's layers, with a display
template. Add it to a `blocks` field and editors can use it in Studio right
away (#758, epic #677). The frame's colours and corner radius are also mapped
to Studio theme tokens, which an agent can apply after approval.

Blocks themselves are described in [Dynamic zones](./dynamic-zones.md).

## 1. Store a Figma token

Create a personal access token in Figma (Settings → Security → Personal
access tokens, scope *File content: read*), then store it for the site:

```http
PUT /api/v1/integrations/figma/token
{ "token": "figd_…" }
```

It is kept as the site's encrypted tool secret `FIGMA_TOKEN`, in the same
vault agent tools use, and never returned. `GET /api/v1/integrations/figma`
answers `{ hasToken }`; `DELETE /api/v1/integrations/figma/token` removes it.
Storing it needs the deployment's key provider.

## 2. Preview the mapping

In Figma, select the frame and use *Copy link to selection*. Then:

```http
POST /api/v1/integrations/figma/preview
{ "url": "https://www.figma.com/design/<file>/<name>?node-id=12-34" }
```

The answer is the draft (`collection`, `label`, `fields`, `displayTemplate`,
`tokens`, `theme`, `warnings`, `source`). Nothing is written.

### How layers become fields

- If any layer in the frame is named `#something`, **only** those layers map,
  and `something` is the field name. This is the way to control the result.
- Otherwise every visible text layer and every layer with an image fill maps,
  named after the layer.
- A text layer becomes:
  - `string` with the `input` interface for a single line of up to 80
    characters;
  - `text` with `input-multiline` for anything longer.

  The Figma text becomes the field note.
- A text layer named, or inside a layer named, `button`, `btn`, `cta` or
  `link` also gets a `<name>_url` field for the link target.
- A layer with an image fill becomes a `file` field.
- Names become snake_case. `id`, `status`, `sort` and other reserved names get
  an `f_` prefix, and duplicates get `_2`, `_3`…. At most 40 fields; the rest
  are listed in `warnings`. Hidden layers are skipped.
- The collection is `block_<frame name>` unless you pass `collection`, and the
  display template is `{{<first single-line text field>}}`.

## 3. Import

```http
POST /api/v1/integrations/figma/import
{
  "url": "https://www.figma.com/design/<file>/<name>?node-id=12-34",
  "collection": "block_hero",
  "addToBlocksField": { "collection": "landing_pages", "field": "sections" }
}
```

This creates the collection (`hidden`, icon `widgets`) and its fields in one
transaction. Where it came from is recorded in `meta.figma`. With
`addToBlocksField`, the block is also appended to that `blocks` field's
`allowedBlocks`, so editors can add it immediately.

It answers `409 COLLECTION_EXISTS` rather than changing an existing
collection, and `404 BLOCKS_FIELD_NOT_FOUND` when the target is not a
`blocks` field. Figma errors map to `422 FIGMA_TOKEN_REJECTED`,
`404 FIGMA_NOT_FOUND`, `422 FIGMA_NOT_A_FRAME`, `429 FIGMA_RATE_LIMITED`,
`502 FIGMA_UNAVAILABLE`, and a link that is not a Figma frame link to
`400 FIGMA_URL_INVALID`.

## 4. Design tokens and the Studio theme

The preview's `tokens` list:

- the frame's solid colours by use (`frame`, `text`, `button`, `fill`);
- font families and sizes;
- corner radii.

`theme` maps them to Studio theme tokens:

| Token | From |
|---|---|
| `--primary` (and `--ring`) | the most used colour on a button / CTA / link layer, else the most used saturated colour |
| `--primary-foreground` | white or near-black, whichever contrasts with `--primary` |
| `--background` | the frame's fill |
| `--foreground` | the most used text colour |
| `--radius` | the most used corner radius, in px |

The values are in the form `PATCH /api/v1/site` accepts in `themeOverrides`,
so you can apply them yourself, or let an agent do it:

- `mapDesignTokens({ tokens })` returns the same mapping. It is read-only and
  needs `config:read`.
- `applyThemeOverrides({ themeOverrides })` replaces the site's theme
  overrides and needs `config:write`. It changes every editor's Studio, so it
  is a governed skill: it waits for approval (HITL) like other control-plane
  operations. Values are checked against the Studio token whitelist.

## API

Site admins only, under `/api/v1/integrations/figma`:

| Method | Path | |
|---|---|---|
| `GET` | `/` | `{ hasToken }` |
| `PUT` / `DELETE` | `/token` | store (`{ token }`) / remove the Figma token |
| `POST` | `/preview` | `{ url, collection?, label? }` → draft, tokens and theme; no writes |
| `POST` | `/import` | `{ url, collection?, label?, addToBlocksField? }` → `201` with the draft |

## Multi-tenancy

No new table:

- The token is a per-site tool secret: encrypted, with additional
  authenticated data bound to the site and the name.
- The imported collection and fields belong to the calling site, like any
  schema change.
- Figma is called only with that site's token.

## Not done yet

- A Studio dialog for the import (it is API and agent only for now).
- Components with variants (`COMPONENT_SET`) import the selected node only;
  each variant is imported separately.
- Figma variables and styles are not read; tokens come from the frame's own
  layers.
