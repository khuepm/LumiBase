---
version: 2
lastUpdated: 2026-11-21T00:04:50.178Z
sourceLang: en
contentHash: 86d9efbbcd644939
codeVerified: 2026-11-21T00:04:50.178Z
codeVerifiedHash: 86d9efbbcd644939
codeVerifiedClaims: 18
---

# Live preview & visual editing

> The Studio item editor shows your real frontend beside the form, updates it
> as you type, reloads it when you save, and lets you click an element on the
> page to jump to its field. Epic #667; security model in
> [ADR-014](../architecture/decisions/adr-014-preview-bridge-threat-model.md).

**Status:** shipped — preview tokens (V01), Studio preview pane (V02),
`@lumibase/visual-editing` overlay (V03), version/release/locale preview (V04
API), CSP and threat model (V05). Not yet: a "Preview release" button in the
Studio (there is no release view yet — use the API), and the visual page
composer (V06, post-v1).

## 1. How it fits together

```
Studio item editor ──mint──▶ POST /api/v1/preview/token ──▶ { token, url }
      │                                                         │
      │  iframe (sandboxed) ◀──────────── url ───────────────────┘
      ▼
Your frontend /api/preview?token=…  ──server-side──▶ GET /api/v1/deliver/preview/:site_id
      │   (draft mode on, token in an httpOnly cookie)
      ▼
Page rendered from the preview token  ◀──postMessage──▶  Studio (patch / reload / focus)
```

## 2. Enable it for a collection

1. **Data model → (collection) → Display → Preview URL.** Enter the URL of the
   page that renders an item, with placeholders:

   | Placeholder | Value |
   |---|---|
   | `{token}` | the preview token (required for draft content) |
   | `{id}` | item id |
   | `{slug}` | the item's `slug` field, if it has one |
   | `{collection}` | collection name |
   | `{locale}` | preview locale |
   | `{version}` | content version key |
   | `{release}` | release id |

   Example: `http://localhost:3000/api/preview?token={token}&id={id}`.
   Only absolute `http(s)` URLs are accepted (checked by the CMS on
   `PATCH /api/v1/collections/:name`); every value is URL-encoded.
2. Open an item and click **Preview**. The pane opens beside the form:
   - drag the divider or focus it and use ←/→, Home/End, Enter (reset);
   - pick Desktop / Tablet (768 px) / Mobile (390 px);
   - edits stream to the page (150 ms debounce); saving reloads it.

## 3. Settings → Preview

- **Allowed origins** — the Studio frames the template's own origin. Add other
  exact origins (`https://www.example.com`, no path or wildcard) only if your
  preview redirects to them. Site admins only.
- **Token lifetime** — 60–3600 s, default 900.
- **Live tokens** — revoke one, or **Rotate** to revoke every live token of
  the site. Admins see all tokens; editors see their own.

## 4. Preview tokens

A token is a site-scoped HS256 JWT plus a server-side row (only its SHA-256 is
stored). It reads with the permissions of the editor who minted it,
re-checked on every read. Any failure — wrong site, expired, revoked, creator
lost access — returns the same `401`.

```http
POST /api/v1/preview/token
Authorization: Bearer <studio session>

{ "collection": "posts", "itemId": "itm_1", "locale": "vi" }
→ 201 { "data": { "id": "…", "token": "eyJ…", "expiresAt": "…", "url": "https://…" } }
```

Target either one item (`collection` + `itemId`, optionally `versionKey`) or a
whole release (`releaseId`); `locale` is carried to the frontend.

| What you preview | What the frontend sees |
|---|---|
| Item | the item's current state, draft included |
| Item + `versionKey` | the version's data; **related items that have a version with the same key read from it too** |
| Release | every member as it will publish (pinned revision + target status); members the release archives are hidden; everything else as live |

## 5. Read draft content in your frontend

Send the token in the `x-lumibase-preview` header (or `?__preview=`), from your
**server**:

```http
GET /api/v1/deliver/preview/:site_id                         # what the token targets (+ the item)
GET /api/v1/deliver/preview/:site_id/items/:collection        # live items + the preview overlay
GET /api/v1/deliver/preview/:site_id/items/:collection/:id    # one item through the overlay
GET /api/v1/deliver/preview/:site_id/page/:slug               # a page, its section sources through the overlay
```

Responses are `private, no-store` and `noindex`. The page read returns the same
sections as `GET /deliver/page`, wrapped in `{ data, meta }`; each section
`source` shows live items plus the token's draft, version or release. The
public page route never shows unpublished items, whatever the layout says
(#1006). See
`examples/nextjs-blog` for a complete Next.js setup:
`src/app/api/preview/route.ts` checks the token server-side, enables draft
mode, keeps the token in an `httpOnly` cookie and redirects;
`src/app/posts/[id]/page.tsx` reads through the token while draft mode is on.

**Allow the Studio to frame your site** — and nobody else:

```
Content-Security-Policy: frame-ancestors 'self' https://studio.example.com
```

## 6. Click-to-edit overlay (`@lumibase/visual-editing`)

```ts
import { enableVisualEditing, fieldAttributes } from '@lumibase/visual-editing';

const handle = enableVisualEditing({
  studioOrigins: ['https://studio.example.com'], // exact origins, never '*'
  enabled: isDraftMode,
  onPatch: ({ fields }) => { /* optional: re-render changed fields */ },
  onReload: () => router.refresh(),
});

<h1 {...fieldAttributes({ collection: 'posts', itemId: post.id, field: 'title' })}
    data-lumibase-live="text">{post.data.title}</h1>
```

- Hover draws an outline; a click focuses that field in the Studio.
- Elements with `data-lumibase-live="text"` update as you type (as text,
  never HTML); everything else goes through `onPatch`/`onReload`.
- Messages from any other origin or window, over 64 KiB, or not matching the
  schema are dropped and reported to `onReject`.
- Inert outside an iframe or when `enabled` is false; ≤ 15 kB gzip.

## 7. Operator settings

| Setting | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | required in production | Preview site keys derive from it; rotating it invalidates every preview token. |
| `LUMIBASE_STUDIO_FRAME_SRC` | `https: http://localhost:* http://127.0.0.1:*` | `frame-src` of the Studio HTML served by the CMS. List exact origins to narrow it, or `'none'` to disable preview framing. |

Desktop/mobile shell: the pane works in the Tauri shell; in bundled mode the
Studio origin is `tauri://localhost`, so add it to your frontend's
`frame-ancestors` if editors preview from the desktop app.
