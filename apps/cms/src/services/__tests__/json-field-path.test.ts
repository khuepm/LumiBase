import { describe, expect, it } from 'vitest';
import { resolveFieldPath, ItemServiceError } from '../item-service';

/**
 * Unit tests for the JSON field-path validator (json-field-search Req 5, 6).
 * The validator is the injection-safety gate: any unsafe segment is rejected
 * before SQL is built, and the path is otherwise split into bound segments.
 *
 * **Validates: Requirements 5.1, 5.2, 6.1, 6.5**
 */

describe('resolveFieldPath', () => {
  it('splits a dotted path into segments', () => {
    expect(resolveFieldPath('metadata.author.country')).toEqual(['metadata', 'author', 'country']);
    expect(resolveFieldPath('title')).toEqual(['title']);
    expect(resolveFieldPath('tags.0')).toEqual(['tags', '0']);
  });

  it('rejects unsafe segments (injection guard, Req 6.1)', () => {
    for (const bad of [
      "metadata->>'x'; drop table items;--",
      'a.b)',
      "a.'b",
      'a.b c',
      'a."b"',
      'a.{b}',
    ]) {
      expect(() => resolveFieldPath(bad)).toThrowError(ItemServiceError);
    }
  });

  it('rejects empty segments (Req 6.5)', () => {
    expect(() => resolveFieldPath('a..b')).toThrow();
    expect(() => resolveFieldPath('.a')).toThrow();
    expect(() => resolveFieldPath('a.')).toThrow();
  });

  it('rejects a path that is too deep (Req 5.1)', () => {
    expect(() => resolveFieldPath('a.b.c.d.e.f.g.h.i')).toThrow();
  });

  it('rejects an over-long segment (Req 5.2)', () => {
    expect(() => resolveFieldPath('a'.repeat(65))).toThrow();
  });
});
