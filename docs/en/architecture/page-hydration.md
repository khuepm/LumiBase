---
version: 4
lastUpdated: 2026-11-21T00:04:47.630Z
sourceLang: en
contentHash: 5e14579546207248
codeVerified: 2026-11-21T00:04:47.630Z
codeVerifiedHash: 5e14579546207248
codeVerifiedClaims: 8
---

# Page Hydration API Contract

To solve the "2-roundtrip" problem, the CMS provides a BFF (Backend-for-Frontend) endpoint for Next.js.

## Endpoint: `GET /api/v1/deliver/page/:site_id/:slug`

### Workflow triggered by API:
1. **Fetch Page Config:** Retrieve the `pages` record matching `:slug` and `:site_id`.
2. **Analyze Dependencies:** Read `layoutConfig.sections`. Identify which collections are needed (e.g., "Hero section needs latest 3 items from `posts` collection").
3. **Parallel Fetch:** Execute Drizzle DB queries to fetch the required collection data.
4. **Merge & Deliver:** Combine layout configuration and data into one unified JSON response.

Sections can declare a data source:

```json
{
  "id": "featured-posts-1",
  "component": "PostGrid",
  "data": { "heading": "Featured posts" },
  "source": {
    "collection": "posts",
    "limit": 3,
    "orderBy": "-created_at"
  }
}
```

The delivery resolver scopes the query by `site_id`, serves published items
only, in every layout shape (`source.status` is never honoured), clamps `limit`
to 50 items, and merges the
hydrated rows into `data.items`. Encrypted fields and fields classified `pii`
or `phi` are left out of every item: a page is public, so delivery has no
caller to decrypt for.

A page writer can only bind a `source` to a collection they can read in full:
a read permission on every field with no row filter. `POST /api/v1/pages` and
`PATCH /api/v1/pages/:id` answer `403 SOURCE_FORBIDDEN` otherwise. Bindings a
page already has are not re-checked, so an editor can still change a page an
administrator bound to a collection.

A `source` cannot ask for drafts (#1006). `POST` and `PATCH` refuse a
`source.status` other than `published` with `400 VALIDATION`, one error per
section with its `field` path (`sections.1.source.status`). A page stored
before that rule keeps its layout, and delivery ignores the stored status, so
no migration is needed; saving the layout again without it clears the error.
`?preview=true` and `?draft=true` on the public route only skip caches: they
never unlock drafts. To see a page with unpublished items, read it through a
preview token, `GET /api/v1/deliver/preview/:site_id/page/:slug` (see
[visual editing](../features/visual-editing.md)): each source then shows live
items plus the token's draft, version or release, read with the token
creator's permissions, and the response is `private, no-store`.

### Expected JSON Response Structure:
```json
{
  "page": {
    "title": "Home Page",
    "slug": "home"
  },
  "sections": [
    {
      "id": "hero-section-1",
      "component": "HeroBanner",
      "styleConfig": {
        "variant": "primary",
        "spacing": "large"
      },
      "data": {
        "heading": "Welcome to LumiBase",
        "cta_link": "/about"
      }
    },
    {
      "id": "featured-posts-1",
      "component": "PostGrid",
      "styleConfig": {
        "columns": 3
      },
      "data": {
        "items": [
          { "id": "nano123", "title": "Post 1", "image": "https..." },
          { "id": "nano456", "title": "Post 2", "image": "https..." }
        ]
      }
    }
  ]
}
```
