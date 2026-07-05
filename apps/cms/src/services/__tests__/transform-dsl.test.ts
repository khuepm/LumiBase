import { MAX_DIM, parseTransformQuery, transformDslSchema, transformKey } from '@lumibase/shared';
import { describe, expect, it } from 'vitest';

describe('transform DSL schema', () => {
  it('accepts a well-formed transform', () => {
    const parsed = transformDslSchema.safeParse({ width: 200, height: 100, format: 'webp', quality: 80, fit: 'cover' });
    expect(parsed.success).toBe(true);
  });

  it('rejects dimensions over MAX_DIM', () => {
    expect(transformDslSchema.safeParse({ width: MAX_DIM + 1 }).success).toBe(false);
    expect(transformDslSchema.safeParse({ height: 99999 }).success).toBe(false);
  });

  it('rejects out-of-range quality and unknown format', () => {
    expect(transformDslSchema.safeParse({ quality: 0 }).success).toBe(false);
    expect(transformDslSchema.safeParse({ quality: 101 }).success).toBe(false);
    expect(transformDslSchema.safeParse({ format: 'gif' }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(transformDslSchema.safeParse({ width: 10, sharpen: true }).success).toBe(false);
  });

  it('validates focal point bounds', () => {
    expect(transformDslSchema.safeParse({ focal: { x: 0.5, y: 0.5 } }).success).toBe(true);
    expect(transformDslSchema.safeParse({ focal: { x: 1.5, y: 0 } }).success).toBe(false);
  });
});

describe('parseTransformQuery', () => {
  it('coerces string query params to a typed DSL', () => {
    const dsl = parseTransformQuery({ width: '300', quality: '75', format: 'avif' });
    expect(dsl).toEqual({ width: 300, quality: 75, format: 'avif' });
  });

  it('parses focal from comma form and fx/fy form identically', () => {
    expect(parseTransformQuery({ focal: '0.25,0.75' }).focal).toEqual({ x: 0.25, y: 0.75 });
    expect(parseTransformQuery({ fx: '0.25', fy: '0.75' }).focal).toEqual({ x: 0.25, y: 0.75 });
  });
});

describe('transformKey', () => {
  it('is stable regardless of parameter order', () => {
    const a = transformKey('img.jpg', { width: 100, height: 50, format: 'webp' });
    const b = transformKey('img.jpg', { format: 'webp', height: 50, width: 100 });
    expect(a).toBe(b);
  });

  it('returns the original key for an empty DSL (backward compatible)', () => {
    expect(transformKey('img.jpg', {})).toBe('img.jpg');
  });

  it('changes when a parameter changes', () => {
    expect(transformKey('img.jpg', { width: 100 })).not.toBe(transformKey('img.jpg', { width: 200 }));
  });
});
