---
version: 1
lastUpdated: 2026-08-02T19:14:29.861Z
sourceLang: en
contentHash: ff4339b1b2f269c5
codeVerified: 2026-08-02T19:14:34.597Z
codeVerifiedHash: ff4339b1b2f269c5
codeVerifiedClaims: 12
---

# Full-text Search

LumiBase integrates **MeiliSearch** as its full-text search backend, behind the
`SearchProvider` interface in `@lumibase/runtime`.

## Backend per runtime

| Runtime | Backend |
|---------|---------|
| Cloudflare | MeiliSearch Cloud over HTTP |
| Docker | Self-hosted MeiliSearch (port 7700, persistent volume) |

Both implement the same `SearchProvider` interface — application code never
needs to know which one is active.

To self-host the Docker backend on AWS (Lightsail / ECS Fargate) instead of
running it alongside the CMS, see
[Deploying MeiliSearch on AWS](../deployment/meilisearch-aws.md).

## API endpoint

`GET /api/v1/search?q=...&collection=...&filter=...&sort=...&limit=...&offset=...`

| Param | Description |
|-------|-------------|
| `q` (required) | Query string |
| `collection` | Restrict to one collection. **Omit for cross-collection (global) search.** |
| `filter` | MeiliSearch filter expression |
| `sort` | Sort directives, comma-separated (e.g. `_updatedAt:desc`) |
| `limit` | Default 20, max 200 |
| `offset` | Pagination cursor |

### Single-collection response

```jsonc
{
  "data": [ { "id": "...", "_collection": "articles", "_title": "...", "_updatedAt": "...", /* ...fields */ } ],
  "meta": { "totalHits": 12, "processingTimeMs": 3, "collection": "articles", "query": "ha noi", "limit": 20, "offset": 0 }
}
```

The requested `collection` is validated against the caller's own collections; an
unknown collection returns `404`.

### Cross-collection (global) response

When `collection` is omitted, the query fans out across every collection of the
caller's site (one scoped search each) and the hits are merged, each tagged with
its `_collection`. The fan-out is capped at 20 collections per request.

```jsonc
{
  "data": [ { "_collection": "articles", "id": "...", "_title": "..." }, { "_collection": "pages", "id": "...", "_title": "..." } ],
  "meta": { "totalHits": 7, "query": "ha noi", "collections": ["articles", "pages"], "truncated": false, "limit": 20, "offset": 0 }
}
```

This powers the Studio global command palette (⌘K).

### SDK

```typescript
import { search } from "@lumibase/sdk";

// Cross-collection (global)
const { data, meta } = await client.request(search("ha noi"));
// Single collection
await client.request(search("ha noi", { collection: "articles", limit: 10 }));
```

## Vietnamese support

MeiliSearch normalizes diacritics out of the box, so a query typed **without
diacritics matches text with diacritics** — `ha noi` → "Hà Nội", `da nang` →
"Đà Nẵng". No extra configuration is needed for this.

On top of that, indexes are configured (`defaultIndexSettings`) with:

- **Vietnamese stop words** (`và`, `của`, `là`, `các`, …) to improve relevance.
- **Raised typo-tolerance thresholds** (`oneTypo: 4`, `twoTypos: 8`) — Vietnamese
  has many short tokens where aggressive fuzzy matching adds noise.
- A normalized **`_title`** boosted ahead of the collection's own searchable fields.

## Auto-indexing

Hooks run automatically:

- **Item create** → enqueue an index job via `QueueProvider`.
- **Item update** → re-index.
- **Item delete** → remove from the index.

The `content-indexing` worker (`registerContentIndexingWorker`, wired in
`serve.ts`) consumes the queue and calls `searchProvider.index(...)` /
`delete(...)`. When no queue is configured, `ItemService` indexes inline.

### Reindex CLI

Rebuild indexes from the database (bootstrap a new instance, or rebuild after
changes):

```bash
lumibase reindex                      # every collection of every site
lumibase reindex --site <siteId>      # one site
lumibase reindex --site <siteId> --collection posts
```

Requires the same env as the server (`DATABASE_URL`, `MEILISEARCH_HOST`,
`MEILISEARCH_API_KEY`, `LUMIBASE_RUNTIME`).

## SearchProvider interface

```typescript
interface SearchProvider {
  index(collection: string, documents: Doc[]): Promise<void>;
  search(collection: string, query: string, options?: SearchOptions): Promise<SearchResult>;
  delete(collection: string, ids: string[]): Promise<void>;
  getIndex(collection: string): Promise<IndexInfo>;
  configureIndex(collection: string, settings: SearchIndexSettings): Promise<void>;
}

interface SearchOptions {
  filter?: string;
  sort?: string[];
  limit?: number;
  offset?: number;
  attributesToRetrieve?: string[];
}
```

Filter, sort and pagination are forwarded directly to MeiliSearch — see the
[MeiliSearch search reference](https://www.meilisearch.com/docs/reference/api/search)
for syntax.

## Multi-tenancy

The physical index name is always `{siteId}__{collection}` (see
`searchIndexName`). Every index/search/delete call goes through this helper, and
the `/search` route additionally validates the requested collection belongs to
the caller's site — so a tenant can neither name nor reach another tenant's index.

## Configuration

```bash
# Docker
MEILISEARCH_HOST=http://meilisearch:7700
MEILISEARCH_API_KEY=<master key>

# Cloudflare (MeiliSearch Cloud)
MEILISEARCH_HOST=https://<your-instance>.meilisearch.io
MEILISEARCH_API_KEY=<cloud api key>
```

## Alternatives

See `apps/docs/content/guides/tooling-recommendations.md` for alternative search
backends (Typesense, Elasticsearch) — swap by writing a new `SearchProvider`
adapter.
