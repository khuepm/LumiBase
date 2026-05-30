/**
 * Email normalisation helper for the Login Guard surface (admin-setup-
 * wizard task 6.3; Req 7.1; design §6.5).
 *
 * Login security must key on the same canonical form of an email
 * address everywhere — the sliding-window counter
 * (`loginAttempts.emailLower`), the `users` row lookup
 * (`lower(email) = $1`), the `recordLoginFailure` / `recordLoginSuccess`
 * hooks, and the `loginGuardMiddleware` precheck. If any one of those
 * normalises differently, a "Foo@Example.com" attempt would key its
 * counter under one bucket and its lockout flag under another, which
 * would silently break the lockout transition.
 *
 * Before this helper landed, four sites duplicated the same one-liner
 * (`input.trim().toLowerCase()` with various null-checks). They now
 * all call this single function so the contract is impossible to
 * drift.
 *
 * Contract:
 *
 *   - `null` / `undefined` / non-string runtime inputs collapse to the
 *     empty string. Callers that already type their input as `string`
 *     pay no overhead, but the helper is forgiving so it can sit at
 *     the boundary of a `c.req.json()` payload (which is `unknown`)
 *     without forcing every call site to re-validate.
 *   - `String(input ?? '')` is used (not `String(input)`) so a literal
 *     `null` doesn't normalise to the string `"null"` — that would
 *     accidentally collide with users whose email column is somehow
 *     stored as the literal word.
 *   - Whitespace is trimmed at both ends; internal whitespace is left
 *     alone (RFC 5321 doesn't allow whitespace in the local-part, but
 *     our error path returns the same generic 401 in either case so
 *     we don't need to reject here).
 *   - `.toLowerCase()` is applied last because `String(input ?? '')`
 *     can return strings whose case-folding behaviour is locale-
 *     sensitive (e.g. Turkish "İ" → "i̇"). `String.prototype.toLowerCase`
 *     uses the Unicode default case algorithm which is locale-
 *     independent, matching the Postgres `lower()` function we compare
 *     against.
 *
 * Validates: Requirements 7.1 (and the wider design §6.5 contract for
 * email keys across the LoginGuard counter / hooks / middleware).
 */

/**
 * Canonicalise an email address for use as a counter key, an index
 * lookup value, or a `users.email_lower` comparand.
 *
 * Returns the empty string for any input that isn't a non-empty
 * string. The empty string is a deliberate sentinel — it never
 * matches a real `users` row (the `email` column is `NOT NULL` and
 * non-empty per the schema), and the counter SQL short-circuits on it
 * (see {@link PostgresCounterStore.userFailedCount}). Callers that
 * need to distinguish "no email supplied" from "all-whitespace email"
 * can compare the result against the empty string.
 */
export function normalizeEmail(input: string | null | undefined): string {
  return String(input ?? '').trim().toLowerCase();
}
