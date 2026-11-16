import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@lumibase/database';
import {
  EARTH_RADIUS_M,
  GEO_MAX_RADIUS_M,
  bboxContains,
  haversineMeters,
  isGeoPoint,
  type GeoBBox,
} from '@lumibase/contracts/field';
import { GeoPointSchema } from '@lumibase/contracts/schemas';
import {
  bboxWindow,
  filterUsesGeo,
  nearWindow,
  parseBBox,
  parseNear,
  resetGeoDialectCache,
  resolveGeoDialect,
  type GeoWindow,
} from '../geo-filter';
import { ItemServiceError, buildFilter, parseFilterQueryParams, type FieldTypeMap } from '../item-service';
import { validateItem } from '../validation';
import { castKindForFieldType } from '../json-filter-cast';
import type { CompiledField } from '../schema-service';

/**
 * geopoint field (#746): value validation, operand parsing, the prefilter
 * window maths and the SQL the filter builder emits for both dialects. The
 * rows each dialect returns are proven equal against real Postgres in
 * `geo-filter.db.integration.test.ts`.
 */

const dialect = new PgDialect();
const render = (q: SQL | undefined) => dialect.sqlToQuery(q!);
const TYPES: FieldTypeMap = new Map([
  ['loc', 'geopoint'],
  ['title', 'string'],
  ['meta', 'json'],
]);

function inWindow(w: GeoWindow, lat: number, lng: number): boolean {
  if (lat < w.lat[0] || lat > w.lat[1]) return false;
  return w.lng.some(([lo, hi]) => lng >= lo && lng <= hi);
}

const lat = fc.double({ min: -90, max: 90, noNaN: true });
const lng = fc.double({ min: -180, max: 180, noNaN: true });

describe('geopoint value validation', () => {
  const field = { name: 'loc', type: 'geopoint', required: false } as unknown as CompiledField;

  it('accepts { lat, lng } in range, including the limits', () => {
    for (const v of [{ lat: 0, lng: 0 }, { lat: 90, lng: 180 }, { lat: -90, lng: -180 }, { lat: 21.03, lng: 105.85 }]) {
      expect(validateItem([field], { loc: v }).ok).toBe(true);
      expect(isGeoPoint(v)).toBe(true);
    }
    expect(validateItem([field], { loc: null }).ok).toBe(true);
  });

  it('rejects out-of-range, non-finite, string, partial and extra-key values', () => {
    const bad: unknown[] = [
      { lat: 90.0001, lng: 0 },
      { lat: 0, lng: -180.5 },
      { lat: Infinity, lng: 0 },
      { lat: Number.NaN, lng: 0 },
      { lat: '10', lng: '20' },
      { lat: 10 },
      { lat: 10, lng: 20, alt: 5 },
      [20, 10],
      'POINT(20 10)',
      { type: 'Point', coordinates: [20, 10] },
    ];
    for (const v of bad) {
      expect(validateItem([field], { loc: v }).ok, JSON.stringify(v)).toBe(false);
      expect(isGeoPoint(v)).toBe(false);
    }
  });

  it('isGeoPoint and GeoPointSchema agree on arbitrary input (property)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.record({ lat: fc.double(), lng: fc.double() }), fc.anything()), (v) => {
        expect(isGeoPoint(v)).toBe(GeoPointSchema.safeParse(v).success);
      }),
    );
  });

  it('is not given a scalar cast (it is an object, like json)', () => {
    expect(castKindForFieldType('geopoint')).toBeNull();
  });
});

describe('operand parsing', () => {
  it('_near accepts numbers and numeric strings (query-string form)', () => {
    expect(parseNear({ lat: 10, lng: 20, radius: 500 })).toEqual({ lat: 10, lng: 20, radius: 500 });
    expect(parseNear({ lat: '10.5', lng: '-20', radius: '1e3' })).toEqual({ lat: 10.5, lng: -20, radius: 1000 });
  });

  it('_near refuses bad operands', () => {
    const bad: unknown[] = [
      null,
      { lat: 10, lng: 20 },
      { lat: 91, lng: 20, radius: 1 },
      { lat: 10, lng: 181, radius: 1 },
      { lat: 10, lng: 20, radius: 0 },
      { lat: 10, lng: 20, radius: -5 },
      { lat: 10, lng: 20, radius: GEO_MAX_RADIUS_M * 1.01 },
      { lat: true, lng: 20, radius: 1 },
      { lat: '', lng: 20, radius: 1 },
      { lat: '10; drop table x', lng: 20, radius: 1 },
      { lat: 10, lng: 20, radius: 1, extra: 1 },
    ];
    for (const v of bad) expect(() => parseNear(v), JSON.stringify(v)).toThrow();
  });

  it('_within_bbox needs 4 in-range numbers with ordered latitudes', () => {
    expect(parseBBox([-10, -5, 10, 5])).toEqual([-10, -5, 10, 5]);
    expect(parseBBox(['170', '-10', '-170', '10'])).toEqual([170, -10, -170, 10]);
    for (const v of [[1, 2, 3], [0, 10, 1, 5], [0, -91, 1, 0], [-181, 0, 0, 1], 'a,b,c,d', { 0: 1 }]) {
      expect(() => parseBBox(v), JSON.stringify(v)).toThrow();
    }
  });
});

describe('prefilter window', () => {
  it('contains every point within the radius (property, incl. poles and antimeridian)', () => {
    fc.assert(
      fc.property(lat, lng, fc.double({ min: 1, max: GEO_MAX_RADIUS_M, noNaN: true }), lat, lng, (clat, clng, radius, plat, plng) => {
        const w = nearWindow({ lat: clat, lng: clng, radius });
        if (haversineMeters({ lat: clat, lng: clng }, { lat: plat, lng: plng }) <= radius) {
          expect(inWindow(w, plat, plng)).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('contains points generated just inside the circle (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -89, max: 89, noNaN: true }),
        lng,
        fc.double({ min: 10, max: 2_000_000, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        (clat, clng, radius, bearing) => {
          // Destination point at 0.999 × radius on the sphere.
          const d = (0.999 * radius) / EARTH_RADIUS_M;
          const φ1 = (clat * Math.PI) / 180;
          const λ1 = (clng * Math.PI) / 180;
          const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(bearing));
          const λ2 = λ1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
          const plat = (φ2 * 180) / Math.PI;
          const plng = ((((λ2 * 180) / Math.PI + 540) % 360) - 180);
          expect(inWindow(nearWindow({ lat: clat, lng: clng, radius }), plat, plng)).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('splits at the antimeridian and opens up at a pole', () => {
    const east = nearWindow({ lat: 0, lng: 179.9, radius: 50_000 });
    expect(east.lng).toHaveLength(2);
    expect(inWindow(east, 0, -179.9)).toBe(true);
    expect(inWindow(east, 0, 0)).toBe(false);
    const pole = nearWindow({ lat: 89.9, lng: 0, radius: 50_000 });
    expect(pole.lng).toEqual([[-180, 180]]);
    expect(pole.lat[1]).toBe(90);
  });

  it('bbox window matches bboxContains, wrapping when minLng > maxLng (property)', () => {
    fc.assert(
      fc.property(lng, lat, lng, lat, lat, lng, (a, b, c, d, plat, plng) => {
        const box: GeoBBox = [a, Math.min(b, d), c, Math.max(b, d)];
        expect(inWindow(bboxWindow(box), plat, plng)).toBe(bboxContains(box, { lat: plat, lng: plng }));
      }),
    );
  });
});

describe('filter SQL', () => {
  it('_near (haversine) reads lat/lng through the guarded numeric cast and binds every value', () => {
    const q = render(buildFilter({ loc: { _near: { lat: 21.0285, lng: 105.8542, radius: 1234.5 } } }, TYPES));
    expect(q.sql).toContain('#>>');
    expect(q.sql).toContain('::numeric');
    expect(q.sql).toMatch(/power\(sin\(radians\(/);
    expect(q.sql).not.toMatch(/st_dwithin/i);
    // No operand is inlined.
    for (const n of ['21.0285', '105.8542', '1234.5']) expect(q.sql).not.toContain(n);
    expect(q.params).toContain('{loc,lat}');
    expect(q.params).toContain('{loc,lng}');
    expect(q.params).toContain('21.0285');
  });

  it('_near (postgis) uses ST_DWithin on geography in the extension schema, on the sphere', () => {
    const q = render(
      buildFilter({ loc: { _near: { lat: 1, lng: 2, radius: 3 } } }, TYPES, { kind: 'postgis', schema: 'extensions' }),
    );
    expect(q.sql).toContain('"extensions".st_dwithin(');
    expect(q.sql).toContain('::"extensions".geography');
    expect(q.sql).toMatch(/, false\)\)$/);
    expect(q.sql).not.toMatch(/power\(sin/);
  });

  it('_within_bbox emits a plain range test (two lng ranges across the antimeridian)', () => {
    const plain = render(buildFilter({ loc: { _within_bbox: [100, 10, 110, 20] } }, TYPES));
    expect(plain.sql.match(/ or /g) ?? []).toHaveLength(0);
    const wrapped = render(buildFilter({ loc: { _within_bbox: [170, -10, -170, 10] } }, TYPES));
    expect(wrapped.sql.match(/ or /g) ?? []).toHaveLength(1);
  });

  it('nests inside _and / _or and accepts nested JSON paths and json fields', () => {
    const q = render(
      buildFilter(
        { _or: [{ loc: { _within_bbox: [0, 0, 1, 1] } }, { 'meta.place': { _near: { lat: 0, lng: 0, radius: 10 } } }] },
        TYPES,
      ),
    );
    expect(q.params).toContain('{meta,place,lat}');
    expect(() => buildFilter({ meta: { _near: { lat: 0, lng: 0, radius: 1 } } }, TYPES)).not.toThrow();
  });

  it('refuses geo operators on structural columns and non-geopoint fields (from the schema, not the data)', () => {
    const cases: unknown[] = [
      { id: { _near: { lat: 0, lng: 0, radius: 1 } } },
      { created_at: { _within_bbox: [0, 0, 1, 1] } },
      { title: { _near: { lat: 0, lng: 0, radius: 1 } } },
    ];
    for (const f of cases) {
      try {
        buildFilter(f as never, TYPES);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ItemServiceError);
        expect((err as ItemServiceError).code).toBe('INVALID_FILTER');
        expect((err as ItemServiceError).status).toBe(400);
      }
    }
  });

  it('turns a bad operand into INVALID_FILTER, never a database error', () => {
    expect(() => buildFilter({ loc: { _near: { lat: 0, lng: 0 } } }, TYPES)).toThrow(/INVALID|expected/);
    expect(() => buildFilter({ loc: { _within_bbox: [0, 5, 1, 1] } }, TYPES)).toThrowError(ItemServiceError);
    expect(() => buildFilter({ "loc'--": { _within_bbox: [0, 0, 1, 1] } }, TYPES)).toThrowError(ItemServiceError);
  });

  it('query-string forms parse into the operands', () => {
    const bbox = parseFilterQueryParams(new URLSearchParams('filter[loc][_within_bbox]=-10,-5,10,5'));
    expect(bbox).toEqual({ loc: { _within_bbox: [-10, -5, 10, 5] } });
    const near = parseFilterQueryParams(
      new URLSearchParams('filter[loc][_near][lat]=21.5&filter[loc][_near][lng]=105&filter[loc][_near][radius]=1000'),
    );
    expect(near).toEqual({ loc: { _near: { lat: 21.5, lng: 105, radius: 1000 } } });
    expect(() => buildFilter(near as never, TYPES)).not.toThrow();
  });

  it('filterUsesGeo finds geo operators anywhere in the tree', () => {
    expect(filterUsesGeo({ title: { _eq: 'x' } })).toBe(false);
    expect(filterUsesGeo({ _and: [{ _or: [{ loc: { _near: {} } }] }] })).toBe(true);
    expect(filterUsesGeo(undefined)).toBe(false);
  });
});

describe('PostGIS detection', () => {
  const fakeDb = (impl: () => Promise<unknown>) => ({ execute: vi.fn(impl) }) as unknown as Database & { execute: ReturnType<typeof vi.fn> };

  it('detects the extension schema once and caches it', async () => {
    resetGeoDialectCache();
    const db = fakeDb(async () => [{ schema: 'public' }]);
    expect(await resolveGeoDialect(db, 1_000)).toEqual({ kind: 'postgis', schema: 'public' });
    expect(await resolveGeoDialect(db, 2_000)).toEqual({ kind: 'postgis', schema: 'public' });
    expect(db.execute).toHaveBeenCalledTimes(1);
    // Re-probed after the TTL.
    await resolveGeoDialect(db, 1_000 + 5 * 60_000 + 1);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('falls back to haversine without the extension or when the probe fails', async () => {
    resetGeoDialectCache();
    expect(await resolveGeoDialect(fakeDb(async () => ({ rows: [] })), 0)).toEqual({ kind: 'haversine' });
    resetGeoDialectCache();
    expect(await resolveGeoDialect(fakeDb(async () => Promise.reject(new Error('down'))), 0)).toEqual({ kind: 'haversine' });
    resetGeoDialectCache();
  });
});
