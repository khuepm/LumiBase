import { env } from '$env/dynamic/private';
import { createLumiHandle } from '@lumibase/svelte/kit';

// One client per request, on `event.locals.lumi`, using SvelteKit's `fetch`.
// Config is read per request from the private env — never bundled.
export const handle = createLumiHandle(() => ({
  url: env.LUMIBASE_URL ?? 'http://127.0.0.1:1989',
  siteId: env.LUMIBASE_SITE_ID ?? '',
  token: env.LUMIBASE_TOKEN ?? '',
}));
