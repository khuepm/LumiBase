import { defineEnvVars } from '@sveltejs/kit/env';

/**
 * The environment this site reads, declared once. None is `public`, so every
 * one of them is importable only from `$app/env/private` — a server-only
 * module SvelteKit refuses to bundle for the browser. None is `static`
 * either: values are read when the app starts (on Cloudflare Pages, from the
 * project's Variables and Secrets), never inlined into the build output.
 *
 * Every variable is optional: an empty value reads as "not set", and
 * `#lib/server/config.ts` decides what that means (a "connect your CMS" page,
 * or preview switched off).
 */
const optional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const variables = defineEnvVars({
  LUMIBASE_URL: { schema: optional, description: 'Base URL of the LumiBase CMS.' },
  LUMIBASE_SITE_ID: { schema: optional, description: 'Site (tenant) id. Defaults to __default__.' },
  LUMIBASE_PUBLISHABLE_KEY: {
    schema: optional,
    description: 'Publishable key (lbk_pub_…), restricted to published rows.',
  },
  LUMIBASE_PREVIEW_SECRET: {
    schema: optional,
    description: 'Secret (32+ chars) that unlocks /api/preview. Unset = preview off.',
  },
  LUMIBASE_PREVIEW_TOKEN: {
    schema: optional,
    description: 'Secret token (lbk_…) whose grant includes drafts. Used only in preview.',
  },
});
