import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { and, eq, sql } from 'drizzle-orm';
import { collections, fields, items, sites, type Database } from '@lumibase/database';
import { bboxContains, haversineMeters, type GeoBBox, type GeoPoint } from '@lumibase/contracts/field';
import { ItemService, buildFilter, type FieldTypeMap } from '../item-service';
import { resetGeoDialectCache, resolveGeoDialect, type GeoDialect } from '../geo-filter';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * geopoint radius / bbox queries against real Postgres (#746).
 *
 * The haversine dialect runs on any Postgres; the result of every query is
 * checked against the JS oracle (`haversineMeters` / `bboxContains`), so the
 * SQL and the shared helper cannot drift. When the database also has PostGIS,
 * the same queries run through `ST_DWithin` and must return the same rows.
 */

const SITE = 'site_geopoint_it';
const OTHER_SITE = 'site_geopoint_it_other';
const COLLECTION = 'places';
const TYPES: FieldTypeMap = new Map([['loc', 'geopoint'], ['title', 'string']]);

const PLACES: Array<[string, GeoPoint]> = [
  ['hanoi', { lat: 21.0285, lng: 105.8542 }],
  ['hoan_kiem', { lat: 21.0288, lng: 105.8525 }], // ~180 m from hanoi
  ['haiphong', { lat: 20.8449, lng: 106.6881 }], // ~90 km
  ['saigon', { lat: 10.8231, lng: 106.6297 }],
  ['fiji_east', { lat: -17.0, lng: 179.95 }],
  ['fiji_west', { lat: -17.0, lng: -179.95 }], // ~10.6 km across the antimeridian
  ['north_pole', { lat: 90, lng: 0 }],
  ['near_pole_a', { lat: 89.95, lng: 45 }],
  ['near_pole_b', { lat: 89.95, lng: -135 }], // other side of the pole, ~11 km from a
  ['south_pole', { lat: -90, lng: 123 }],
  ['null_island', { lat: 0, lng: 0 }],
  ['dateline_180', { lat: 0, lng: 180 }],
  ['dateline_m180', { lat: 0, lng: -180 }], // same place as dateline_180
];

describe.skipIf(!hasDbIntegrationUrl)('geopoint filters — DB integration', () => {
  let db: Database;
  let svc: ItemService;
  let collId: string;
  let postgis: GeoDialect;

  const wipe = async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(sites).where(eq(sites.id, OTHER_SITE));
  };

  beforeAll(async () => {
    db = await connectDbIntegration('geo-filter');
    resetGeoDialectCache();
    postgis = await resolveGeoDialect(db);
  });

  afterAll(async () => {
    if (!db) return;
    await wipe().catch(() => undefined);
    resetGeoDialectCache();
  });

  beforeEach(async () => {
    await wipe();
    for (const id of [SITE, OTHER_SITE]) {
      await db.insert(sites).values({
        organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
        id,
        name: `Geo IT ${id}`,
      });
    }
    collId = (
      await db.insert(collections).values({ siteId: SITE, name: COLLECTION, label: 'Places' }).returning({ id: collections.id })
    )[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: collId, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: collId, name: 'loc', type: 'geopoint', interface: 'geopoint' },
    ]);
    svc = new ItemService({ db, siteId: SITE });
    for (const [title, loc] of PLACES) await svc.create(COLLECTION, { data: { title, loc } });
  });

  async function titles(filter: unknown): Promise<string[]> {
    const res = (await svc.list(COLLECTION, { filter: filter as never, limit: 200 })) as unknown as {
      data: Array<{ data: { title: string } }>;
    };
    return res.data.map((r) => r.data.title).sort();
  }

  /** Run one filter with an explicit dialect, bypassing detection. */
  async function titlesWith(filter: unknown, geo: GeoDialect): Promise<string[]> {
    const rows = await db
      .select({ data: items.data })
      .from(items)
      .where(and(eq(items.siteId, SITE), eq(items.collectionId, collId), buildFilter(filter as never, TYPES, geo)));
    return rows.map((r) => (r.data as { title: string }).title).sort();
  }

  const oracleNear = (c: GeoPoint, r: number) =>
    PLACES.filter(([, p]) => haversineMeters(c, p) <= r).map(([t]) => t).sort();
  const oracleBox = (b: GeoBBox) => PLACES.filter(([, p]) => bboxContains(b, p)).map(([t]) => t).sort();

  it('rejects an invalid geopoint on write', async () => {
    await expect(svc.create(COLLECTION, { data: { title: 'bad', loc: { lat: 91, lng: 0 } } })).rejects.toThrow();
    await expect(svc.create(COLLECTION, { data: { title: 'bad', loc: { lat: 1, lng: 2, x: 3 } } })).rejects.toThrow();
  });

  it('finds items within a radius', async () => {
    expect(await titles({ loc: { _near: { lat: 21.0285, lng: 105.8542, radius: 500 } } })).toEqual(['hanoi', 'hoan_kiem']);
    expect(await titles({ loc: { _near: { lat: 21.0285, lng: 105.8542, radius: 100_000 } } })).toEqual([
      'haiphong',
      'hanoi',
      'hoan_kiem',
    ]);
    expect(await titles({ loc: { _near: { lat: 21.0285, lng: 105.8542, radius: 10 } } })).toEqual(['hanoi']);
  });

  it('crosses the antimeridian for radius and bbox', async () => {
    expect(await titles({ loc: { _near: { lat: -17, lng: 179.95, radius: 15_000 } } })).toEqual(['fiji_east', 'fiji_west']);
    expect(await titles({ loc: { _within_bbox: [179.9, -17.1, -179.9, -16.9] } })).toEqual(['fiji_east', 'fiji_west']);
    // ±180 are the same meridian.
    expect(await titles({ loc: { _near: { lat: 0, lng: -180, radius: 1 } } })).toEqual(['dateline_180', 'dateline_m180']);
  });

  it('includes every longitude around a pole', async () => {
    expect(await titles({ loc: { _near: { lat: 90, lng: 0, radius: 12_000 } } })).toEqual([
      'near_pole_a',
      'near_pole_b',
      'north_pole',
    ]);
    expect(await titles({ loc: { _near: { lat: 89.95, lng: 45, radius: 12_000 } } })).toEqual([
      'near_pole_a',
      'near_pole_b',
      'north_pole',
    ]);
    expect(await titles({ loc: { _near: { lat: -89.999, lng: -57, radius: 1_000 } } })).toEqual(['south_pole']);
    expect(await titles({ loc: { _within_bbox: [-180, 89.9, 180, 90] } })).toEqual(['near_pole_a', 'near_pole_b', 'north_pole']);
  });

  it('half the circumference matches everything', async () => {
    // Centre chosen so no fixture sits exactly on the antipode (a float tie).
    expect(await titles({ loc: { _near: { lat: 1, lng: 1, radius: Math.PI * 6371008.7714 } } })).toEqual(
      PLACES.map(([t]) => t).sort(),
    );
  });

  it('combines with other filters and stays inside the site', async () => {
    const other = new ItemService({ db, siteId: OTHER_SITE });
    const otherColl = (
      await db.insert(collections).values({ siteId: OTHER_SITE, name: COLLECTION, label: 'Places' }).returning({ id: collections.id })
    )[0]!.id;
    await db.insert(fields).values({ siteId: OTHER_SITE, collectionId: otherColl, name: 'loc', type: 'geopoint', interface: 'geopoint' });
    await other.create(COLLECTION, { data: { title: 'intruder', loc: { lat: 21.0285, lng: 105.8542 } } });
    expect(
      await titles({ _and: [{ loc: { _near: { lat: 21.0285, lng: 105.8542, radius: 500 } } }, { title: { _neq: 'hanoi' } }] }),
    ).toEqual(['hoan_kiem']);
  });

  it('skips malformed legacy values instead of failing the query', async () => {
    await db.insert(items).values(
      [
        { lat: 'n/a', lng: 1 },
        { lat: 1000, lng: 0 },
        { lat: 0, lng: 1e300 },
        '21.0285,105.8542',
        { lat: '21.0285', lng: '105.8542' }, // numeric strings still read as numbers
        null,
      ].map((loc, i) => ({ siteId: SITE, collectionId: collId, status: 'draft', data: { title: `legacy_${i}`, loc } })),
    );
    expect(await titles({ loc: { _near: { lat: 21.0285, lng: 105.8542, radius: 500 } } })).toEqual([
      'hanoi',
      'hoan_kiem',
      'legacy_4',
    ]);
    expect(await titles({ loc: { _within_bbox: [-180, -90, 180, 90] } })).toContain('legacy_4');
    expect(await titles({ loc: { _within_bbox: [-180, -90, 180, 90] } })).not.toContain('legacy_1');
  });

  it('tiny coordinates never raise a float underflow (one valid row must not break every query)', async () => {
    await svc.create(COLLECTION, { data: { title: 'tiny', loc: { lat: 1e-200, lng: -1e-300 } } });
    for (const geo of [{ kind: 'haversine' } as const, postgis]) {
      expect(await titlesWith({ loc: { _near: { lat: 5e-324, lng: 0, radius: 10 } } }, geo)).toEqual(['null_island', 'tiny']);
      expect(await titlesWith({ loc: { _near: { lat: 1e-200, lng: 1e-200, radius: 1e-300 } } }, geo)).toEqual(['null_island', 'tiny']);
    }
  });

  it('matches the JS oracle for random radius and bbox queries (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: -90, max: 90, noNaN: true }),
        fc.double({ min: -180, max: 180, noNaN: true }),
        fc.double({ min: 100, max: 3_000_000, noNaN: true }),
        async (lat, lng, radius) => {
          // Skip centres whose distance to a fixture is within float noise of the radius.
          const c = { lat, lng };
          if (PLACES.some(([, p]) => Math.abs(haversineMeters(c, p) - radius) < 0.01)) return;
          expect(await titlesWith({ loc: { _near: { lat, lng, radius } } }, { kind: 'haversine' })).toEqual(oracleNear(c, radius));
        },
      ),
      { numRuns: 60 },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: -180, max: 180, noNaN: true }),
        fc.double({ min: -90, max: 90, noNaN: true }),
        fc.double({ min: -180, max: 180, noNaN: true }),
        fc.double({ min: -90, max: 90, noNaN: true }),
        async (a, b, c, d) => {
          const box: GeoBBox = [a, Math.min(b, d), c, Math.max(b, d)];
          expect(await titlesWith({ loc: { _within_bbox: box } }, { kind: 'haversine' })).toEqual(oracleBox(box));
        },
      ),
      { numRuns: 60 },
    );
  });

  it('PostGIS ST_DWithin returns the same rows as the haversine path (when installed)', async (ctx) => {
    if (postgis.kind !== 'postgis') ctx.skip();
    const centres: Array<[GeoPoint, number]> = [
      [{ lat: 21.0285, lng: 105.8542 }, 500],
      [{ lat: 21.0285, lng: 105.8542 }, 100_000],
      [{ lat: -17, lng: 179.95 }, 15_000],
      [{ lat: 90, lng: 0 }, 12_000],
      [{ lat: 0, lng: -180 }, 1],
      [{ lat: 10, lng: 100 }, 2_000_000],
    ];
    for (const [c, r] of centres) {
      const filter = { loc: { _near: { ...c, radius: r } } };
      expect(await titlesWith(filter, postgis)).toEqual(await titlesWith(filter, { kind: 'haversine' }));
    }
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: -90, max: 90, noNaN: true }),
        fc.double({ min: -180, max: 180, noNaN: true }),
        fc.double({ min: 100, max: 19_000_000, noNaN: true }),
        async (lat, lng, radius) => {
          const c = { lat, lng };
          // A fixture within a millimetre of the radius is a float tie, not a disagreement.
          if (PLACES.some(([, p]) => Math.abs(haversineMeters(c, p) - radius) < 0.001)) return;
          const filter = { loc: { _near: { lat, lng, radius } } };
          const viaPostgis = await titlesWith(filter, postgis);
          expect(viaPostgis).toEqual(await titlesWith(filter, { kind: 'haversine' }));
          expect(viaPostgis).toEqual(oracleNear(c, radius));
        },
      ),
      { numRuns: 100 },
    );
  });
});
