import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { resolveDocPure } from '../resolveDoc';
import type { DocEntry } from 'virtual:docs-registry';

/**
 * Feature: lumibase-docs-i18n, Property 2: Fallback chain correctness
 *
 * For all locale L and slug s, resolveDoc(L, s):
 * - Never returns an entry with locale !== L && locale !== defaultLocale
 * - If isFallback is true, then docIndexByLocale[L][s] is undefined
 * - If isFallback is false, then entry.locale === L
 *
 * **Validates: Requirements 4.1, 4.2, 4.3**
 */

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Generate a valid locale string (2-3 lowercase letters).
 */
const localeArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
  { minLength: 2, maxLength: 3 },
);

/**
 * Generate a valid slug segment (alphanumeric + hyphens, non-empty).
 */
const slugSegment = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
  { minLength: 1, maxLength: 8 },
);

/**
 * Generate a valid slug (1-3 segments joined by '/').
 */
const slugArb = fc
  .array(slugSegment, { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join('/'));

/**
 * Generate a DocEntry for a given locale and slug.
 */
function makeEntry(locale: string, slug: string): DocEntry {
  return {
    slug,
    locale,
    title: `${slug} (${locale})`,
    filePath: `${locale}/${slug}.md`,
    content: `Content for ${slug} in ${locale}`,
  };
}

/**
 * Generate a registry scenario: a set of locales, a default locale,
 * and a docIndexByLocale with random slug assignments per locale.
 */
const registryArb = fc
  .tuple(
    // Generate 2-4 unique locales
    fc.uniqueArray(localeArb, { minLength: 2, maxLength: 4, comparator: 'IsStrictlyEqual' }),
    // Generate 1-6 unique slugs
    fc.uniqueArray(slugArb, { minLength: 1, maxLength: 6, comparator: 'IsStrictlyEqual' }),
  )
  .map(([locales, slugs]) => {
    // Pick the first locale as defaultLocale
    const defaultLocale = locales[0];

    // Build docIndexByLocale: for each locale, randomly include some slugs
    const docIndexByLocale: Record<string, Record<string, DocEntry>> = {};
    for (const locale of locales) {
      docIndexByLocale[locale] = {};
    }

    return { locales, defaultLocale, slugs, docIndexByLocale };
  })
  .chain(({ locales, defaultLocale, slugs, docIndexByLocale }) => {
    // For each (locale, slug) pair, randomly decide if the doc exists
    const booleans = fc.array(fc.boolean(), {
      minLength: locales.length * slugs.length,
      maxLength: locales.length * slugs.length,
    });

    return booleans.map((bools) => {
      let idx = 0;
      for (const locale of locales) {
        for (const slug of slugs) {
          if (bools[idx]) {
            docIndexByLocale[locale][slug] = makeEntry(locale, slug);
          }
          idx++;
        }
      }
      return { locales, defaultLocale, slugs, docIndexByLocale };
    });
  });

/**
 * Generate a full test scenario: registry + a (locale, slug) pair to query.
 */
const scenarioArb = registryArb.chain(({ locales, defaultLocale, slugs, docIndexByLocale }) => {
  // Pick a locale to query (could be any from the list)
  const localeToQuery = fc.constantFrom(...locales);
  // Pick a slug to query (could be from the slug list or a random one that doesn't exist)
  const slugToQuery = fc.oneof(
    fc.constantFrom(...slugs),
    slugArb, // might not exist in registry
  );

  return fc.tuple(localeToQuery, slugToQuery).map(([queryLocale, querySlug]) => ({
    locales,
    defaultLocale,
    slugs,
    docIndexByLocale,
    queryLocale,
    querySlug,
  }));
});

// ─── Property Test ───────────────────────────────────────────────────────────

describe('Feature: lumibase-docs-i18n, Property 2: Fallback chain correctness', () => {
  it('resolveDoc never returns entry with locale !== L && locale !== defaultLocale', () => {
    fc.assert(
      fc.property(scenarioArb, ({ defaultLocale, docIndexByLocale, queryLocale, querySlug }) => {
        const result = resolveDocPure(queryLocale, querySlug, docIndexByLocale, defaultLocale);

        if (result !== null) {
          // The entry's locale must be either the requested locale or the default locale
          const entryLocale = result.entry.locale;
          expect(
            entryLocale === queryLocale || entryLocale === defaultLocale,
          ).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('if isFallback is true, then docIndexByLocale[locale][slug] is undefined', () => {
    fc.assert(
      fc.property(scenarioArb, ({ defaultLocale, docIndexByLocale, queryLocale, querySlug }) => {
        const result = resolveDocPure(queryLocale, querySlug, docIndexByLocale, defaultLocale);

        if (result !== null && result.isFallback) {
          // The requested locale must NOT have this slug
          const localeIndex = docIndexByLocale[queryLocale];
          expect(localeIndex?.[querySlug]).toBeUndefined();
        }
      }),
      { numRuns: 100 },
    );
  });

  it('if isFallback is false, then entry.locale === requested locale', () => {
    fc.assert(
      fc.property(scenarioArb, ({ defaultLocale, docIndexByLocale, queryLocale, querySlug }) => {
        const result = resolveDocPure(queryLocale, querySlug, docIndexByLocale, defaultLocale);

        if (result !== null && !result.isFallback) {
          expect(result.entry.locale).toBe(queryLocale);
        }
      }),
      { numRuns: 100 },
    );
  });
});
