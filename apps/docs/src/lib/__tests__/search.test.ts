import { describe, it, expect } from 'vitest';
import { createSearchIndex } from '../search';
import type { DocEntry } from 'virtual:docs-registry';

function makeDoc(slug: string, title: string, content: string): DocEntry {
  return { slug, locale: 'en', title, filePath: `${slug}.md`, content };
}

describe('search service', () => {
  const docs: DocEntry[] = [
    makeDoc('getting-started', 'Getting Started', 'Welcome to LumiBase. This guide helps you set up the project quickly.'),
    makeDoc('features/collections', 'Collections Builder', 'Create and manage collections with the visual builder interface.'),
    makeDoc('features/relations', 'Relations', 'Define relationships between collections using foreign keys and references.'),
    makeDoc('api/authentication', 'Authentication', 'Authenticate using JWT tokens. Supports bearer token and API key methods.'),
    makeDoc('README', 'LumiBase Documentation', 'Overview of the LumiBase platform and its features.'),
  ];

  const { search } = createSearchIndex(docs);

  it('returns empty array for queries shorter than 2 characters', () => {
    expect(search('')).toEqual([]);
    expect(search('a')).toEqual([]);
    expect(search(' ')).toEqual([]);
  });

  it('returns matching results for a valid query', () => {
    const results = search('collections');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.slug === 'features/collections')).toBe(true);
  });

  it('returns results with slug, title, snippet, and score', () => {
    const results = search('authentication');
    expect(results.length).toBeGreaterThan(0);

    const result = results[0]!;
    expect(result).toHaveProperty('slug');
    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('snippet');
    expect(result).toHaveProperty('score');
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThan(0);
  });

  it('boosts title matches over content matches', () => {
    const results = search('relations');
    expect(results.length).toBeGreaterThan(0);
    // The doc with "Relations" as title should rank higher
    expect(results[0]!.slug).toBe('features/relations');
  });

  it('supports prefix search', () => {
    const results = search('auth');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.slug === 'api/authentication')).toBe(true);
  });

  it('supports fuzzy matching', () => {
    // "collectons" is a typo for "collections"
    const results = search('collectons');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.slug === 'features/collections')).toBe(true);
  });

  it('highlights matched terms in snippets with <mark> tags', () => {
    const results = search('collections');
    const result = results.find((r) => r.slug === 'features/collections');
    expect(result).toBeDefined();
    expect(result!.snippet).toContain('<mark>');
    expect(result!.snippet.toLowerCase()).toContain('collection');
  });

  it('returns snippets as text excerpts around matched terms', () => {
    const results = search('JWT');
    const result = results.find((r) => r.slug === 'api/authentication');
    expect(result).toBeDefined();
    expect(result!.snippet.length).toBeGreaterThan(0);
    expect(result!.snippet.length).toBeLessThanOrEqual(300);
  });

  it('handles whitespace-only queries', () => {
    expect(search('   ')).toEqual([]);
  });

  it('returns results within reasonable time', () => {
    const start = performance.now();
    search('lumibase');
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(300);
  });
});
