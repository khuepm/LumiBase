/**
 * LIKE / ILIKE pattern helpers (filter sanitisation audit, #738).
 *
 * `_contains`, `_starts_with` and `_ends_with` promise substring / prefix /
 * suffix semantics, so the caller's value must be matched literally. Without
 * escaping, a value of `%` matches every row and `_` matches any single
 * character — a caller could widen a permission rule (e.g. a user whose e-mail
 * contains `%` against `{ email: { _ends_with: '$CURRENT_USER.email' } }`) or
 * probe a value one wildcard at a time.
 *
 * Postgres' default LIKE escape character is the backslash, and with
 * `standard_conforming_strings = on` (the default since 9.1) a bound parameter
 * carries backslashes verbatim, so escaping `\`, `%` and `_` with a leading
 * backslash is enough; no `ESCAPE` clause is needed.
 */

/** Escape `\`, `%` and `_` so the value matches itself literally inside a LIKE pattern. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** `%value%` — literal substring match. */
export function containsPattern(value: unknown): string {
  return `%${escapeLikePattern(String(value))}%`;
}

/** `value%` — literal prefix match. */
export function startsWithPattern(value: unknown): string {
  return `${escapeLikePattern(String(value))}%`;
}

/** `%value` — literal suffix match. */
export function endsWithPattern(value: unknown): string {
  return `%${escapeLikePattern(String(value))}`;
}
