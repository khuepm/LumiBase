import type { CompiledPermission } from './permission-service';
import { applyFieldMask } from './permission-dsl';

/**
 * Query-field guard (filter sanitisation audit, #738).
 *
 * The read path masks unreadable fields out of the *response*, but a filter,
 * sort or search expression is evaluated by the database against the *stored*
 * row. Without a guard, a caller who cannot read `secret` could still learn it
 * through `?filter[secret][_starts_with]=a` (a boolean oracle on the row
 * count), `?sort=secret` (an ordering oracle) or `?filter[secret][_null]=true`.
 *
 * The guard fails closed, before any query runs: every field a filter or sort
 * names must be readable under the caller's `read` permission. The decision
 * depends only on the permission and the query — never on stored data — so the
 * refusal (same code, same status, no database round-trip) cannot itself be an
 * oracle. A field that does not exist is refused exactly like a hidden one, so
 * the refusal does not reveal the schema either.
 */

/** Error code returned when a query names a field the caller cannot read. */
export const FIELD_FORBIDDEN_CODE = 'FIELD_FORBIDDEN';

/** Deepest `_and` / `_or` nesting the SQL builder compiles (deeper → INVALID_FILTER). */
export const MAX_FILTER_DEPTH = 16;

/** Walk cap for the guard; strictly above {@link MAX_FILTER_DEPTH}. */
const GUARD_WALK_DEPTH = 64;

/**
 * The set of top-level data fields the permission lets the caller read, or
 * `null` when the permission does not restrict fields (`['*']`, or no
 * permission context at all — internal callers). Mirrors
 * `PermissionService.maskItem`, so "can filter on" is exactly "can read".
 */
export function readableFieldSet(
  perm: CompiledPermission | null,
  knownFields: readonly string[],
): ReadonlySet<string> | null {
  if (!perm) return null;
  if (perm.fields.length === 1 && perm.fields[0] === '*') return null;
  return new Set(applyFieldMask([...knownFields], perm.fields));
}

/** Whether `field` (a top-level data field name) is readable under `readable`. */
export function isFieldReadable(readable: ReadonlySet<string> | null, field: string): boolean {
  return readable === null || readable.has(field);
}

/**
 * Every field reference in a filter tree, walked exactly the way the SQL
 * builder walks it: `_and` / `_or` recurse, any other key whose value is an
 * object is a field (possibly a dotted JSON path). Keys the builder ignores
 * (non-object values) are ignored here too, so the guard never refuses a
 * clause that would not have reached SQL — and never misses one that would.
 */
export function collectFilterFields(filter: unknown, out: string[] = [], depth = 0): string[] {
  // The SQL builder refuses nesting deeper than MAX_FILTER_DEPTH (16) with
  // INVALID_FILTER before it emits anything, so every level it could compile is
  // inside this walk. The cap here only bounds recursion on hostile input.
  if (depth > GUARD_WALK_DEPTH) return out;
  if (!filter || typeof filter !== 'object') return out;
  const node = filter as Record<string, unknown>;
  for (const [key, value] of Object.entries(node)) {
    if (key === '_and' || key === '_or') {
      // The builder only recurses into arrays (it reads `.length`); anything
      // else under `_and` / `_or` contributes no clause.
      if (Array.isArray(value)) {
        for (const sub of value) collectFilterFields(sub, out, depth + 1);
      }
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    out.push(key);
  }
  return out;
}

/** The field a sort token names (`-title` → `title`). */
export function sortTokenField(token: string): string {
  return token.replace(/^[-+]/, '');
}

/** Top-level field of a (possibly dotted) reference: `meta.author.id` → `meta`. */
export function topLevelField(reference: string): string {
  const dot = reference.indexOf('.');
  return dot === -1 ? reference : reference.slice(0, dot);
}

/**
 * The first field a filter / sort names that the caller may not read, or
 * `null` when every reference is readable. Structural columns (`id`, `status`,
 * `sort`, timestamps, `user_*`) are never masked by the read path, so they are
 * always allowed.
 */
export function findUnreadableQueryField(input: {
  perm: CompiledPermission | null;
  knownFields: readonly string[];
  structuralFields: ReadonlySet<string>;
  filter?: unknown;
  sort?: readonly string[];
}): string | null {
  const readable = readableFieldSet(input.perm, input.knownFields);
  if (readable === null) return null;
  const refs = [
    ...collectFilterFields(input.filter),
    ...(input.sort ?? []).map(sortTokenField),
  ];
  for (const ref of refs) {
    if (input.structuralFields.has(ref)) continue;
    if (!readable.has(topLevelField(ref))) return ref;
  }
  return null;
}

// ── Search-engine expressions (MeiliSearch filter / sort strings) ──────────

const MEILI_KEYWORDS = new Set([
  'AND',
  'OR',
  'NOT',
  'IN',
  'TO',
  'EXISTS',
  'IS',
  'NULL',
  'EMPTY',
  'CONTAINS',
  'STARTS',
  'WITH',
]);

/**
 * Attribute names referenced by a MeiliSearch filter string, conservatively.
 *
 * Quoted strings are values and are skipped. Every other bare word that is not
 * a keyword, a number or a geo function is treated as an attribute — which
 * means an *unquoted* value (`status = published`) is also treated as an
 * attribute. That is deliberate: the guard has to fail closed on a grammar it
 * does not fully parse, and quoting the value (`status = "published"`) is
 * always valid Meili syntax.
 */
export function meiliFilterAttributes(filter: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < filter.length) {
    const ch = filter[i]!;
    if (ch === '"' || ch === "'") {
      // Skip a quoted value, honouring backslash escapes.
      i += 1;
      while (i < filter.length && filter[i] !== ch) {
        if (filter[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (/[\s()[\],=!<>]/.test(ch)) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < filter.length && !/[\s()[\],=!<>"']/.test(filter[j]!)) j += 1;
    const word = filter.slice(i, j);
    i = j;
    if (MEILI_KEYWORDS.has(word.toUpperCase())) continue;
    if (/^-?\d+(\.\d+)?$/.test(word)) continue;
    if (word.startsWith('_geo')) {
      // Geo functions take numeric arguments only; `_geo` itself is an attribute.
      out.push('_geo');
      continue;
    }
    out.push(word);
  }
  return out;
}

/** Attribute named by a Meili sort token (`price:asc` → `price`). */
export function meiliSortAttribute(token: string): string {
  const colon = token.lastIndexOf(':');
  return (colon === -1 ? token : token.slice(0, colon)).trim();
}
