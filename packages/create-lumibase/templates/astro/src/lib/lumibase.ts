/**
 * Build-time LumiBase access for this static site.
 *
 * Everything here runs during `astro build` (and `astro dev`), never in a
 * visitor's browser: the variables come from `astro:env/server`, which Astro
 * refuses to import into client code. The HTML in `dist/` holds the content,
 * not the credentials. The credential rules live in `./config.ts`.
 */

import {
  LUMIBASE_PREVIEW,
  LUMIBASE_PREVIEW_TOKEN,
  LUMIBASE_PUBLISHABLE_KEY,
  LUMIBASE_SITE_ID,
  LUMIBASE_URL,
} from 'astro:env/server';
import { createLumiClient, readItems, type ItemRow } from 'lumibase';
import type { LumibaseCollections } from '../lumibase-types';
import { resolveContentConfig, safeSlug, type ConfigResult, type ContentConfig } from './config';

/**
 * Columns every item has. The REST API returns them on the row itself; only
 * the remaining fields live under `row.data`.
 */
type SystemField =
  | 'id'
  | 'status'
  | 'sort'
  | 'user_created'
  | 'user_updated'
  | 'created_at'
  | 'updated_at'
  | 'deleted_at';

/** Content fields of a collection, derived from the generated types. */
export type Fields<C extends keyof LumibaseCollections> = Omit<LumibaseCollections[C], SystemField>;

/** Schema for the typed client: collection name → its `data` shape. */
export type Schema = { [C in keyof LumibaseCollections]: Fields<C> };

/** A `posts` row as the API returns it. Regenerate types with `npm run types`. */
export type Post = ItemRow<Fields<'posts'>>;

export const contentConfig: ConfigResult = resolveContentConfig({
  url: LUMIBASE_URL,
  siteId: LUMIBASE_SITE_ID,
  publishableKey: LUMIBASE_PUBLISHABLE_KEY,
  preview: LUMIBASE_PREVIEW,
  previewToken: LUMIBASE_PREVIEW_TOKEN,
});

const PAGE_SIZE = 100;
/** Hard stop so a misbehaving API cannot keep a build looping forever. */
const MAX_PAGES = 100;

async function fetchAllPosts(config: ContentConfig): Promise<Post[]> {
  const client = createLumiClient<Schema>({
    url: config.url,
    siteId: config.siteId,
    token: config.token,
  });

  const posts: Post[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await client.request(
      readItems('posts', {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        sort: ['-created_at'],
        // A normal build asks for published rows explicitly, on top of the
        // key's grant. A preview build asks for every status.
        ...(config.preview ? {} : { status: 'published' }),
      }),
    );
    posts.push(...res.data);
    if (res.data.length < PAGE_SIZE) break;
  }
  return posts;
}

let postsPromise: Promise<Post[]> | undefined;

/**
 * Every post this build renders. Memoised, so the index page and
 * `getStaticPaths` share one fetch per build.
 *
 * A configured CMS that cannot be reached FAILS the build on purpose:
 * deploying an empty site over a working one is worse than keeping the last
 * good deploy.
 */
export function getPosts(): Promise<Post[]> {
  if (!contentConfig.configured) return Promise.resolve([]);
  postsPromise ??= fetchAllPosts(contentConfig.config);
  return postsPromise;
}

export function postSlug(post: Post): string | null {
  return safeSlug(post.data.slug);
}
