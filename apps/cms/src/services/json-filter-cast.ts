/**
 * Type-aware Cast_Rule for item filters and sorts (json-field-search Req 4,
 * issue #729). Item values live in `items.data` (JSONB), so `data->>'price'`
 * is TEXT and a plain `>` compares lexicographically (`'10' > '9'` is false).
 *
 * The rule picks a cast kind per comparison and wraps the text expression in a
 * **guarded** cast: a value that does not look like the target type becomes
 * NULL instead of raising `invalid input syntax`, so one malformed row never
 * fails the whole query (Req 4.4).
 *
 * The guard expressions are deterministic constant SQL (no user input), which
 * lets `buildJsonPathIndexAdvice` emit an expression index whose text matches
 * the filter expression exactly — Postgres can then use it for range filters.
 */
import { sql, type SQL } from 'drizzle-orm';

export type CastKind = 'numeric' | 'boolean' | 'timestamp' | 'text';

/** Comparison operators that honour the Cast_Rule. String ops stay text. */
export const CASTABLE_OPS: ReadonlySet<string> = new Set([
  '_eq',
  '_neq',
  '_in',
  '_nin',
  '_gt',
  '_gte',
  '_lt',
  '_lte',
]);

const NUMERIC_TYPES = new Set(['integer', 'biginteger', 'decimal', 'float', 'double', 'number', 'numeric']);
const BOOLEAN_TYPES = new Set(['boolean']);
/**
 * Pseudo type the item service puts in its field-type map for a `datetime` /
 * `timestamp` field with `options.timezone` (#747). Its value is an object
 * (`{ instant, tz, offset }`), so filters and sort read `instant`.
 */
export const ZONED_DATETIME_FILTER_TYPE = 'datetime_tz';

const TIMESTAMP_TYPES = new Set(['date', 'datetime', 'timestamp', ZONED_DATETIME_FILTER_TYPE]);

/**
 * Map a schema field type to a cast kind. Unknown / string-like types return
 * `null` so the caller can fall back to value inference or text (Req 4.5).
 * `json` / `alias` are containers, not scalars, so they also return `null`.
 */
export function castKindForFieldType(type: string | null | undefined): CastKind | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (NUMERIC_TYPES.has(t)) return 'numeric';
  if (BOOLEAN_TYPES.has(t)) return 'boolean';
  if (TIMESTAMP_TYPES.has(t)) return 'timestamp';
  if (t === 'json' || t === 'alias' || t === 'blocks') return null;
  // `{ lat, lng }` object (#746): compare via `_near` / `_within_bbox`, or a
  // nested path (`loc.lat`) which infers numeric from the value.
  if (t === 'geopoint') return null;
  return 'text';
}

/**
 * Infer a cast kind from the filter value when the schema cannot say (nested
 * JSON paths, `json` fields, unknown fields). Only unambiguous JSON scalars are
 * promoted: a JS number → numeric, a JS boolean → boolean. Strings stay text so
 * existing string filters (`{ sku: { _eq: '0042' } }`) keep their meaning.
 */
export function inferCastKindFromValue(raw: unknown): CastKind {
  const sample = Array.isArray(raw) ? raw[0] : raw;
  if (typeof sample === 'number' && Number.isFinite(sample)) return 'numeric';
  if (typeof sample === 'boolean') return 'boolean';
  return 'text';
}

// ── Guarded casts ────────────────────────────────────────────────────────────
//
// A guard must be exactly as strict as the cast it protects: a value that
// passes the guard but makes `::numeric` / `::timestamptz` throw fails the
// whole list query (Req 4.4). Shape-only regexes are not enough
// (`2026-99-99`, `1e999999`). The checks below run in pure SQL so they work on
// PostgreSQL 15 (no `pg_input_is_valid`), need no migration, and stay
// IMMUTABLE for numeric so the advised expression index still matches.
//
// Each guard is one template with `$T` standing for the text expression; the
// filter SQL (bound key) and the index DDL (literal key) are both rendered from
// it, so they cannot drift apart. `CASE` is used for every dependent check
// because PostgreSQL does not guarantee left-to-right evaluation of `AND`:
// a substring cast must never run on text the regex has not validated.
// standard_conforming_strings is on, so backslashes in literals are literal.

/**
 * numeric: optional sign, digits with optional fraction, optional exponent of
 * at most 3 digits, whole text at most 1000 chars. Worst case is about 2000
 * digits of weight or scale, far inside numeric's limits (131072 / 16383).
 */
const NUMERIC_GUARD =
  `(case when length($T) <= 1000 and ($T) ~ '^\\s*[-+]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][-+]?[0-9]{1,3})?\\s*$' ` +
  `then ($T)::numeric end)`;

/**
 * timestamp: ISO-8601 date with optional time and UTC offset. The regex bounds
 * every field (month 01-12, day 01-31, hour 00-23, minute 00-59, second
 * 00-60 — PostgreSQL accepts a leap second — and offset up to 15:59). Hour 24
 * is allowed only as exactly `24:00`, `24:00:00` or `24:00:00.000…`: the
 * end-of-day midnight PostgreSQL also casts (to 00:00 of the next day). The
 * nested CASE then rejects year 0000 and days past the end of the month
 * (leap years included) before the cast runs.
 */
const TIMESTAMP_SHAPE =
  `'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])` +
  `([T ](([01][0-9]|2[0-3]):[0-5][0-9](:([0-5][0-9]|60)(\\.[0-9]{1,9})?)?|24:00(:00(\\.0{1,9})?)?)` +
  `(Z|[+-](0[0-9]|1[0-5])(:?[0-5][0-9])?)?)?$'`;
const DAYS_IN_MONTH =
  `(case substr($T, 6, 2)::int when 2 then ` +
  `(case when (substr($T, 1, 4)::int % 4 = 0 and substr($T, 1, 4)::int % 100 <> 0) ` +
  `or substr($T, 1, 4)::int % 400 = 0 then 29 else 28 end) ` +
  `when 4 then 30 when 6 then 30 when 9 then 30 when 11 then 30 else 31 end)`;
const TIMESTAMP_GUARD =
  `(case when ($T) ~ ${TIMESTAMP_SHAPE} then ` +
  `(case when substr($T, 1, 4) <> '0000' and substr($T, 9, 2)::int <= ${DAYS_IN_MONTH} ` +
  `then ($T)::timestamptz end) end)`;

const BOOLEAN_GUARD = `(case lower($T) when 'true' then true when 'false' then false end)`;

function guardTemplate(kind: CastKind): string | null {
  switch (kind) {
    case 'numeric':
      return NUMERIC_GUARD;
    case 'boolean':
      return BOOLEAN_GUARD;
    case 'timestamp':
      return TIMESTAMP_GUARD;
    default:
      return null;
  }
}

/**
 * Wrap a TEXT expression in the guarded cast for `kind`. Returns the input
 * unchanged for `text`. Every `$T` becomes the (parameter-bound) expression.
 */
export function castExpression(textExpr: SQL, kind: CastKind): SQL {
  const template = guardTemplate(kind);
  if (!template) return textExpr;
  const parts = template.split('$T');
  const chunks: SQL[] = [];
  parts.forEach((part, i) => {
    if (part) chunks.push(sql.raw(part));
    if (i < parts.length - 1) chunks.push(textExpr);
  });
  return sql.join(chunks, sql.raw(''));
}

/** Raw SQL text of the guarded cast over a literal text expression (for DDL). */
export function castExpressionText(textExpr: string, kind: CastKind): string {
  const template = guardTemplate(kind);
  return template ? template.split('$T').join(textExpr) : textExpr;
}

export class CastValueError extends Error {}

/**
 * Coerce one filter value to a bound, explicitly-typed SQL parameter. Throws
 * `CastValueError` when the value cannot be represented in `kind` — the caller
 * maps that to INVALID_FILTER (a 400, never a database error).
 */
export function castValue(raw: unknown, kind: CastKind): SQL {
  switch (kind) {
    case 'numeric': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) throw new CastValueError(`expected a number, got ${JSON.stringify(raw)}`);
      return sql`${String(n)}::numeric`;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return sql`${raw ? 'true' : 'false'}::boolean`;
      if (raw === 'true' || raw === 'false') return sql`${raw}::boolean`;
      throw new CastValueError(`expected a boolean, got ${JSON.stringify(raw)}`);
    }
    case 'timestamp': {
      // A number is read as its string form, not epoch ms: Studio's filter
      // builder sends `2026` for a date field typed as "2026" (a year).
      const d = typeof raw === 'string' || typeof raw === 'number' ? new Date(String(raw)) : null;
      if (!d || Number.isNaN(d.getTime())) {
        throw new CastValueError(`expected an ISO-8601 date, got ${JSON.stringify(raw)}`);
      }
      return sql`${d.toISOString()}::timestamptz`;
    }
    default:
      return sql`${raw}`;
  }
}

/** Expression index advice for a JSON path filter (issue #729). */
export interface JsonPathIndexAdvice {
  path: string;
  cast: CastKind;
  indexName: string;
  /** The SQL expression the filter builder emits for this path + cast. */
  expression: string;
  /**
   * Ready-to-run DDL (`CONCURRENTLY`, so it does not block writes), or `null`
   * when Postgres cannot index the cast (timestamptz casts are not IMMUTABLE).
   */
  ddl: string | null;
  notes: string[];
}

/** Postgres truncates identifiers longer than this many bytes (NAMEDATALEN - 1). */
const PG_MAX_IDENTIFIER = 63;

/**
 * FNV-1a 64-bit over the UTF-8 bytes of `input`, as 12 hex chars (48 bits).
 * Synchronous and runtime-neutral (no `node:crypto`, no WebCrypto promise), so
 * the same name comes out on Workers and Docker. Not a security hash: it only
 * has to keep index names apart.
 */
function shortHash(input: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0').slice(0, 12);
}

/**
 * Index name for a JSON path expression index (issue #858). Index names are
 * global per schema while collection names are only unique per site, and the
 * path `a_b` and `a.b` read the same once joined, so the name carries a hash of
 * what makes the index unique: the collection id, the exact path and the cast.
 * The readable part (`<collection>_<path>`) is only a hint and is cut so the
 * whole name fits in 63 bytes without losing the hash.
 */
export function jsonPathIndexName(
  collectionId: string,
  collectionName: string,
  segments: string[],
  cast: CastKind,
): string {
  const hash = shortHash(`${collectionId}\u0000${segments.join('.')}\u0000${cast}`);
  const prefix = 'items_';
  const suffix = `_${cast}_${hash}_idx`;
  const readable = `${collectionName}_${segments.join('_')}`.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
  const room = PG_MAX_IDENTIFIER - prefix.length - suffix.length;
  return `${prefix}${readable.slice(0, room)}${suffix}`;
}

/**
 * Build `CREATE INDEX` DDL whose expression matches what `ItemService` emits
 * for `path` filtered with `cast`, partial on the collection so the index stays
 * small on the shared `items` table. Segments must already be validated
 * (`resolveFieldPath`): they only contain `[A-Za-z0-9_]`, so quoting them as
 * SQL literals here is safe.
 */
export function buildJsonPathIndexAdvice(input: {
  collectionId: string;
  collectionName: string;
  segments: string[];
  cast: CastKind;
}): JsonPathIndexAdvice {
  const { collectionId, collectionName, segments, cast } = input;
  const textExpr =
    segments.length === 1 ? `data ->> '${segments[0]}'` : `data #>> '{${segments.join(',')}}'::text[]`;
  const expression = castExpressionText(textExpr, cast);
  const indexName = jsonPathIndexName(collectionId, collectionName, segments, cast);
  const literalCollId = collectionId.replace(/'/g, "''");
  const notes = [
    'Run outside a transaction (CONCURRENTLY).',
    'The index serves _eq/_neq/_in/_gt/_gte/_lt/_lte on this path with the same cast; string operators (_contains, _starts_with) do not use it.',
  ];
  let ddl: string | null =
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON lumibase_items ((${expression})) ` +
    `WHERE collection_id = '${literalCollId}' AND deleted_at IS NULL;`;
  if (cast === 'timestamp') {
    ddl = null;
    notes.push(
      'timestamptz casts are STABLE, not IMMUTABLE, so Postgres refuses an expression index on them. ISO-8601 UTC strings sort correctly as text: a plain btree on the text path is the fallback.',
    );
  }
  return { path: segments.join('.'), cast, indexName, expression, ddl, notes };
}
