---
version: 2
lastUpdated: 2026-07-18T20:49:50.811Z
sourceLang: en
translatedFrom: en
sourceHash: 69fb55e16335b41b
mtEngine: claude
syncStatus: machine-translated
---

# GraphQL API Specification

> **Status:** v1 — chỉ content item (query + mutation). Xem
> [ADR-009](../architecture/decisions/adr-009-graphql-yoga.md) để biết lý do.
> Đối với toàn bộ bề mặt REST xem [`hono-api-spec.md`](./hono-api-spec.md).

## Endpoint

```
POST /api/v1/graphql      # operations (queries + mutations)
GET  /api/v1/graphql      # GraphiQL / introspection (non-production only)
```

Endpoint nằm bên trong bề mặt đã xác thực `/api/v1`, nên nó yêu cầu cùng các
header như REST:

| Header | Required | Notes |
|---|---|---|
| `Authorization: Bearer <token>` | yes | Cùng loại token như REST (dev token, CF Access JWT, API key, custom JWT). |
| `X-Lumi-Site: <siteId>` | yes (unless resolved by subdomain) | Phạm vi tenant. |
| `Content-Type: application/json` | yes for POST | Body GraphQL-over-HTTP chuẩn. |

Request body: `{ "query": "...", "variables": { ... }, "operationName": "..." }`.

## Dynamic schema

Schema được **build theo từng tenant tại runtime** từ `collections` / `fields`
của site đó. Với mỗi collection `X` bạn nhận được:

| Operation | Field | Returns |
|---|---|---|
| List | `X(filter, sort, limit, offset, status, search)` | `[X!]!` |
| Detail | `X_by_id(id)` | `X` |
| Create | `create_X(data, status, sort)` | `X!` |
| Update | `update_X(id, data, status, sort)` | `X!` |
| Delete | `delete_X(id)` | `Boolean!` (soft delete) |

Cùng với một meta field `_collections: [String!]!` liệt kê các collection được
phơi ra.

### Object fields

Mỗi item type phơi ra các cột cấu trúc `id`, `status`, `sort`, `createdAt`,
`updatedAt`, `userCreated`, `userUpdated`, và một escape-hatch `_data: JSON`
(toàn bộ khối data đã được mask theo permission). Mỗi content field đã khai báo
được surface với một scalar đã ánh xạ:

| LumiBase field type | GraphQL type |
|---|---|
| `boolean` | `Boolean` |
| `integer` | `Int` |
| `float`, `decimal` | `Float` |
| `bigInteger` | `String` (avoids 53-bit precision loss) |
| `dateTime`, `date`, `time`, `timestamp` | `DateTime` (ISO-8601 string) |
| `string`, `text`, `uuid`, `hash`, `slug`, `code`, `color` | `String` |
| `json`, `csv`, `geometry`, `files` | `JSON` |

Một content field có tên trùng với một cột cấu trúc (ví dụ `status`) sẽ không bị
nhân đôi — cột thắng.

### Nested relations

Các relation `m2o` và `o2m` được surface dưới dạng **nested object field** (đặt
tên theo relation alias kiểu Directus) và được resolve lazily qua `ItemService`,
nên việc thực thi permission/tenancy cũng áp dụng cho các item liên quan:

- **m2o** → một nested object đơn (ví dụ `posts.author`), resolve theo foreign
  key qua `ItemService.detail`; trả về `null` nếu không có.
- **o2m** → một list (ví dụ `authors.posts(limit, offset)`), resolve theo một
  filter back-reference qua `ItemService.list`.

```graphql
query {
  posts_by_id(id: "p1") {
    title
    author { name }            # m2o
  }
  authors_by_id(id: "a1") {
    name
    posts(limit: 10) { title } # o2m
  }
}
```

Các relation `m2m` / `m2a` chưa được nested — dùng escape hatch `_data` JSON để
đọc giá trị thô của chúng. Độ sâu query bị giới hạn (xem [Chống lạm dụng](#chống-lạm-dụng))
để chặn việc duyệt nested relation quá sâu.

## Arguments

- **`filter`** (`JSON`) — cùng filter dạng cây như REST, ví dụ
  `{ "_and": [ { "status": { "_eq": "published" } } ] }`. Operators:
  `_eq, _neq, _in, _nin, _gt, _gte, _lt, _lte, _contains, _starts_with,
  _ends_with, _null, _nnull, _and, _or`.
- **`sort`** (`[String!]`) — các token field, prefix `-` để giảm dần.
- **`limit`** / **`offset`** — phân trang (limit tối đa 200).
- **`status`** — filter theo workflow status.
- **`search`** — full-text search qua SearchProvider đã cấu hình.

## Chống lạm dụng

Mọi operation đều được validate *trước khi* chạy, đối chiếu với hai giới hạn
tĩnh, nên một query đắt bất thường bị từ chối ngay ở tầng parse mà không chạm
tới resolver nào (CWE-770). Cả hai chạy ở mọi môi trường; ngoài ra introspection
bị tắt ngoài môi trường development.

- **Giới hạn độ sâu** — chặn độ sâu lồng nhau của field. Query sâu quá giới hạn
  bị từ chối với `Query exceeds the maximum depth of N.`
- **Giới hạn chi phí** — chặn điểm *chi phí* tĩnh, bắt các query nông-nhưng-rộng
  (nhiều field song song, `limit` lớn, hoặc cùng một field bị alias lặp lại) mà
  riêng giới hạn độ sâu bỏ lọt. Mỗi field tốn 1; subtree của một list field được
  nhân với argument phân trang (`limit`/`first`/`last`/`pageSize`), hoặc một giá
  trị mặc định khi argument đó vắng mặt hoặc là variable. List lồng nhau nhân
  qua tích. Query vượt ngân sách bị từ chối với `Query exceeds the maximum cost of N.`

| Guard | Mặc định | Env override |
| --- | --- | --- |
| Độ sâu tối đa | 12 | — (hằng số compile-time) |
| Chi phí tối đa | 1000 | `LUMIBASE_GQL_MAX_COST` |
| Cỡ list mặc định (hệ số nhân chi phí khi không có argument phân trang literal) | 20 | `LUMIBASE_GQL_DEFAULT_LIST_SIZE` |
| Hệ số nhân list tối đa (trần clamp mỗi list field) | 100 | `LUMIBASE_GQL_MAX_LIST_MULTIPLIER` |

> Một `limit` literal cực lớn bị clamp về *hệ số nhân list tối đa* khi tính điểm,
> nên một `articles(limit: 999999)` vượt ngân sách chi phí một cách xác định thay
> vì gây tràn. Vì chi phí là tĩnh, một `limit` truyền qua variable (`$n`) được
> tính theo *cỡ list mặc định*, không phải giá trị runtime của nó — một ước lượng
> bảo thủ có chủ đích. Tăng `LUMIBASE_GQL_MAX_COST` nếu một query hợp lệ bị từ chối.

## Examples

```graphql
# List published articles
query ($limit: Int) {
  articles(status: "published", limit: $limit, sort: ["-updatedAt"]) {
    id
    title
    updatedAt
  }
}
```

```graphql
# Create an article
mutation {
  create_articles(data: { title: "Hello", body: "..." }, status: "draft") {
    id
    title
    status
  }
}
```

## Subscriptions

Mỗi collection phơi ra `Subscription.<collection>_events`, stream các event
create/update/delete qua Server-Sent Events (transport subscription mặc định của
GraphQL Yoga — kết nối bằng `GET` và `Accept: text/event-stream`).

```graphql
subscription {
  articles_events {
    action     # "create" | "update" | "delete"
    itemId
    item       # JSON payload of the changed item
  }
}
```

Các event được bắc cầu từ realtime channel của **SiteRoom Durable Object** theo
từng site (chính là cơ chế fan-out mà WebSocket realtime API dùng), nên việc gửi
là cross-isolate-correct trên Cloudflare. Ở nơi không có Durable Object nào được
bind (ví dụ Docker dev), subscription là một stream no-op. Việc mask ở mức field
cho payload được stream là một cải tiến đã lên kế hoạch — hiện tại payload `item`
phản chiếu body của realtime event.

## Errors

GraphQL phản hồi với HTTP 200 và một mảng `errors[]`. Mỗi lỗi mang theo một
`extensions.code` khớp với bộ từ vựng của REST:

```json
{
  "data": null,
  "errors": [
    { "message": "no read", "extensions": { "code": "PERMISSION_DENIED", "status": 403 } }
  ]
}
```

Các code phổ biến: `VALIDATION`, `PERMISSION_DENIED`, `NOT_FOUND`,
`UNAUTHENTICATED`, `INVALID_FILTER`, `INTERNAL`.

## Governance guarantees

Các resolver ủy quyền cho `ItemService`, nên GraphQL kế thừa cùng các đảm bảo
như REST: scoping `site_id` theo từng tenant + RLS, mask row/field theo
permission, lọc soft-delete (`deletedAt`), ghi revision/provenance, HITL pin,
broadcast realtime, và index search.

## SDK usage

```ts
import { createLumiClient, graphql } from "@lumibase/sdk";

const client = createLumiClient({ url, token, siteId }).with(graphql());

const { articles } = await client.query<{ articles: Array<{ id: string }> }>(
  `query ($limit: Int) { articles(limit: $limit) { id title } }`,
  { limit: 10 },
);
```

## Out of scope (v1)

Nested relation m2m/m2a, persisted query, mask ở mức field cho payload
subscription, và một bề mặt GraphQL cho admin/schema/users. Xem ADR-009
"Future work".
