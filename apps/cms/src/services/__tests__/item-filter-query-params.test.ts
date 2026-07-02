import { describe, expect, it } from 'vitest';
import { parseFilterQueryParams } from '../item-service';

const params = (qs: string) => new URLSearchParams(qs);

describe('parseFilterQueryParams', () => {
  it('returns undefined when no filter is present', () => {
    expect(parseFilterQueryParams(params('limit=10'), undefined)).toBeUndefined();
    expect(parseFilterQueryParams(params(''), '')).toBeUndefined();
  });

  describe('JSON form (backward compatible)', () => {
    it('parses a JSON filter string', () => {
      const json = JSON.stringify({ status: { _eq: 'published' } });
      expect(parseFilterQueryParams(params(''), json)).toEqual({
        status: { _eq: 'published' },
      });
    });

    it('JSON form wins when both forms are present', () => {
      const json = JSON.stringify({ status: { _eq: 'draft' } });
      // bracket says published, JSON says draft → JSON wins
      const sp = params('filter[status][_eq]=published');
      expect(parseFilterQueryParams(sp, json)).toEqual({ status: { _eq: 'draft' } });
    });

    it('throws SyntaxError on malformed JSON (caller maps to 400)', () => {
      expect(() => parseFilterQueryParams(params(''), '{not json')).toThrow(SyntaxError);
    });
  });

  describe('bracket form', () => {
    it('parses a single nested operator', () => {
      const sp = params('filter[status][_eq]=published');
      expect(parseFilterQueryParams(sp, undefined)).toEqual({
        status: { _eq: 'published' },
      });
    });

    it('parses multiple top-level fields', () => {
      const sp = params('filter[status][_eq]=published&filter[views][_gte]=100');
      expect(parseFilterQueryParams(sp, undefined)).toEqual({
        status: { _eq: 'published' },
        views: { _gte: 100 },
      });
    });

    it('coerces booleans, numbers and null', () => {
      const sp = params('filter[featured][_eq]=true&filter[views][_gt]=5&filter[archivedAt][_eq]=null');
      expect(parseFilterQueryParams(sp, undefined)).toEqual({
        featured: { _eq: true },
        views: { _gt: 5 },
        archivedAt: { _eq: null },
      });
    });

    it('splits comma values for array operators into arrays', () => {
      const sp = params('filter[status][_in]=published,scheduled&filter[score][_between]=1,10');
      expect(parseFilterQueryParams(sp, undefined)).toEqual({
        status: { _in: ['published', 'scheduled'] },
        score: { _between: [1, 10] },
      });
    });

    it('supports nested logical grouping', () => {
      const sp = params('filter[_and][0][status][_eq]=published&filter[_and][1][views][_gte]=100');
      expect(parseFilterQueryParams(sp, undefined)).toEqual({
        _and: {
          '0': { status: { _eq: 'published' } },
          '1': { views: { _gte: 100 } },
        },
      });
    });

    it('keeps leading-zero strings as strings (no lossy number coercion)', () => {
      const sp = params('filter[code][_eq]=007');
      expect(parseFilterQueryParams(sp, undefined)).toEqual({ code: { _eq: '007' } });
    });

    it('ignores malformed bracket keys instead of throwing', () => {
      const sp = params('filter[status]=oops&filter[]=bad&filterxyz=nope');
      // `filter[status]=oops` is a valid single-segment path → status: 'oops'
      // `filter[]` and `filterxyz` are ignored
      expect(parseFilterQueryParams(sp, undefined)).toEqual({ status: 'oops' });
    });
  });
});
