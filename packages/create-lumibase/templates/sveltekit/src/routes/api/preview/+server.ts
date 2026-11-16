import { error, redirect } from '@sveltejs/kit';
import { dev } from '$app/env';
import * as env from '$app/env/private';
import { previewAvailable } from '#lib/server/config.ts';
import {
  issuePreviewCookie,
  PREVIEW_COOKIE,
  PREVIEW_TTL_SECONDS,
  safeRedirectPath,
  secretMatches,
} from '#lib/server/preview.ts';
import type { RequestHandler } from './$types';

/**
 * Enter draft preview:
 *
 *   GET /api/preview?secret=<LUMIBASE_PREVIEW_SECRET>&redirect=/posts/my-slug
 *
 * Point a Studio preview URL (or a bookmark) here. On a correct secret the
 * browser gets a signed, HttpOnly cookie for one hour and is sent on to
 * `redirect` (same-origin paths only).
 *
 * Fails closed: with preview not fully configured the route does not exist
 * (404), and a wrong secret is a 401 with no cookie.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
  if (!previewAvailable(env)) error(404, 'Not found');

  const ok = await secretMatches(url.searchParams.get('secret'), env.LUMIBASE_PREVIEW_SECRET);
  if (!ok) error(401, 'Invalid preview secret');

  cookies.set(PREVIEW_COOKIE, await issuePreviewCookie(env.LUMIBASE_PREVIEW_SECRET as string), {
    path: '/',
    httpOnly: true,
    secure: !dev,
    // `none` in production so the preview also works inside a Studio iframe,
    // which is cross-site. The cookie only ever unlocks reads, and a
    // cross-site page cannot read the response, so this is not a CSRF hole.
    sameSite: dev ? 'lax' : 'none',
    maxAge: PREVIEW_TTL_SECONDS,
  });

  redirect(303, safeRedirectPath(url.searchParams.get('redirect')));
};
