/**
 * Geo filters for `geopoint` fields (#746): `_near` (radius in metres) and
 * `_within_bbox` (`[minLng, minLat, maxLng, maxLat]`).
 *
 * A geopoint is stored inside `items.data` as `{ "lat": n, "lng": n }`, so
 * every clause reads the two numbers out of JSON through the same guarded
 * numeric cast the typed filters use (#729): a malformed or missing value
 * becomes NULL and the row simply does not match — one bad row never fails
 * the query. Coordinates outside [-90, 90] / [-180, 180] are treated the same
 * way, so no trig or geography cast ever sees them.
 *
 * Two dialects, same rows:
 *
 * - `haversine` (default, plain Postgres — Workers via Hyperdrive and Docker
 *   alike): a lat/lng range prefilter that can use a btree expression index,
 *   then the exact haversine test on the sphere.
 * - `postgis` (when the extension is installed): the same prefilter, then
 *   `ST_DWithin(geography, geography, r, use_spheroid => false)`. On the
 *   sphere PostGIS uses the mean radius {@link EARTH_RADIUS_M}, which is the
 *   radius the haversine path uses, so both dialects agree.
 *
 * All operand values are validated (`GeoNearSchema` / `GeoBBoxSchema`) and
 * bound as parameters; nothing from the request is inlined into SQL. The
 * extension's schema name comes from the catalogue and is emitted as a quoted
 * identifier.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '@lumibase/database';
import { EARTH_RADIUS_M, type GeoBBox, type GeoNear } from '@lumibase/contracts/field';
import { GeoBBoxSchema, GeoNearSchema } from '@lumibase/contracts/schemas';
import { castExpression } from './json-filter-cast';

export const GEO_OPERATORS: ReadonlySet<string> = new Set(['_near', '_within_bbox']);

export type GeoDialect = { kind: 'haversine' } | { kind: 'postgis'; schema: string };

export const HAVERSINE_DIALECT: GeoDialect = { kind: 'haversine' };

export class GeoFilterError extends Error {}

/** Text expressions for the two coordinates of one geopoint reference. */
export interface GeoCoordinateText {
  lat: SQL;
  lng: SQL;
}

// Prefilter bounds are widened by this much (degrees, about 1 cm) so float
// rounding can never drop a row the exact test would keep.
const PAD_DEG = 1e-7;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function parseNear(raw: unknown): GeoNear {
  const parsed = GeoNearSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GeoFilterError(
      'expected { lat, lng, radius } with lat in [-90, 90], lng in [-180, 180] and 0 < radius (metres) <= half the Earth circumference',
    );
  }
  return parsed.data;
}

export function parseBBox(raw: unknown): GeoBBox {
  const parsed = GeoBBoxSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GeoFilterError(
      'expected [minLng, minLat, maxLng, maxLat] with longitudes in [-180, 180], latitudes in [-90, 90] and minLat <= maxLat',
    );
  }
  return parsed.data as GeoBBox;
}

/** A lat/lng window; `lng` is one or two ranges (two when it crosses ±180°). */
export interface GeoWindow {
  lat: [number, number];
  lng: Array<[number, number]>;
}

/**
 * Smallest lat/lng window that contains every point within `radius` metres of
 * the centre (Matuschek's bounding coordinates). Includes a pole → every
 * longitude; crosses the antimeridian → two longitude ranges.
 */
export function nearWindow(near: GeoNear): GeoWindow {
  const angular = near.radius / EARTH_RADIUS_M;
  const dLat = toDeg(angular);
  const minLat = near.lat - dLat - PAD_DEG;
  const maxLat = near.lat + dLat + PAD_DEG;
  if (minLat <= -90 || maxLat >= 90) {
    return { lat: [Math.max(-90, minLat), Math.min(90, maxLat)], lng: [[-180, 180]] };
  }
  const ratio = Math.sin(angular) / Math.cos(toRad(near.lat));
  if (!(ratio < 1)) return { lat: [minLat, maxLat], lng: [[-180, 180]] };
  const dLng = toDeg(Math.asin(ratio)) + PAD_DEG;
  return { lat: [minLat, maxLat], lng: wrapLng(near.lng - dLng, near.lng + dLng) };
}

function wrapLng(min: number, max: number): Array<[number, number]> {
  if (max - min >= 360) return [[-180, 180]];
  if (min < -180) return [[min + 360, 180], [-180, max]];
  if (max > 180) return [[min, 180], [-180, max - 360]];
  return [[min, max]];
}

/** Window of a bbox operand (inclusive; `minLng > maxLng` wraps). */
export function bboxWindow(bbox: GeoBBox): GeoWindow {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return {
    lat: [minLat, maxLat],
    lng: minLng <= maxLng ? [[minLng, maxLng]] : [[minLng, 180], [-180, maxLng]],
  };
}

const num = (n: number): SQL => sql`${String(n)}::numeric`;
const f8 = (n: number): SQL => sql`${String(n)}::float8`;

/**
 * Range test on the guarded numeric coordinates. Written directly on the
 * guarded cast (not on a float8 of it) so an expression index advised for
 * `<field>.lat` / `<field>.lng` with `cast=numeric` matches it.
 */
function windowClause(latN: SQL, lngN: SQL, w: GeoWindow): SQL {
  const lat = sql`${latN} >= ${num(w.lat[0])} and ${latN} <= ${num(w.lat[1])}`;
  if (w.lng.length === 1 && w.lng[0]![0] <= -180 && w.lng[0]![1] >= 180) {
    // Every longitude, but still only valid ones.
    return sql`(${lat} and ${lngN} >= ${num(-180)} and ${lngN} <= ${num(180)})`;
  }
  const lngs = w.lng.map(([lo, hi]) => sql`(${lngN} >= ${num(lo)} and ${lngN} <= ${num(hi)})`);
  return sql`(${lat} and (${sql.join(lngs, sql` or `)}))`;
}

/**
 * Degrees are rounded to 10 decimals (about 11 µm) before any float maths.
 * Postgres raises `value out of range: underflow` when a float8 product or
 * power underflows, so an unrounded stored `lat: 1e-200` (a valid point) would
 * make every `_near` query on the collection fail. After rounding, every
 * non-zero coordinate or difference is >= 1e-10°, and the smallest product the
 * haversine formula can form stays around 1e-60, far from float8's limit.
 */
const COORD_DECIMALS = 10;
const roundCoord = (n: number) => Math.round(n * 10 ** COORD_DECIMALS) / 10 ** COORD_DECIMALS;

/** float8 coordinate (rounded), NULL when the stored value is not a number in range. */
function boundedFloat(n: SQL, limit: number): SQL {
  return sql`(case when ${n} >= ${num(-limit)} and ${n} <= ${num(limit)} then round(${n}, ${sql.raw(String(COORD_DECIMALS))})::float8 end)`;
}

export function compileGeoClause(op: string, raw: unknown, coords: GeoCoordinateText, dialect: GeoDialect): SQL {
  const latN = castExpression(coords.lat, 'numeric');
  const lngN = castExpression(coords.lng, 'numeric');
  if (op === '_within_bbox') {
    return windowClause(latN, lngN, bboxWindow(parseBBox(raw)));
  }
  if (op !== '_near') throw new GeoFilterError(`unknown geo operator ${op}`);
  const parsed = parseNear(raw);
  const near = { lat: roundCoord(parsed.lat), lng: roundCoord(parsed.lng), radius: parsed.radius };
  const prefilter = windowClause(latN, lngN, nearWindow(near));
  const lat = boundedFloat(latN, 90);
  const lng = boundedFloat(lngN, 180);

  if (dialect.kind === 'postgis') {
    const ns = sql.identifier(dialect.schema);
    const point = (x: SQL, y: SQL) =>
      sql`(${ns}.st_setsrid(${ns}.st_makepoint(${x}, ${y}), 4326))::${ns}.geography`;
    return sql`(${prefilter} and ${ns}.st_dwithin(${point(lng, lat)}, ${point(f8(near.lng), f8(near.lat))}, ${f8(near.radius)}, false))`;
  }

  // haversine: d <= r  ⇔  h <= sin²(r / 2R) for r <= πR (asin is monotonic),
  // which avoids asin/sqrt in SQL. h is clamped to [0, 1] like the JS helper.
  const hMax = Math.sin(near.radius / (2 * EARTH_RADIUS_M)) ** 2;
  const haversine = sql`(power(sin(radians(${lat} - ${f8(near.lat)}) / 2), 2) + ${f8(Math.cos(toRad(near.lat)))} * cos(radians(${lat})) * power(sin(radians(${lng} - ${f8(near.lng)}) / 2), 2))`;
  return sql`(${prefilter} and ${haversine} <= ${f8(hMax)})`;
}

// ── PostGIS detection ────────────────────────────────────────────────────────

const DETECT_TTL_MS = 5 * 60_000;
const DETECT_ERROR_TTL_MS = 30_000;
let detected: { at: number; ttl: number; value: Promise<GeoDialect> } | null = null;

/**
 * Whether PostGIS is installed in the current database, and in which schema.
 * Checked once and cached per isolate/process (5 min, so a later
 * `CREATE EXTENSION postgis` is picked up without a restart). A failed probe
 * falls back to the haversine dialect — the SQL-only path is always correct,
 * only slower on very large collections.
 */
export function resolveGeoDialect(db: Database, now = Date.now()): Promise<GeoDialect> {
  if (detected && now - detected.at < detected.ttl) return detected.value;
  const entry = { at: now, ttl: DETECT_TTL_MS, value: Promise.resolve(HAVERSINE_DIALECT) };
  entry.value = probePostgis(db).catch(() => {
    entry.ttl = DETECT_ERROR_TTL_MS;
    return HAVERSINE_DIALECT;
  });
  detected = entry;
  return entry.value;
}

async function probePostgis(db: Database): Promise<GeoDialect> {
  const result = await db.execute<{ schema: string }>(
    sql`select n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'postgis'`,
  );
  const rows =
    (result as unknown as { rows?: Array<{ schema: string }> }).rows ?? (result as unknown as Array<{ schema: string }>);
  const schema = rows[0]?.schema;
  return typeof schema === 'string' && schema.length > 0 ? { kind: 'postgis', schema } : HAVERSINE_DIALECT;
}

/** Test hook: forget the cached probe. */
export function resetGeoDialectCache(): void {
  detected = null;
}

/** Whether a filter tree uses a geo operator anywhere (bounded walk). */
export function filterUsesGeo(filter: unknown, depth = 0): boolean {
  if (depth > 64 || !filter || typeof filter !== 'object') return false;
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (key === '_and' || key === '_or') {
      if (Array.isArray(value) && value.some((f) => filterUsesGeo(f, depth + 1))) return true;
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.keys(value).some((op) => GEO_OPERATORS.has(op))) return true;
    }
  }
  return false;
}
