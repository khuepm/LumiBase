# Full-text Search

LumiBase tích hợp **MeiliSearch** làm full-text search backend, qua `SearchProvider` interface trong `@lumibase/runtime`.

## Backend theo runtime

| Runtime | Backend |
|---------|---------|
| Cloudflare | MeiliSearch Cloud qua HTTP |
| Docker | MeiliSearch self-host (port 7700, persistent volume) |

Cả hai cùng implement `SearchProvider` interface — code application không cần biết.

## API endpoint

`GET /api/v1/search?q=...&collection=...&filter=...&sort=...&limit=...&offset=...`

| Param | Mô tả |
|-------|-------|
| `q` (required) | Query string |
| `collection` | Limit theo collection name |
| `filter` | MeiliSearch filter expression |
| `sort` | Field name + direction |
| `limit` | Default 20, max 200 |
| `offset` | Pagination cursor |

Response: `{ data: [{ id, score, ...fields }], meta: { total, limit, offset } }`.

## Auto-indexing

Hooks tự động:

- **Item create** → enqueue index job qua `QueueProvider`.
- **Item update** → re-index.
- **Item delete** → remove khỏi index.

Worker đọc từ queue, gọi `searchProvider.index(collection, [doc])` hoặc `delete(collection, ids)`.

Initial bulk index cho collection mới: `apps/cms/scripts/cli.ts reindex <collection>`.

## SearchProvider interface

```typescript
interface SearchProvider {
  index(collection: string, documents: Doc[]): Promise<void>;
  search(collection: string, query: string, options?: SearchOptions): Promise<SearchResult>;
  delete(collection: string, ids: string[]): Promise<void>;
  getIndex(collection: string): Promise<IndexInfo>;
}

interface SearchOptions {
  filter?: string;
  sort?: string[];
  limit?: number;
  offset?: number;
  attributesToHighlight?: string[];
}
```

Filter, sort, pagination được forward trực tiếp xuống MeiliSearch — xem [MeiliSearch query rules](https://www.meilisearch.com/docs/reference/api/search) để biết syntax.

## Multi-tenancy

Index name format: `{siteId}__{collection}`. Mỗi site có index riêng, không cross-leak.

## Permissions

Trước khi trả results, áp dụng permission filter (như Item layer): nếu role không có quyền `read` field nào đó, field đó bị strip khỏi document trong response.

## Configuration

```bash
# Docker
MEILI_HOST=http://meilisearch:7700
MEILI_API_KEY=<master key>

# Cloudflare (MeiliSearch Cloud)
MEILI_HOST=https://<your-instance>.meilisearch.io
MEILI_API_KEY=<cloud api key>
```

## Alternatives

Xem `apps/docs/content/guides/tooling-recommendations.md` để biết các alternative search backend (Typesense, Elasticsearch) — có thể swap bằng cách viết adapter mới cho `SearchProvider`.
