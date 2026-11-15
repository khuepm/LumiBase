/**
 * Which credential this build reads content with — kept free of `astro:*`
 * imports so the rules are plain TypeScript that anything can test.
 *
 *  - no URL, or no key → `configured: false`; the site builds a
 *    "connect your CMS" page instead of failing a first deploy;
 *  - a normal build uses the PUBLISHABLE key (`lbk_pub_…`) and asks for
 *    published rows only;
 *  - a draft preview build (`preview: true`) needs a separate secret token
 *    whose grant includes drafts. It fails closed: a preview build without
 *    that token is an error, never a silent fallback to published content.
 */

export interface ContentConfig {
  url: string;
  siteId: string;
  token: string;
  preview: boolean;
}

export type ConfigResult =
  | { configured: true; config: ContentConfig }
  | { configured: false; missing: string[] };

export interface ContentEnv {
  url?: string | undefined;
  siteId?: string | undefined;
  publishableKey?: string | undefined;
  preview?: boolean | undefined;
  previewToken?: string | undefined;
}

const present = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const PUBLISHABLE_PREFIX = 'lbk_pub_';

export function resolveContentConfig(env: ContentEnv): ConfigResult {
  const preview = env.preview === true;
  const missing: string[] = [];
  if (!present(env.url)) missing.push('LUMIBASE_URL');
  if (!preview && !present(env.publishableKey)) missing.push('LUMIBASE_PUBLISHABLE_KEY');
  if (missing.length > 0) return { configured: false, missing };

  let token: string;
  if (preview) {
    if (!present(env.previewToken)) {
      throw new Error(
        'LUMIBASE_PREVIEW=true but LUMIBASE_PREVIEW_TOKEN is empty. A preview build needs a ' +
          'server-side token whose grant includes drafts; refusing to build a "preview" that ' +
          'silently shows only published content.',
      );
    }
    if (env.previewToken.startsWith(PUBLISHABLE_PREFIX)) {
      throw new Error(
        'LUMIBASE_PREVIEW_TOKEN is a publishable key (lbk_pub_…). Publishable keys are meant to ' +
          'be restricted to published rows, so they cannot preview drafts.',
      );
    }
    token = env.previewToken;
  } else {
    token = env.publishableKey as string;
    if (!token.startsWith(PUBLISHABLE_PREFIX)) {
      // A secret key here would work — and widen what a normal build can
      // read to whatever that key's grant allows, drafts included.
      throw new Error(
        'LUMIBASE_PUBLISHABLE_KEY must be a publishable key (lbk_pub_…). Use a read-only, ' +
          'published-only key for production builds; secret tokens belong in ' +
          'LUMIBASE_PREVIEW_TOKEN on a protected preview environment.',
      );
    }
  }

  return {
    configured: true,
    config: {
      url: (env.url as string).trim().replace(/\/+$/, ''),
      siteId: present(env.siteId) ? env.siteId.trim() : '__default__',
      token,
      preview,
    },
  };
}

/** URL-safe slugs only; anything else is skipped rather than routed. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

export function safeSlug(value: unknown): string | null {
  return typeof value === 'string' && SLUG.test(value) ? value : null;
}
