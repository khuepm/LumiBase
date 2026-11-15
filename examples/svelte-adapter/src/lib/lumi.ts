import { createLumiClient, RealtimeClient, type ListItemsResponse } from '@lumibase/sdk';
import { defineLumiStores, presenceStore } from '@lumibase/svelte';
import { fromStore } from 'svelte/store';

import type { Posts } from '../lumibase-types';
import type { Schema } from './schema';

const url = 'http://127.0.0.1:1989';
const siteId = 'site_demo';
// A read-only delivery token: this module ships to the browser.
const token = 'public-delivery-token';

export const client = createLumiClient<Schema>({ url, siteId, token });
// Not connected here: stores connect on first subscriber (browser only)
// and disconnect after the last one unsubscribes.
export const realtime = new RealtimeClient({ baseUrl: url, siteId, token });

export const lumi = defineLumiStores(client, { realtime });

/**
 * Used from `+page.svelte` (see README):
 *   const posts = livePosts(data.posts);   // hydrate from `load`, then stay live
 *   {#each $posts.data?.data ?? [] as post}<li>{post.data.title}</li>{/each}
 */
export function livePosts(initialData: ListItemsResponse<Schema['posts']>) {
  return lumi.items('posts', { limit: 10, sort: ['-created_at'] }, { initialData, live: true });
}

/** Svelte 5 runes: read a store as `.current` with `fromStore`. */
export function postViewers(itemId: Posts['id']) {
  return fromStore(presenceStore(realtime, { collection: 'posts', itemId }));
}
