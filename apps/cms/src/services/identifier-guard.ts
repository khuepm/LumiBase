/**
 * Shape guards for public-path identifiers
 * (high-load-cache-readiness Req 19.1–19.3; design §14.6).
 *
 * Pure regex / length checks — never look up existence. Bad shape → cheap 404
 * (or 400 for the explicit `X-Lumi-Site` header) with zero DB / cache ops.
 *
 * Site-id regex is deliberately broader than strict nanoid(21): a survey of
 * production + test fixtures (task 22.1) found `__default__`, `site-a`,
 * `site_test`, short labels, and real nanoids all in active use. Restricting
 * to 21-char nanoid would reject legitimate tenants. The bound is alphabet +
 * max length so path-traversal / injection / oversized keys are still rejected.
 */

/** Nanoid default alphabet; length flexible 1–64 (see module note). */
export const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Page / delivery slug. Lowercase alphanumeric segments separated by `/`, `_`,
 * or `-`. Max 200 chars. Surveyed fixtures: `home`, `seo-toolkit`,
 * `features/ai-copilot` — all match. Uppercase / spaces / dots rejected.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:[/_-][a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 200;

/**
 * Collection / field machine name. Moved from `deliver.ts` (`SAFE_FIELD_NAME`)
 * so the regex is not duplicated. Schema create still enforces the stricter
 * `^[a-z][a-z0-9_]{0,62}$` — this guard is the cheap public-path filter.
 */
export const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type IdentifierKind = 'siteId' | 'slug' | 'collection';

export function isValidSiteId(value: string): boolean {
  return SITE_ID_PATTERN.test(value);
}

export function isValidSlug(value: string): boolean {
  return value.length > 0 && value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}

export function isValidCollectionName(value: string): boolean {
  return SAFE_FIELD_NAME.test(value);
}

/**
 * Normalize a slug for negative-cache key material (design §14.5):
 * lowercase, trim, clamp to LUMIBASE_NEGATIVE_KEY_MAXLEN (default 256).
 */
export function normalizeSlugForKey(slug: string, maxLen = 256): string {
  return slug.trim().toLowerCase().slice(0, maxLen);
}

/**
 * Assert identifier shape for public URL params. Returns a 404-shaped error
 * descriptor — callers must NOT use 400 here (that would oracle "shape ok").
 */
export function assertPublicIdentifier(
  kind: IdentifierKind,
  value: string,
): { ok: true } | { ok: false; status: 404; body: { error: string } } {
  const valid =
    kind === 'siteId'
      ? isValidSiteId(value)
      : kind === 'slug'
        ? isValidSlug(value)
        : isValidCollectionName(value);
  if (valid) return { ok: true };
  return { ok: false, status: 404, body: { error: 'Not found.' } };
}
