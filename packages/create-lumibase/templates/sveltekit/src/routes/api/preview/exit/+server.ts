import { redirect } from '@sveltejs/kit';
import { dev } from '$app/env';
import { PREVIEW_COOKIE, safeRedirectPath } from '#lib/server/preview.ts';
import type { RequestHandler } from './$types';

/** Leave draft preview: drop the cookie and go back to the published site. */
export const GET: RequestHandler = ({ url, cookies }) => {
  cookies.delete(PREVIEW_COOKIE, { path: '/', secure: !dev, sameSite: dev ? 'lax' : 'none' });
  redirect(303, safeRedirectPath(url.searchParams.get('redirect')));
};
