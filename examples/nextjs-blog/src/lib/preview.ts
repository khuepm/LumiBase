import { cookies, draftMode } from 'next/headers';
import type { Post } from '@/lib/lumi';

/**
 * Draft preview from the LumiBase Studio (epic #667).
 *
 * The Studio mints a short-lived, site-scoped preview token and opens
 * `/api/preview?token=…&id=…` in its preview pane. That route checks the
 * token against the CMS **server-side**, turns on Next.js draft mode and keeps
 * the token in an httpOnly cookie — it never reaches client components, the
 * HTML or the bundle.
 */

export const PREVIEW_COOKIE = 'lb_preview';

const url = process.env.LUMIBASE_URL || 'http://127.0.0.1:1989';
const siteId = process.env.LUMIBASE_SITE_ID || '';

/** `GET /api/v1/deliver/preview/:site_id{path}` with the token in the header. */
export async function previewFetch(token: string, path = ''): Promise<Response> {
  return fetch(`${url}/api/v1/deliver/preview/${encodeURIComponent(siteId)}${path}`, {
    headers: { 'x-lumibase-preview': token },
    cache: 'no-store',
  });
}

/** The preview token when draft mode is on, else null. */
export async function activePreviewToken(): Promise<string | null> {
  const draft = await draftMode();
  if (!draft.isEnabled) return null;
  return (await cookies()).get(PREVIEW_COOKIE)?.value ?? null;
}

/** A post as the preview token sees it (draft, version or release overlay). */
export async function previewPost(token: string, id: string): Promise<Post | null> {
  const res = await previewFetch(token, `/items/posts/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return ((await res.json()) as { data: Post }).data;
}
