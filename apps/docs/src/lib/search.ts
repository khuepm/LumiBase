import MiniSearch from 'minisearch';
import { docIndexByLocale } from 'virtual:docs-registry';
import type { DocEntry } from 'virtual:docs-registry';

export interface SearchResult {
  slug: string;
  title: string;
  snippet: string;
  score: number;
}

/** Lazy cache: one MiniSearch index per locale, built on first access */
const indexes: Map<string, MiniSearch<DocEntry>> = new Map();

/**
 * Get or build the search index for a given locale.
 * Only indexes documents from that locale — no fallback documents.
 */
export function getSearchIndex(locale: string): MiniSearch<DocEntry> {
  if (indexes.has(locale)) return indexes.get(locale)!;

  const docs = docIndexByLocale[locale] ?? {};
  const idx = new MiniSearch<DocEntry>({
    fields: ['title', 'content'],
    storeFields: ['title', 'slug'],
    searchOptions: {
      prefix: true,
      fuzzy: 0.1,
      boost: { title: 2, content: 1 },
    },
    idField: 'slug',
  });

  idx.addAll(Object.values(docs));
  indexes.set(locale, idx);
  return idx;
}

/**
 * Extract a snippet from content around the first occurrence of any matched term.
 * Highlights matched terms by wrapping them in <mark> tags.
 */
function extractSnippet(content: string, terms: string[]): string {
  const snippetLength = 150;
  const lowerContent = content.toLowerCase();

  // Find the first matching term position
  let firstMatchIndex = -1;
  let matchedTerm = '';

  for (const term of terms) {
    const idx = lowerContent.indexOf(term.toLowerCase());
    if (idx !== -1 && (firstMatchIndex === -1 || idx < firstMatchIndex)) {
      firstMatchIndex = idx;
      matchedTerm = term;
    }
  }

  if (firstMatchIndex === -1) {
    // No match found in content, return beginning of content
    const raw = content.slice(0, snippetLength).trim();
    return raw + (content.length > snippetLength ? '…' : '');
  }

  // Extract a window around the match
  const start = Math.max(0, firstMatchIndex - 40);
  const end = Math.min(content.length, start + snippetLength);
  let snippet = content.slice(start, end).trim();

  if (start > 0) snippet = '…' + snippet;
  if (end < content.length) snippet = snippet + '…';

  // Highlight all matched terms in the snippet
  snippet = highlightTerms(snippet, terms);

  return snippet;
}

/**
 * Wrap matched terms in <mark> tags for highlighting.
 */
function highlightTerms(text: string, terms: string[]): string {
  if (terms.length === 0) return text;

  // Build a regex that matches any of the terms (case-insensitive)
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');

  return text.replace(pattern, '<mark>$1</mark>');
}

/**
 * Search documents by query within a specific locale.
 * Returns results ranked by relevance. Only processes queries of at least 2 characters.
 * Results only include documents from the specified locale — no fallback.
 */
export function search(locale: string, query: string): SearchResult[] {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const idx = getSearchIndex(locale);
  const docs = docIndexByLocale[locale] ?? {};

  const results = idx.search(trimmed, {
    prefix: true,
    fuzzy: 0.1,
    boost: { title: 2, content: 1 },
  });

  return results.map((result) => {
    const doc = docs[result.id as string];
    const content = doc?.content ?? '';
    const terms = result.terms ?? [];

    return {
      slug: result.id as string,
      title: (result.title as string) ?? '',
      snippet: extractSnippet(content, terms),
      score: result.score,
    };
  });
}

/**
 * Re-export for testing purposes: allows creating a fresh search instance
 * with custom documents.
 */
export function createSearchIndex(documents: DocEntry[]) {
  const index = new MiniSearch<DocEntry>({
    fields: ['title', 'content'],
    storeFields: ['title', 'slug'],
    searchOptions: {
      prefix: true,
      fuzzy: 0.1,
      boost: { title: 2, content: 1 },
    },
    idField: 'slug',
  });

  index.addAll(documents);

  return {
    search(query: string): SearchResult[] {
      const trimmed = query.trim();
      if (trimmed.length < 2) return [];

      const results = index.search(trimmed, {
        prefix: true,
        fuzzy: 0.1,
        boost: { title: 2, content: 1 },
      });

      return results.map((result) => {
        const doc = documents.find((d) => d.slug === result.id);
        const content = doc?.content ?? '';
        const terms = result.terms ?? [];

        return {
          slug: result.id as string,
          title: (result.title as string) ?? '',
          snippet: extractSnippet(content, terms),
          score: result.score,
        };
      });
    },
  };
}
