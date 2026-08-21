import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { pathFor, parseUrl } from '../url';

/**
 * Feature: lumibase-docs-i18n, Property 1: Locale prefix idempotency
 *
 * For all valid locale L and slug s:
 *   parseUrl(pathFor(L, s)) === { locale: L, slug: s }
 *
 * This ensures that building a URL path and parsing it back yields the
 * original locale and slug — the two functions are inverses of each other.
 *
 * Validates: Requirements 2.1, 2.2
 */

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Generate a valid locale string (2-3 lowercase letters).
 */
const localeArb = fc.string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), minLength: 2, maxLength: 3 });

/**
 * Generate a valid slug segment (alphanumeric + hyphens, non-empty).
 */
const slugSegment = fc.string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), minLength: 1, maxLength: 10 });

/**
 * Generate a valid slug (1-3 segments joined by '/').
 */
const slugArb = fc
  .array(slugSegment, { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join('/'));

// ─── Property Test ───────────────────────────────────────────────────────────

describe('Feature: lumibase-docs-i18n, Property 1: Locale prefix idempotency', () => {
  it('parseUrl(pathFor(L, s)) returns { locale: L, slug: s } for all valid L and s', () => {
    fc.assert(
      fc.property(localeArb, slugArb, (locale, slug) => {
        const path = pathFor(locale, slug);
        const parsed = parseUrl(path);

        expect(parsed).not.toBeNull();
        expect(parsed!.locale).toBe(locale);
        expect(parsed!.slug).toBe(slug);
      }),
      { numRuns: 100 },
    );
  });
});
