import type { Handle } from '@sveltejs/kit/hooks';
import * as env from '$app/env/private';
import { PREVIEW_COOKIE, verifyPreviewCookie } from '#lib/server/preview.ts';

/**
 * Decide once per request whether this visitor is in draft preview. Only a
 * cookie signed with the current LUMIBASE_PREVIEW_SECRET counts; anything else
 * — a forged, expired or stale cookie — is an ordinary visitor.
 */
export const handle: Handle = async ({ event, resolve }) => {
  event.locals.preview = await verifyPreviewCookie(
    env.LUMIBASE_PREVIEW_SECRET,
    event.cookies.get(PREVIEW_COOKIE),
  );
  return resolve(event);
};
