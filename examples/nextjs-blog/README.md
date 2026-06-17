# Next.js Blog Example with LumiBase GraphQL

This is a minimal, performance-optimized blog application built with Next.js (App Router, Server Components) that fetches data from LumiBase's **GraphQL API** using the `@lumibase/sdk` `graphql()` plugin.

## Features
- **GraphQL Fetching**: Queries the per-tenant GraphQL endpoint (`POST /api/v1/graphql`) directly inside React Server Components via `lumi.query(...)`.
- **Type-Safety**: Each query is typed through a generic on `lumi.query<T>(...)` for compiler checks and auto-completion.
- **Dynamic SSG / ISR**: Demonstrates `generateStaticParams` for pre-rendering pages and `revalidate = 60` for Incremental Static Regeneration.

## GraphQL usage

The client attaches the GraphQL plugin in [`src/lib/lumi.ts`](src/lib/lumi.ts):

```ts
import { createLumiClient, graphql } from '@lumibase/sdk';

export const lumi = createLumiClient({ url, token, siteId }).with(graphql());
```

The schema is built **per tenant at runtime** from your collections. For a `posts`
collection you get `posts(filter, sort, limit, offset, status, search)` and
`posts_by_id(id)`. Structural columns are camelCase (`createdAt`); content fields
keep their declared names. Example list query:

```graphql
query ListPosts($limit: Int) {
  posts(status: "published", sort: ["-createdAt"], limit: $limit) {
    id
    title
    content
    author
    createdAt
  }
}
```

See [`docs/en/api/graphql-api-spec.md`](../../docs/en/api/graphql-api-spec.md) for the
full GraphQL surface (filters, mutations, nested relations, subscriptions).

## Getting Started

1. **Configure Environment Variables**:
   Copy `.env.example` to `.env.local` and fill in the values:
   ```bash
   cp .env.example .env.local
   ```
   Set `LUMIBASE_TOKEN` and `LUMIBASE_SITE_ID` to match your local setup or cloud deploy.

2. **Install & Run**:
   ```bash
   pnpm install
   pnpm dev
   ```

3. **Open the Application**:
   Navigate to `http://localhost:3000`.
