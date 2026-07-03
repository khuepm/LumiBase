# Full-text Search

LumiBase tích hợp **MeiliSearch** làm full-text search backend, qua interface
`SearchProvider` trong `@lumibase/runtime`.

## Backend theo runtime

| Runtime | Backend |
|---------|---------|
| Cloudflare | MeiliSearch Cloud qua HTTP |
| Docker | MeiliSearch self-host (port 7700, persistent volume) |

Cả hai cùng implement interface `SearchProvider` — code application không cần
biết cái nào đang chạy.

## API endpoint

`GET /api/v1/search?q=...&collection=...&filter=...&sort=...&limit=...&offset=...`

| Param | Mô tả |
|-------|-------|
| `q` (bắt buộc) | Query string |
| `collection` | Giới hạn theo một collection. **Bỏ trống để tìm cross-collection (toàn cục).** |
| `filter` | Biểu thức filter của MeiliSearch |
| `sort` | Sort directive, phân tách bằng dấu phẩy (vd `_updatedAt:desc`) |
| `limit` | Mặc định 20, tối đa 200 |
| `offset` | Con trỏ phân trang |

### Response một collection

```jsonc
{
  "data": [ { "id": "...", "_collection": "articles", "_title": "...", "_updatedAt": "...", /* ...fields */ } ],
  "meta": { "totalHits": 12, "processingTimeMs": 3, "collection": "articles", "query": "ha noi", "limit": 20, "offset": 0 }
}
```

`collection` yêu cầu được validate thuộc về site của caller; collection không tồn
tại trả về `404`.

### Response cross-collection (toàn cục)

Khi bỏ trống `collection`, query fan-out qua mọi collection của site (mỗi
collection một lần search scope theo site) rồi gộp kết quả, mỗi hit gắn
`_collection` tương ứng. Fan-out giới hạn 20 collection mỗi request.

```jsonc
{
  "data": [ { "_collection": "articles", "id": "...", "_title": "..." }, { "_collection": "pages", "id": "...", "_title": "..." } ],
  "meta": { "totalHits": 7, "query": "ha noi", "collections": ["articles", "pages"], "truncated": false, "limit": 20, "offset": 0 }
}
```

Đây là nền cho command palette toàn cục của Studio (⌘K).

### SDK

```typescript
import { search } from "@lumibase/sdk";

// Cross-collection (toàn cục)
const { data, meta } = await client.request(search("ha noi"));
// Một collection
await client.request(search("ha noi", { collection: "articles", limit: 10 }));
```

## Hỗ trợ tiếng Việt

MeiliSearch chuẩn hóa dấu sẵn, nên query gõ **không dấu vẫn khớp nội dung có
dấu** — `ha noi` → "Hà Nội", `da nang` → "Đà Nẵng". Không cần cấu hình thêm cho
việc này.

Bên cạnh đó, index được cấu hình (`defaultIndexSettings`) với:

- **Stop words tiếng Việt** (`và`, `của`, `là`, `các`, …) để cải thiện độ liên quan.
- **Nâng ngưỡng typo-tolerance** (`oneTypo: 4`, `twoTypos: 8`) — tiếng Việt nhiều
  từ ngắn, fuzzy match quá mạnh sẽ gây nhiễu.
- **`_title`** chuẩn hóa được ưu tiên cao hơn các field searchable của collection.

## Auto-indexing

Hook chạy tự động:

- **Item create** → enqueue index job qua `QueueProvider`.
- **Item update** → re-index.
- **Item delete** → xóa khỏi index.

Worker `content-indexing` (`registerContentIndexingWorker`, wire trong
`serve.ts`) đọc queue và gọi `searchProvider.index(...)` / `delete(...)`. Khi
không có queue, `ItemService` index trực tiếp (inline).

### Reindex CLI

Build lại index từ database (khởi tạo instance mới, hoặc rebuild sau thay đổi):

```bash
lumibase reindex                      # mọi collection của mọi site
lumibase reindex --site <siteId>      # một site
lumibase reindex --site <siteId> --collection posts
```

Yêu cầu cùng env như server (`DATABASE_URL`, `MEILISEARCH_HOST`,
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

Filter, sort, phân trang được forward thẳng xuống MeiliSearch — xem
[MeiliSearch search reference](https://www.meilisearch.com/docs/reference/api/search)
để biết syntax.

## Multi-tenancy

Index name luôn là `{siteId}__{collection}` (xem `searchIndexName`). Mọi lệnh
index/search/delete đều đi qua helper này, và route `/search` còn validate
collection yêu cầu thuộc site của caller — nên một tenant không thể đặt tên hay
chạm tới index của tenant khác.

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

Xem `apps/docs/content/guides/tooling-recommendations.md` để biết các search
backend thay thế (Typesense, Elasticsearch) — swap bằng cách viết adapter mới cho
`SearchProvider`.
