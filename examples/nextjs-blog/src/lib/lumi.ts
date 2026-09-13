import { createLumiClient, legacyRest, type ItemRow } from 'lumibase';

const url = process.env.LUMIBASE_URL || 'http://127.0.0.1:1989';
const token = process.env.LUMIBASE_TOKEN || '';
const siteId = process.env.LUMIBASE_SITE_ID || '';

if (!token || !siteId) {
  console.warn(
    '[LumiBase] Missing LUMIBASE_TOKEN or LUMIBASE_SITE_ID environment variables. Fetching will fail.'
  );
}

// Content fields of the `posts` collection, exactly as declared in Studio.
// A schema maps a collection name to its *data* shape only — structural
// columns (id, status, createdAt, …) are added by `ItemRow` below.
export interface PostFields {
  title: string;
  body: string;
  author: string;
  [key: string]: unknown;
}

// `DefaultSchema` is an index-signature type, so the schema is written as a
// type alias with one entry per collection you read.
export type Schema = {
  posts: PostFields;
};

/** A `posts` row as the REST API returns it: fields live under `.data`. */
export type Post = ItemRow<PostFields>;

// The client is created once and reused. `legacyRest()` adds the typed
// resource helpers (`.items('posts').list()` / `.detail(id)`) over
// `GET /api/v1/items/posts`.
//
// This module is imported only from Server Components, so the token never
// reaches the browser bundle. Keep it out of `NEXT_PUBLIC_*`.
export const lumi = createLumiClient<Schema>({
  url,
  token,
  siteId,
}).with(legacyRest());
