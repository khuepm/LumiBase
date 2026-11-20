---
version: 3
lastUpdated: 2026-11-20T05:35:06.536Z
sourceLang: en
contentHash: b9fec6046c5c723e
codeVerified: 2026-11-20T05:35:06.536Z
codeVerifiedHash: b9fec6046c5c723e
codeVerifiedClaims: 6
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
only (`source.status` is ignored), clamps `limit` to 50 items, and merges the
hydrated rows into `data.items`. Encrypted fields and fields classified `pii`
or `phi` are left out of every item: a page is public, so delivery has no
caller to decrypt for.

A page writer can only bind a `source` to a collection they can read in full:
a read permission on every field with no row filter. `POST /api/v1/pages` and
`PATCH /api/v1/pages/:id` answer `403 SOURCE_FORBIDDEN` otherwise. Bindings a
page already has are not re-checked, so an editor can still change a page an
administrator bound to a collection.

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
