import { createLumiClient, legacyRest } from '@lumibase/sdk';

/**
 * Schema for a Tier 2 (regulated/sensitive) content project.
 *
 * NOTE the deliberate split:
 *   - PUBLIC fields (title, slug, body, seo) are safe to render anywhere.
 *   - `pii`/`phi`-classified fields (e.g. a patient's contact details) are
 *     NEVER part of this public schema and are NOT fetched here. They require
 *     a `read_decrypted` token, which must stay server-side in an
 *     authenticated, audited context — never in this public frontend.
 */
export interface SensitiveSchema {
  articles: {
    id: string;
    slug: string;
    title: string;
    body: string;
    // Structured SEO/AIO source fields surfaced as `_seo` by the Delivery API.
    seo?: {
      title?: string;
      description?: string;
      canonical?: string;
      ogImage?: string;
    };
    status: 'draft' | 'published' | 'archived';
    // Scheduling: the Delivery API only returns items inside the Publish_Window.
    publishAt?: string | null;
    unpublishAt?: string | null;
  };
}

const url = process.env.LUMIBASE_URL || 'http://127.0.0.1:1989';
const token = process.env.LUMIBASE_TOKEN || '';
const siteId = process.env.LUMIBASE_SITE_ID || '';

if (!token || !siteId) {
  console.warn(
    '[LumiBase] Missing LUMIBASE_TOKEN or LUMIBASE_SITE_ID. Fetching will fail.'
  );
}

const baseClient = createLumiClient<SensitiveSchema>({ url, token, siteId });

export const lumi = baseClient.with(legacyRest());

/** Cache tag used for ISR revalidation (matches the collection name). */
export const ARTICLES_TAG = 'articles';
