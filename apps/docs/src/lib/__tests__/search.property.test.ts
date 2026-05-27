import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { createSearchIndex } from '../search';
import type { DocEntry } from 'virtual:docs-registry';

/**
 * Feature: lumibase-docs-viewer, Property 5: Search returns relevant results with highlighted terms
 *
 * For any indexed document set and any query of at least 2 characters that matches
 * at least one document's title or content, the search results SHALL include documents
 * containing the query terms, and the result snippets SHALL contain the matched terms
 * marked for highlighting.
 *
 * Validates: Requirements 7.2, 7.3
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
 * Generate a word from the word list.
 */
const word = fc.constantFrom(...WORDS);

/**
 * Generate a sentence of 3-10 words from the word list.
 */
const sentence = fc.array(word, { minLength: 3, maxLength: 10 }).map((words) => words.join(' '));

/**
 * Generate a document title (2-5 words).
 */
const docTitle = fc.array(word, { minLength: 2, maxLength: 5 }).map((words) =>
  words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
);

/**
 * Generate document content (3-8 sentences).
 */
const docContent = fc.array(sentence, { minLength: 3, maxLength: 8 }).map((sentences) =>
  sentences.join('. ') + '.',
);

/**
 * Generate a valid slug (lowercase, path-like).
 */
const slug = fc.tuple(
  fc.constantFrom('guides', 'features', 'api', 'reference', 'tutorials'),
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
    minLength: 3,
    maxLength: 10,
  }),
).map(([dir, name]) => `${dir}/${name}`);

/**
 * Generate a DocEntry with meaningful content.
 */
const docEntry = fc.tuple(slug, docTitle, docContent).map(
  ([s, title, content]): DocEntry => ({
    slug: s,
    locale: 'en',
    title,
    filePath: `${s}.md`,
    content,
  }),
);

/**
 * Generate a unique set of DocEntry objects (unique by slug).
 */
const docSet = fc.uniqueArray(docEntry, {
  minLength: 2,
  maxLength: 10,
  comparator: (a, b) => a.slug === b.slug,
});

/**
 * Generate a document set paired with a query that is guaranteed to match
 * in the content of at least one document. This ensures the snippet highlighting
 * can work (snippets are extracted from content, not titles).
 */
const docSetWithMatchingQuery = docSet.chain((docs) => {
  // Collect words that appear in document content (not just titles)
  // This ensures the query will match content and produce highlighted snippets
  const contentWords: string[] = [];
  for (const doc of docs) {
    const words = doc.content
      .toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length >= 3);
    contentWords.push(...words);
  }

  // Pick a random word from document content as the query
  if (contentWords.length === 0) {
    return fc.constant({ docs, query: 'testing' });
  }

  // Deduplicate to avoid bias
  const uniqueWords = [...new Set(contentWords)];
  return fc.constantFrom(...uniqueWords).map((query) => ({ docs, query }));
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check if a snippet contains highlighted (marked) terms.
 */
function hasHighlightedTerms(snippet: string): boolean {
  return /<mark>.+?<\/mark>/.test(snippet);
}

// ─── Property Test ───────────────────────────────────────────────────────────

describe('Feature: lumibase-docs-viewer, Property 5: Search returns relevant results with highlighted terms', () => {
  it('should return matching documents with highlighted snippets for valid queries', () => {
    fc.assert(
      fc.property(docSetWithMatchingQuery, ({ docs, query }) => {
        const { search } = createSearchIndex(docs);
        const results = search(query);

        // The query is derived from document content, so we expect results
        expect(results.length).toBeGreaterThan(0);

        // Every result must have the required fields
        for (const result of results) {
          expect(result).toHaveProperty('slug');
          expect(result).toHaveProperty('title');
          expect(result).toHaveProperty('snippet');
          expect(result).toHaveProperty('score');
          expect(typeof result.slug).toBe('string');
          expect(typeof result.title).toBe('string');
          expect(typeof result.snippet).toBe('string');
          expect(result.score).toBeGreaterThan(0);
        }

        // Each result slug should correspond to an indexed document
        const slugSet = new Set(docs.map((d) => d.slug));
        for (const result of results) {
          expect(slugSet.has(result.slug)).toBe(true);
        }

        // Find results whose source document content contains the query term
        const resultsWithContentMatch = results.filter((r) => {
          const doc = docs.find((d) => d.slug === r.slug);
          return doc && doc.content.toLowerCase().includes(query.toLowerCase());
        });

        // At least one result should have content containing the query
        // (since we derived the query from content)
        expect(resultsWithContentMatch.length).toBeGreaterThan(0);

        // Results whose content contains the query should have highlighted snippets
        for (const result of resultsWithContentMatch) {
          expect(hasHighlightedTerms(result.snippet)).toBe(true);

          // The highlighted text within <mark> tags should be non-empty
          const markMatches = result.snippet.match(/<mark>(.+?)<\/mark>/g);
          expect(markMatches).not.toBeNull();
          expect(markMatches!.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});
