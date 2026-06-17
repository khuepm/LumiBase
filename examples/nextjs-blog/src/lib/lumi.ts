import { createLumiClient, graphql } from '@lumibase/sdk';

const url = process.env.LUMIBASE_URL || 'http://127.0.0.1:1989';
const token = process.env.LUMIBASE_TOKEN || '';
const siteId = process.env.LUMIBASE_SITE_ID || '';

if (!token || !siteId) {
  console.warn(
    '[LumiBase] Missing LUMIBASE_TOKEN or LUMIBASE_SITE_ID environment variables. Fetching will fail.'
  );
}

// 1. Initialize the client and attach the GraphQL composable plugin.
//    `.with(graphql())` adds `query()` / `mutate()` that hit POST /api/v1/graphql.
export const lumi = createLumiClient({
  url,
  token,
  siteId,
}).with(graphql());

// 2. Shape of a `posts` item as exposed by the per-tenant GraphQL schema.
//    Content fields (`title`, `content`, `author`) keep their declared names;
//    structural columns are surfaced as camelCase (`createdAt`, not `created_at`).
export interface Post {
  id: string;
  title: string;
  content: string;
  author: string;
  status: 'draft' | 'published';
  createdAt: string;
}
