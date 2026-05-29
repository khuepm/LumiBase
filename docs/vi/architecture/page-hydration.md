# Page Hydration API Contract

To solve the "2-roundtrip" problem, the CMS provides a BFF (Backend-for-Frontend) endpoint for Next.js.

## Endpoint: `GET /api/v1/deliver/page/:site_id/:slug`

### Workflow triggered by API:
1. **Fetch Page Config:** Retrieve the `pages` record matching `:slug` and `:site_id`.
2. **Analyze Dependencies:** Read `layoutConfig.sections`. Identify which collections are needed (e.g., "Hero section needs latest 3 items from `posts` collection").
3. **Parallel Fetch:** Execute Drizzle DB queries to fetch the required collection data.
4. **Merge & Deliver:** Combine layout configuration and data into one unified JSON response.

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
        "heading": "Welcome to Lumibase",
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