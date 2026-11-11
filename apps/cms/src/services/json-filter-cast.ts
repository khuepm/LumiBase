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
const TIMESTAMP_TYPES = new Set(['date', 'datetime', 'timestamp']);

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
  if (t === 'json' || t === 'alias') return null;
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

// Guard patterns. Kept as SQL string literals (standard_conforming_strings is
// on, so backslashes are literal). Constants only — never interpolate input.
const NUMERIC_RE = `'^\\s*[-+]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][-+]?[0-9]+)?\\s*$'`;
const TIMESTAMP_RE =
  `'^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$'`;

/**
 * Wrap a TEXT expression in the guarded cast for `kind`. Returns the input
 * unchanged for `text`.
 */
export function castExpression(textExpr: SQL, kind: CastKind): SQL {
  switch (kind) {
    case 'numeric':
      return sql`(case when (${textExpr}) ~ ${sql.raw(NUMERIC_RE)} then (${textExpr})::numeric end)`;
    case 'boolean':
      return sql`(case lower(${textExpr}) when 'true' then true when 'false' then false end)`;
    case 'timestamp':
      return sql`(case when (${textExpr}) ~ ${sql.raw(TIMESTAMP_RE)} then (${textExpr})::timestamptz end)`;
    default:
      return textExpr;
  }
}

/** Raw SQL text of the guarded cast over a literal text expression (for DDL). */
export function castExpressionText(textExpr: string, kind: CastKind): string {
  switch (kind) {
    case 'numeric':
      return `(case when (${textExpr}) ~ ${NUMERIC_RE} then (${textExpr})::numeric end)`;
    case 'boolean':
      return `(case lower(${textExpr}) when 'true' then true when 'false' then false end)`;
    case 'timestamp':
      return `(case when (${textExpr}) ~ ${TIMESTAMP_RE} then (${textExpr})::timestamptz end)`;
    default:
      return textExpr;
  }
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
  const safeColl = collectionName.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
  const indexName = `items_${safeColl}_${segments.join('_')}_${cast}_idx`.slice(0, 63);
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
