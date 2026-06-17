# GraphQL API Specification

> **Status:** v1 — content items only (query + mutation). See
> [ADR-009](../architecture/decisions/adr-009-graphql-yoga.md) for rationale.
> For the full REST surface see [`hono-api-spec.md`](./hono-api-spec.md).

## Endpoint

```
POST /api/v1/graphql      # operations (queries + mutations)
GET  /api/v1/graphql      # GraphiQL / introspection (non-production only)
```

The endpoint lives inside the authenticated `/api/v1` surface, so it requires
the same headers as REST:

| Header | Required | Notes |
|---|---|---|
| `Authorization: Bearer <token>` | yes | Same tokens as REST (dev token, CF Access JWT, API key, custom JWT). |
| `X-Lumi-Site: <siteId>` | yes (unless resolved by subdomain) | Tenant scope. |
| `Content-Type: application/json` | yes for POST | Standard GraphQL-over-HTTP body. |

Request body: `{ "query": "...", "variables": { ... }, "operationName": "..." }`.

## Dynamic schema

The schema is **built per tenant at runtime** from that site's
`collections` / `fields`. For every collection `X` you get:

| Operation | Field | Returns |
|---|---|---|
| List | `X(filter, sort, limit, offset, status, search)` | `[X!]!` |
| Detail | `X_by_id(id)` | `X` |
| Create | `create_X(data, status, sort)` | `X!` |
| Update | `update_X(id, data, status, sort)` | `X!` |
| Delete | `delete_X(id)` | `Boolean!` (soft delete) |

Plus a meta field `_collections: [String!]!` listing the exposed collections.

### Object fields

Every item type exposes the structural columns `id`, `status`, `sort`,
`createdAt`, `updatedAt`, `userCreated`, `userUpdated`, and an escape-hatch
`_data: JSON` (the full, permission-masked data blob). Each declared content
field is surfaced with a mapped scalar:

| LumiBase field type | GraphQL type |
|---|---|
| `boolean` | `Boolean` |
| `integer` | `Int` |
| `float`, `decimal` | `Float` |
| `bigInteger` | `String` (avoids 53-bit precision loss) |
| `dateTime`, `date`, `time`, `timestamp` | `DateTime` (ISO-8601 string) |
| `string`, `text`, `uuid`, `hash`, `slug`, `code`, `color` | `String` |
| `json`, `csv`, `geometry`, `files`, relational (`m2o/o2m/m2m/m2a`) | `JSON` |

A content field whose name collides with a structural column (e.g. `status`)
is not duplicated — the column wins.

## Arguments

- **`filter`** (`JSON`) — the same tree-shaped filter as REST, e.g.
  `{ "_and": [ { "status": { "_eq": "published" } } ] }`. Operators:
  `_eq, _neq, _in, _nin, _gt, _gte, _lt, _lte, _contains, _starts_with,
  _ends_with, _null, _nnull, _and, _or`.
- **`sort`** (`[String!]`) — field tokens, `-` prefix for descending.
- **`limit`** / **`offset`** — pagination (max limit 200).
- **`status`** — filter by workflow status.
- **`search`** — full-text search via the configured SearchProvider.

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

## Errors

GraphQL responds with HTTP 200 and an `errors[]` array. Each error carries an
`extensions.code` matching the REST vocabulary:

```json
{
  "data": null,
  "errors": [
    { "message": "no read", "extensions": { "code": "PERMISSION_DENIED", "status": 403 } }
  ]
}
```

Common codes: `VALIDATION`, `PERMISSION_DENIED`, `NOT_FOUND`,
`UNAUTHENTICATED`, `INVALID_FILTER`, `INTERNAL`.

## Governance guarantees

Resolvers delegate to `ItemService`, so GraphQL inherits the same guarantees
as REST: per-tenant `site_id` scoping + RLS, permission row/field masking,
soft-delete filtering (`deletedAt`), revision/provenance writes, HITL pins,
realtime broadcast, and search indexing.

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

Subscriptions, nested relation types, persisted queries, and a GraphQL surface
for admin/schema/users. See ADR-009 "Future work".
