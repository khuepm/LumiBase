// Server-side data access for `.astro` frontmatter, endpoints and middleware.
// `virtual:lumibase` is server-only: importing it from a client <script> fails the build.
import { lumi } from 'virtual:lumibase';
import { readItems, type LumiClient, type SchemaOf } from '@lumibase/sdk';

import type { LumibaseSchema } from '../lumibase-types';

const typed = lumi as LumiClient<SchemaOf<LumibaseSchema>>;

export async function latestPostTitles(limit = 10): Promise<string[]> {
  const page = await typed.request(readItems('posts', { limit, sort: ['-created_at'] }));
  return page.data.map((post) => post.data.title ?? '(untitled)');
}
