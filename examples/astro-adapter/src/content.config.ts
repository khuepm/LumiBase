import { defineCollection } from 'astro:content';
import { createLumiClient, type SchemaOf } from '@lumibase/sdk';
import { lumibaseLoader } from '@lumibase/astro/loader';

import type { LumibaseSchema } from './lumibase-types';

type Schema = SchemaOf<LumibaseSchema>;

// Runs at build / `astro sync` time only — the token never reaches a page.
const client = createLumiClient<Schema>({
  url: 'http://127.0.0.1:1989',
  siteId: 'site_demo',
  token: import.meta.env.LUMIBASE_TOKEN ?? '',
});

export const collections = {
  posts: defineCollection({
    // `collection` is checked against the schema.
    loader: lumibaseLoader({ client, collection: 'posts', params: { status: 'published' }, pageSize: 50 }),
  }),
};
