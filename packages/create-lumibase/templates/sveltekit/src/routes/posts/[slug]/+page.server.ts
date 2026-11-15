import { error } from '@sveltejs/kit';
import { cacheControl, contentConfig, getPostBySlug, type Post } from '#lib/server/lumibase.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, setHeaders }) => {
  const result = contentConfig(locals.preview);
  if (!result.configured) error(404, 'Not found');

  let post: Post | null;
  try {
    post = await getPostBySlug(result.config, params.slug);
  } catch (err) {
    console.error('[lumibase] could not load post:', err);
    error(502, 'Could not reach the CMS');
  }
  if (!post) error(404, 'Not found');

  setHeaders({ 'cache-control': cacheControl(result.config) });
  return { post };
};
