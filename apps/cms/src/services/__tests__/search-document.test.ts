import { SEARCH_META_ATTRS } from '@lumibase/runtime';
import { describe, expect, it } from 'vitest';
import { buildSearchDocument } from '../search-document';

describe('buildSearchDocument', () => {
  it('adds reserved meta attrs and keeps the item data searchable', () => {
    const doc = buildSearchDocument('articles', 'i1', {
      title: 'Hà Nội mùa thu',
      body: 'Thủ đô nghìn năm',
      updated_at: '2026-06-01T00:00:00.000Z',
    });
    expect(doc.id).toBe('i1');
    expect(doc[SEARCH_META_ATTRS.collection]).toBe('articles');
    expect(doc[SEARCH_META_ATTRS.title]).toBe('Hà Nội mùa thu');
    expect(doc[SEARCH_META_ATTRS.updatedAt]).toBe('2026-06-01T00:00:00.000Z');
    expect(doc.body).toBe('Thủ đô nghìn năm');
  });

  it('falls back through title candidates then first string then id', () => {
    expect(buildSearchDocument('c', 'i', { name: 'By name' })[SEARCH_META_ATTRS.title]).toBe('By name');
    expect(buildSearchDocument('c', 'i', { foo: 'first string' })[SEARCH_META_ATTRS.title]).toBe('first string');
    expect(buildSearchDocument('c', 'i', { n: 5 })[SEARCH_META_ATTRS.title]).toBe('i');
  });

  it('omits _updatedAt when no usable timestamp is present', () => {
    const doc = buildSearchDocument('c', 'i', { title: 't' });
    expect(SEARCH_META_ATTRS.updatedAt in doc).toBe(false);
  });
});
