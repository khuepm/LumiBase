/**
 * The LumiBase client this website reads content with.
 *
 * Everything here is least-privilege on purpose:
 *
 *  - the token is a PUBLISHABLE key (`lbk_pub_`), not an admin token. It is
 *    read-only and origin-locked, so it is safe to ship to a browser;
 *  - the public grant behind it carries a `status = published` row filter, so
 *    this client cannot see drafts even if it asks for them.
 *
 * If you ever need admin-level reads or writes, do them in a Server Component,
 * a Route Handler, or a script — with a server-only variable that has no
 * `NEXT_PUBLIC_` prefix — never with this client.
 */

import { createLumiClient, readItems } from 'lumibase';

export interface Post {
  id: string;
  status: string;
  data: {
    title?: string;
    slug?: string;
    body?: string;
  };
}

const url = process.env.NEXT_PUBLIC_LUMIBASE_URL;
const siteId = process.env.NEXT_PUBLIC_LUMIBASE_SITE_ID;
const token = process.env.NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY;

export const isConfigured = Boolean(url && siteId && token);

export const lumibase = createLumiClient({
  url: url ?? 'http://localhost:1989',
  siteId: siteId ?? '__default__',
  // `token` is required by the client type. A publishable key travels over the
  // same `Authorization: Bearer` header as any other credential, so it drops
  // straight in here.
  token: token ?? '',
});

/**
 * Fetch posts for the homepage.
 *
 * `status: 'published'` is belt-and-braces: the server-side grant already
 * restricts this key to published rows. Asking explicitly means the intent is
 * visible in the code too.
 */
export async function getPosts(): Promise<Post[]> {
  const res = await lumibase.request(
    readItems('posts', { limit: 50, sort: ['-created_at'], status: 'published' }),
  );
  return ((res as { data?: Post[] })?.data ?? []) as Post[];
}
