/**
 * Server-side LumiBase reads. `#lib/server/*` and `$app/env/private` cannot be
 * imported from code that runs in the browser — SvelteKit fails the build if
 * you try — so the keys read here never reach a client bundle.
 *
 * The variables are declared in `src/env.ts` as non-static, so on Cloudflare
 * Pages they come from the project's Variables and Secrets when the app
 * starts, not from the build.
 */

import * as env from '$app/env/private';
import { createLumiClient, readItems, type ItemRow } from 'lumibase';
import type { LumibaseCollections } from '#lib/lumibase-types.ts';
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

export function contentConfig(preview: boolean): ConfigResult {
  return resolveContentConfig(env, preview);
}

function client(config: ContentConfig) {
  return createLumiClient<Schema>({ url: config.url, siteId: config.siteId, token: config.token });
}

/**
 * `status: 'published'` is asked for explicitly on normal reads, on top of the
 * publishable key's grant. A preview read asks for every status.
 */
const statusFilter = (config: ContentConfig) => (config.preview ? {} : { status: 'published' });

export async function listPosts(config: ContentConfig): Promise<Post[]> {
  const res = await client(config).request(
    readItems('posts', { limit: 50, sort: ['-created_at'], ...statusFilter(config) }),
  );
  return res.data;
}

export async function getPostBySlug(config: ContentConfig, slug: string): Promise<Post | null> {
  if (!safeSlug(slug)) return null;
  const res = await client(config).request(
    readItems('posts', { limit: 1, filter: { slug: { _eq: slug } }, ...statusFilter(config) }),
  );
  return res.data[0] ?? null;
}

/**
 * Cache policy for a rendered page. Preview responses carry drafts, so they
 * must never land in a shared cache; public ones may, briefly.
 */
export function cacheControl(config: ContentConfig | null): string {
  return config?.preview ? 'private, no-store' : 'public, max-age=0, s-maxage=60';
}
