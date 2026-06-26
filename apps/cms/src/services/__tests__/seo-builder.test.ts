import { describe, it, expect } from 'vitest';
import { buildSeo } from '../seo-builder';

describe('buildSeo (Req 14)', () => {
  it('builds title/description/canonical/openGraph/jsonLd from seo field', () => {
    const block = buildSeo({
      title: 'Fallback',
      seo: {
        title: 'SEO Title',
        description: 'A description',
        canonical: 'https://example.com/post',
        ogImage: 'https://example.com/og.png',
      },
    });
    expect(block).toBeDefined();
    expect(block!.title).toBe('SEO Title');
    expect(block!.description).toBe('A description');
    expect(block!.canonical).toBe('https://example.com/post');
    expect(block!.openGraph).toMatchObject({
      title: 'SEO Title',
      image: 'https://example.com/og.png',
      url: 'https://example.com/post',
    });
    expect(block!.jsonLd).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      headline: 'SEO Title',
    });
  });

  it('honours a configurable JSON-LD type and never hard-codes a domain type', () => {
    const block = buildSeo({ title: 'X' }, { jsonLdType: 'Article' });
    expect(block!.jsonLd!['@type']).toBe('Article');
  });

  it('falls back to top-level title/description', () => {
    const block = buildSeo({ title: 'Top', excerpt: 'Ex' });
    expect(block!.title).toBe('Top');
    expect(block!.description).toBe('Ex');
  });

  it('never leaks masked or ciphertext values (Req 14.3)', () => {
    const block = buildSeo({
      title: '***',
      seo: { description: 'v1:AAAAciphertext', canonical: 'https://ok.example' },
    });
    // masked title and ciphertext description are skipped; canonical survives.
    expect(block!.title).toBeUndefined();
    expect(block!.description).toBeUndefined();
    expect(block!.canonical).toBe('https://ok.example');
  });

  it('returns undefined when no usable SEO data exists', () => {
    expect(buildSeo({ unrelated: 1 })).toBeUndefined();
  });
});
