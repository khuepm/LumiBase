import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { createSearchIndex } from '../search';
import type { DocEntry } from 'virtual:docs-registry';

/**
 * Feature: lumibase-docs-i18n, Property 4: Search locale isolation
 *
 * For all (L, q), search(L, q) only returns results whose slug ∈ docSlugsByLocale[L].
 *
 * This ensures that searching within a locale never leaks results from other locales.
 * Each locale has its own independent search index built only from documents
 * belonging to that locale.
 *
 * **Validates: Requirements 5.1, 5.2, 5.3**
 */

// ─── Word Lists ──────────────────────────────────────────────────────────────

/**
 * Meaningful words to use in document generation.
 * Using real words ensures MiniSearch can tokenize and index them properly.
 */
const WORDS = [
  'authentication', 'database', 'collection', 'migration', 'deployment',
  'configuration', 'middleware', 'validation', 'integration', 'performance',
  'typescript', 'javascript', 'component', 'interface', 'function',
  'endpoint', 'response', 'request', 'handler', 'service',
  'routing', 'template', 'module', 'package', 'library',
  'testing', 'coverage', 'assertion', 'fixture', 'snapshot',
  'security', 'encryption', 'authorization', 'permission', 'session',
  'storage', 'caching', 'indexing', 'querying', 'filtering',
];

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Generate a locale identifier (2-3 lowercase letters).
 */
const localeArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
  { minLength: 2, maxLength: 3 },
);

/**
 * Generate a valid slug segment.
 */
const slugSegment = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 2, maxLength: 8 },
);

/**
 * Generate a valid slug (1-3 segments joined by '/').
 */
const slugArb = fc.tuple(
  fc.array(slugSegment, { minLength: 0, maxLength: 2 }),
  slugSegment,
).map(([dirs, file]) => [...dirs, file].join('/'));

/**
 * Generate a word from the word list.
 */
const wordArb = fc.constantFrom(...WORDS);

/**
 * Generate a document title (2-4 words).
 */
const titleArb = fc.array(wordArb, { minLength: 2, maxLength: 4 }).map((words) =>
  words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
);

/**
 * Generate document content (3-6 sentences of 3-8 words each).
 */
const contentArb = fc.array(
  fc.array(wordArb, { minLength: 3, maxLength: 8 }).map((words) => words.join(' ')),
  { minLength: 3, maxLength: 6 },
).map((sentences) => sentences.join('. ') + '.');

/**
 * Generate a multi-locale document scenario:
 * - 2-4 unique locales
 * - Each locale has 1-5 documents with unique slugs per locale
 * - Documents across locales may share words but have different slugs
 */
const multiLocaleScenarioArb = fc
  .tuple(
    fc.uniqueArray(localeArb, { minLength: 2, maxLength: 4, comparator: 'IsStrictlyEqual' }),
    fc.uniqueArray(slugArb, { minLength: 2, maxLength: 8, comparator: 'IsStrictlyEqual' }),
  )
  .chain(([locales, slugPool]) => {
    // For each locale, generate documents for a random subset of slugs
    const docsPerLocaleArb = fc.tuple(
      ...locales.map((locale) =>
        fc.shuffledSubarray(slugPool, { minLength: 1, maxLength: slugPool.length }).chain(
          (selectedSlugs) =>
            fc.tuple(
              ...selectedSlugs.map((slug) =>
                fc.tuple(titleArb, contentArb).map(
                  ([title, content]): DocEntry => ({
                    slug,
                    locale,
                    title,
                    filePath: `${locale}/${slug}.md`,
                    content,
                  }),
                ),
              ),
            ),
        ),
      ),
    );

    return docsPerLocaleArb.map((docsArrays) => {
      const docsByLocale: Record<string, DocEntry[]> = {};
      const docSlugsByLocale: Record<string, string[]> = {};

      for (let i = 0; i < locales.length; i++) {
        const locale = locales[i]!;
        const docs = docsArrays[i] as DocEntry[];
        docsByLocale[locale] = docs;
        docSlugsByLocale[locale] = docs.map((d) => d.slug);
      }

      return { locales, docsByLocale, docSlugsByLocale };
    });
  });

/**
 * Generate a full test scenario: multi-locale docs + a locale to query + a query string.
 * The query is derived from a word in the WORDS list to ensure it can match something.
 */
const scenarioArb = multiLocaleScenarioArb.chain(({ locales, docsByLocale, docSlugsByLocale }) => {
  const localeToQuery = fc.constantFrom(...locales);
  const queryArb = wordArb.map((w) => w.slice(0, Math.max(2, w.length))); // at least 2 chars

  return fc.tuple(localeToQuery, queryArb).map(([queryLocale, query]) => ({
    locales,
    docsByLocale,
    docSlugsByLocale,
    queryLocale,
    query,
  }));
});

// ─── Property Test ───────────────────────────────────────────────────────────

describe('Feature: lumibase-docs-i18n, Property 4: Search locale isolation', () => {
  it('search(L, q) only returns slugs belonging to locale L', () => {
    fc.assert(
      fc.property(scenarioArb, ({ docsByLocale, docSlugsByLocale, queryLocale, query }) => {
        // Build a search index for the queried locale only (simulating getSearchIndex behavior)
        const localeDocs = docsByLocale[queryLocale] ?? [];
        const { search } = createSearchIndex(localeDocs);

        // Execute search
        const results = search(query);

        // The allowed slugs for this locale
        const allowedSlugs = new Set(docSlugsByLocale[queryLocale] ?? []);

        // Property 4: every result slug must belong to the queried locale
        for (const result of results) {
          expect(allowedSlugs.has(result.slug)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('search results from one locale never include slugs exclusive to another locale', () => {
    fc.assert(
      fc.property(scenarioArb, ({ docsByLocale, docSlugsByLocale, locales, queryLocale, query }) => {
        // Build a search index for the queried locale only
        const localeDocs = docsByLocale[queryLocale] ?? [];
        const { search } = createSearchIndex(localeDocs);

        // Execute search
        const results = search(query);

        // Collect slugs that are ONLY in other locales (not in queryLocale)
        const queryLocaleSlugs = new Set(docSlugsByLocale[queryLocale] ?? []);
        const otherOnlySlugs = new Set<string>();
        for (const locale of locales) {
          if (locale === queryLocale) continue;
          for (const slug of docSlugsByLocale[locale] ?? []) {
            if (!queryLocaleSlugs.has(slug)) {
              otherOnlySlugs.add(slug);
            }
          }
        }

        // No result should have a slug that only exists in other locales
        for (const result of results) {
          expect(otherOnlySlugs.has(result.slug)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
