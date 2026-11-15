import { createLumiClient, RealtimeClient, type SchemaOf } from '@lumibase/sdk';
import { createLumiBase, defineLumiComposables } from '@lumibase/vue';

import type { LumibaseSchema } from './lumibase-types';

/** Generated interfaces → a schema the client accepts. */
export type Schema = SchemaOf<LumibaseSchema>;

const url = 'http://127.0.0.1:1989';
const siteId = 'site_demo';
// A read-only delivery token: this file ships to the browser.
const token = 'public-delivery-token';

export const client = createLumiClient<Schema>({ url, siteId, token });

// Never connected here — the first composable that needs it connects it,
// and the last one to unmount disconnects it.
export const realtime = new RealtimeClient({ baseUrl: url, siteId, token });

export const lumiPlugin = createLumiBase({ client, realtime });

// Composables bound to the schema: `useItems('posts')` is checked and typed.
export const { useItems, useItem } = defineLumiComposables<Schema>();
