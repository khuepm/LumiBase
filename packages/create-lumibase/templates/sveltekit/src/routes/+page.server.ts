import { error } from '@sveltejs/kit';
import { cacheControl, contentConfig, listPosts } from '#lib/server/lumibase.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
  const result = contentConfig(locals.preview);
  if (!result.configured) {
    setHeaders({ 'cache-control': 'no-store' });
    return { configured: false as const, missing: result.missing, posts: [] };
  }

  setHeaders({ 'cache-control': cacheControl(result.config) });
  try {
    const posts = await listPosts(result.config);
    return { configured: true as const, missing: [], posts };
  } catch (err) {
    // Details go to the server log, not to the visitor.
    console.error('[lumibase] could not load posts:', err);
    error(502, 'Could not reach the CMS');
  }
};
