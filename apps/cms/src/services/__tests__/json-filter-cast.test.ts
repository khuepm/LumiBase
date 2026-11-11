import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  CastValueError,
  buildJsonPathIndexAdvice,
  castExpression,
  castKindForFieldType,
  castValue,
  inferCastKindFromValue,
} from '../json-filter-cast';

/**
 * Unit tests for the Cast_Rule helpers (json-field-search Req 4, #729).
 */

const dialect = new PgDialect();
const render = (q: ReturnType<typeof sql>) => dialect.sqlToQuery(q);

describe('castKindForFieldType', () => {
  it('maps schema types to cast kinds (Req 4.2)', () => {
    for (const t of ['integer', 'bigInteger', 'decimal', 'float']) expect(castKindForFieldType(t)).toBe('numeric');
    expect(castKindForFieldType('boolean')).toBe('boolean');
    for (const t of ['date', 'datetime', 'dateTime', 'timestamp']) expect(castKindForFieldType(t)).toBe('timestamp');
    for (const t of ['string', 'text', 'uuid', 'time', 'csv']) expect(castKindForFieldType(t)).toBe('text');
  });

  it('returns null for containers and unknown fields (Req 4.5)', () => {
    expect(castKindForFieldType('json')).toBeNull();
    expect(castKindForFieldType('alias')).toBeNull();
    expect(castKindForFieldType(undefined)).toBeNull();
  });
});

describe('inferCastKindFromValue', () => {
  it('promotes only unambiguous JSON scalars', () => {
    expect(inferCastKindFromValue(10)).toBe('numeric');
    expect(inferCastKindFromValue([1, 2])).toBe('numeric');
    expect(inferCastKindFromValue(true)).toBe('boolean');
    expect(inferCastKindFromValue('10')).toBe('text');
    expect(inferCastKindFromValue(Number.NaN)).toBe('text');
    expect(inferCastKindFromValue(null)).toBe('text');
  });
});

describe('castValue', () => {
  it('binds typed parameters', () => {
    const q = render(sql`x > ${castValue('10.5', 'numeric')}`);
    expect(q.sql).toBe('x > $1::numeric');
    expect(q.params).toEqual(['10.5']);
    expect(render(sql`${castValue(false, 'boolean')}`).params).toEqual(['false']);
    expect(render(sql`${castValue('2026-01-01', 'timestamp')}`).params).toEqual(['2026-01-01T00:00:00.000Z']);
    // A bare number on a date field is a year, not epoch milliseconds.
    expect(render(sql`${castValue(2026, 'timestamp')}`).params).toEqual(['2026-01-01T00:00:00.000Z']);
  });

  it('rejects values that cannot be represented (no DB error)', () => {
    expect(() => castValue('cheap', 'numeric')).toThrow(CastValueError);
    expect(() => castValue('', 'numeric')).toThrow(CastValueError);
    expect(() => castValue(Infinity, 'numeric')).toThrow(CastValueError);
    expect(() => castValue('yes', 'boolean')).toThrow(CastValueError);
    expect(() => castValue('not a date', 'timestamp')).toThrow(CastValueError);
    expect(() => castValue({}, 'timestamp')).toThrow(CastValueError);
  });
});

describe('castExpression', () => {
  it('guards the cast so malformed rows become NULL (Req 4.4)', () => {
    const q = render(castExpression(sql`d->>${'price'}`, 'numeric'));
    expect(q.sql).toMatch(/^\(case when \(d->>\$1\) ~ '.+' then \(d->>\$2\)::numeric end\)$/);
    // The key stays a bound parameter; the guard regex is constant SQL.
    expect(q.params).toEqual(['price', 'price']);
  });

  it('leaves text expressions unchanged', () => {
    expect(render(castExpression(sql`d->>${'k'}`, 'text')).sql).toBe('d->>$1');
  });
});

describe('buildJsonPathIndexAdvice', () => {
  it('emits a partial expression index matching the filter expression', () => {
    const a = buildJsonPathIndexAdvice({ collectionId: 'c1', collectionName: 'Products', segments: ['price'], cast: 'numeric' });
    expect(a.indexName).toBe('items_products_price_numeric_idx');
    expect(a.ddl).toContain('ON lumibase_items ((');
    expect(a.ddl).toContain(`data ->> 'price'`);
    expect(a.ddl).toContain(`WHERE collection_id = 'c1' AND deleted_at IS NULL`);
  });

  it('uses #>> for nested paths and keeps names within 63 chars', () => {
    const a = buildJsonPathIndexAdvice({
      collectionId: 'c1',
      collectionName: 'a_very_long_collection_name_that_goes_on',
      segments: ['metadata', 'dimensions', 'weight_in_grams'],
      cast: 'numeric',
    });
    expect(a.ddl).toContain(`data #>> '{metadata,dimensions,weight_in_grams}'::text[]`);
    expect(a.indexName.length).toBeLessThanOrEqual(63);
  });

  it('returns no DDL for timestamp casts (not IMMUTABLE)', () => {
    const a = buildJsonPathIndexAdvice({ collectionId: 'c1', collectionName: 'p', segments: ['at'], cast: 'timestamp' });
    expect(a.ddl).toBeNull();
    expect(a.notes.join(' ')).toMatch(/IMMUTABLE/);
  });
});
