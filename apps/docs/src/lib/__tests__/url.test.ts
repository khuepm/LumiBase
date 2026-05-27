import { describe, it, expect } from 'vitest';
import { pathFor, parseUrl } from '../url';

describe('pathFor', () => {
  it('builds a URL path with locale and slug', () => {
    expect(pathFor('en', 'README')).toBe('/en/docs/README');
  });

  it('handles nested slugs', () => {
    expect(pathFor('vi', 'features/ai-copilot')).toBe('/vi/docs/features/ai-copilot');
  });

  it('handles deeply nested slugs', () => {
    expect(pathFor('en', 'architecture/data-model/relations')).toBe(
      '/en/docs/architecture/data-model/relations',
    );
  });
});

describe('parseUrl', () => {
  it('extracts locale and slug from a valid path', () => {
    expect(parseUrl('/en/docs/README')).toEqual({ locale: 'en', slug: 'README' });
  });

  it('extracts locale and nested slug', () => {
    expect(parseUrl('/vi/docs/features/ai-copilot')).toEqual({
      locale: 'vi',
      slug: 'features/ai-copilot',
    });
  });

  it('returns null for root path', () => {
    expect(parseUrl('/')).toBeNull();
  });

  it('returns null for legacy docs path without locale', () => {
    expect(parseUrl('/docs/README')).toBeNull();
  });

  it('returns null for path missing docs segment', () => {
    expect(parseUrl('/en/README')).toBeNull();
  });

  it('returns null for path with only locale and docs but no slug', () => {
    expect(parseUrl('/en/docs/')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseUrl('')).toBeNull();
  });
});

describe('pathFor + parseUrl roundtrip', () => {
  it('parseUrl(pathFor(locale, slug)) returns the original locale and slug', () => {
    const cases = [
      { locale: 'en', slug: 'README' },
      { locale: 'vi', slug: 'features/ai-copilot' },
      { locale: 'ja', slug: 'architecture/data-model' },
    ];

    for (const { locale, slug } of cases) {
      const path = pathFor(locale, slug);
      const parsed = parseUrl(path);
      expect(parsed).toEqual({ locale, slug });
    }
  });
});
