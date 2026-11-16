import { describe, expect, it } from 'vitest';
import { jsonEqual } from '../json-equal';

describe('jsonEqual', () => {
  it('ignores object key order, as JSONB reorders keys on save', () => {
    const draft = { slug: 'a', title: 'A', body: 'text' };
    const saved = { body: 'text', slug: 'a', title: 'A' };
    expect(JSON.stringify(draft)).not.toBe(JSON.stringify(saved));
    expect(jsonEqual(draft, saved)).toBe(true);
  });

  it('compares nested objects and arrays structurally', () => {
    expect(jsonEqual({ a: [{ x: 1, y: 2 }] }, { a: [{ y: 2, x: 1 }] })).toBe(true);
    expect(jsonEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });

  it('reports real differences', () => {
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual({ a: null }, {})).toBe(false);
    expect(jsonEqual({ a: '1' }, { a: 1 })).toBe(false);
  });

  it('treats undefined members as absent, like JSON serialisation does', () => {
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });
});
