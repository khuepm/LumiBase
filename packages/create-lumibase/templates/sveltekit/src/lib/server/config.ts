/**
 * Which credential a request reads content with. No SvelteKit imports, so the
 * rules are plain TypeScript that anything can test.
 *
 *  - no URL, or no publishable key → `configured: false`; the site renders a
 *    "connect your CMS" page instead of erroring;
 *  - a normal request reads with the PUBLISHABLE key (`lbk_pub_…`) and asks for
 *    published rows only;
 *  - a preview request reads with LUMIBASE_PREVIEW_TOKEN, a server-only
 *    secret whose grant includes drafts. Preview is available only when both
 *    that token and LUMIBASE_PREVIEW_SECRET are set — otherwise it is off.
 */

import { previewSecretUsable } from './preview';

export interface ContentConfig {
  url: string;
  siteId: string;
  token: string;
  preview: boolean;
}

export type ConfigResult =
  | { configured: true; config: ContentConfig }
  | { configured: false; missing: string[] };

/** The private env names this site reads. All server-only. */
export interface ContentEnv {
  LUMIBASE_URL?: string | undefined;
  LUMIBASE_SITE_ID?: string | undefined;
  LUMIBASE_PUBLISHABLE_KEY?: string | undefined;
  LUMIBASE_PREVIEW_TOKEN?: string | undefined;
  LUMIBASE_PREVIEW_SECRET?: string | undefined;
}

export const PUBLISHABLE_PREFIX = 'lbk_pub_';

const present = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** Can an editor enter preview at all on this deployment? */
export function previewAvailable(env: ContentEnv): boolean {
  return (
    previewSecretUsable(env.LUMIBASE_PREVIEW_SECRET) &&
    present(env.LUMIBASE_PREVIEW_TOKEN) &&
    !env.LUMIBASE_PREVIEW_TOKEN.startsWith(PUBLISHABLE_PREFIX)
  );
}

export function resolveContentConfig(env: ContentEnv, preview: boolean): ConfigResult {
  const missing: string[] = [];
  if (!present(env.LUMIBASE_URL)) missing.push('LUMIBASE_URL');
  if (!present(env.LUMIBASE_PUBLISHABLE_KEY)) missing.push('LUMIBASE_PUBLISHABLE_KEY');
  if (missing.length > 0) return { configured: false, missing };

  const publishableKey = env.LUMIBASE_PUBLISHABLE_KEY as string;
  if (!publishableKey.startsWith(PUBLISHABLE_PREFIX)) {
    // A secret key here would work — and hand every anonymous visitor
    // whatever that key's grant allows, drafts included.
    throw new Error(
      'LUMIBASE_PUBLISHABLE_KEY must be a publishable key (lbk_pub_…). Secret tokens belong in ' +
        'LUMIBASE_PREVIEW_TOKEN, which is only used for verified preview sessions.',
    );
  }

  // Fail closed: a preview session on a deployment where preview is not fully
  // configured reads as a normal visitor, never with some other credential.
  const usePreview = preview && previewAvailable(env);

  return {
    configured: true,
    config: {
      url: (env.LUMIBASE_URL as string).trim().replace(/\/+$/, ''),
      siteId: present(env.LUMIBASE_SITE_ID) ? env.LUMIBASE_SITE_ID.trim() : '__default__',
      token: usePreview ? (env.LUMIBASE_PREVIEW_TOKEN as string) : publishableKey,
      preview: usePreview,
    },
  };
}

/** URL-safe slugs only; anything else is a 404 rather than a CMS query. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

export function safeSlug(value: unknown): string | null {
  return typeof value === 'string' && SLUG.test(value) ? value : null;
}
