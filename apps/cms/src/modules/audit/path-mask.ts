/**
 * Audit-log helper: mask the configured Admin_Path out of log strings
 * and structured metadata.
 *
 * Implements Req 5.5 ("THE Admin_Path_Guard SHALL không ghi log chi
 * tiết Admin_Path thực tế ở mức log mặc định (chỉ log hash hoặc
 * placeholder `<admin_path>`); WHERE log level là `debug`, raw path
 * SHALL được ghi") on top of the audit-logging design pinned in
 * design.md §10.1. The Admin_Path is treated as a secret throughout
 * the system (design §7.3 — never embedded in the Studio bundle,
 * never returned by an unauthenticated endpoint), and any log line
 * accidentally echoing the raw path would let an attacker who has
 * read access to operator logs (CI artefacts, log aggregators,
 * support tickets, …) recover the secret without ever touching the
 * running instance.
 *
 * The helper is intentionally narrow:
 *
 *   1. {@link getLogLevel} reads the runtime log level — `process.env.LOG_LEVEL`
 *      on Node, `undefined` on the Cloudflare Workers runtime where
 *      `process.env` is not available. We default to `'info'` so the
 *      conservative behaviour (mask) wins whenever the level is unset
 *      or unrecognised.
 *
 *   2. {@link shouldRetainRawAdminPath} centralises the level → bool
 *      decision. The contract from Req 5.5 is binary ("info/warn/error
 *      → mask, debug → raw"). All other levels (`trace`, custom labels)
 *      are conservatively masked. Centralising this also means a future
 *      change to the policy (e.g. masking at debug too in a hardened
 *      build) only touches one function.
 *
 *   3. {@link maskAdminPathInString} does the actual substring →
 *      placeholder replacement, with the admin path matched
 *      case-insensitively. The validator normalises stored paths to
 *      lowercase, but URL routers and reverse proxies (and the user's
 *      browser address bar) frequently preserve casing on the wire, so
 *      a mixed-case copy of the path can show up in `c.req.path`,
 *      Hono's URL parser, or third-party middleware. Treating the
 *      match as case-insensitive closes that gap without changing the
 *      placeholder we emit.
 *
 *   4. {@link maskAdminPath} is the top-level entry point used by the
 *      audit logger and any structured-log helper. It dispatches by
 *      input shape (string vs object vs array vs primitive), respects
 *      the runtime log level, and short-circuits when no admin path is
 *      available (`null` / empty) so callers can hand it the value
 *      directly without `?.` plumbing.
 *
 * Non-goals:
 *
 *   - This module does NOT format log lines. The structured logger
 *     ({@link ../middleware/logger.ts}) and the audit logger compose
 *     this helper as a transformer over their existing outputs.
 *
 *   - It does NOT mask other secrets (passwords, tokens, backup codes).
 *     Those are out-of-scope of Req 5.5; the broader masking helper
 *     `maskSensitive` belongs to the audit logger (task 11.1, design
 *     §10.1).
 *
 *   - It does NOT walk class instances, Maps, Sets, Errors, or other
 *     non-plain objects. Audit metadata in Lumibase is always plain
 *     JSON-shaped data (Req 15.2) — log lines that flow through this
 *     helper are likewise JSON-serialisable. Adding generic walking
 *     would force us to materialise/clone objects we don't own,
 *     surfacing more bugs than it prevents.
 *
 * **Validates: Requirements 5.5**
 *
 * References: requirements §5.5; design.md §7.3, §10.1.
 */

/**
 * The literal placeholder Req 5.5 mandates. Exported so tests and
 * downstream loggers can assert against the same constant.
 */
export const ADMIN_PATH_PLACEHOLDER = '<admin_path>';

/**
 * Default log level applied when `process.env.LOG_LEVEL` is unset or
 * unavailable. `'info'` is the conservative choice — it routes through
 * the masking branch.
 */
const DEFAULT_LOG_LEVEL = 'info';

/**
 * Optional override accepted by {@link maskAdminPath}. Most callers
 * leave `level` unset and the helper reads from the environment; tests
 * (and unusual call sites that already know the level) can pass it in
 * to keep the function pure.
 */
export interface MaskAdminPathOptions {
  /**
   * Explicit log level to use instead of {@link getLogLevel}'s lookup.
   * Useful for tests that pin behaviour without mutating
   * `process.env`, and for call sites that already plumb the level
   * through their context.
   */
  readonly level?: string;
  /**
   * Override the placeholder. Defaults to {@link ADMIN_PATH_PLACEHOLDER}.
   * Spec mandates `<admin_path>` so this is rarely useful in
   * production; surfaced mainly so tests can prove the helper does not
   * accidentally hard-code the literal in two places.
   */
  readonly placeholder?: string;
}

/**
 * Read `LOG_LEVEL` from the current environment, falling back to
 * {@link DEFAULT_LOG_LEVEL} when the env var is absent or the runtime
 * does not expose `process.env` (Cloudflare Workers).
 *
 * The lookup is wrapped in `try/catch` because some sandboxed runtimes
 * throw when `process` is referenced at all; we never want a logging
 * helper to be the source of a 500.
 */
export function getLogLevel(): string {
  try {
    // `globalThis.process` keeps the helper tree-shake friendly and
    // avoids a hard dependency on Node's `process` global.
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const raw = proc?.env?.LOG_LEVEL;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim().toLowerCase();
    }
  } catch {
    // Intentional: see comment above.
  }
  return DEFAULT_LOG_LEVEL;
}

/**
 * Returns `true` when the runtime is configured to retain the raw
 * admin path in logs (i.e. `LOG_LEVEL=debug`). Every other value —
 * including unknown levels — masks the path, in line with the
 * "default deny" stance of Req 5.5.
 */
export function shouldRetainRawAdminPath(level?: string): boolean {
  const effective = (level ?? getLogLevel()).toLowerCase();
  return effective === 'debug';
}

/**
 * Escape a string for use as a literal inside a `RegExp`. The set of
 * characters mirrors the well-known [MDN list][1]; we keep the
 * function inline to avoid a dep on `lodash.escapeRegExp` for one
 * 50-byte helper.
 *
 * [1]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions#escaping
 */
function escapeForRegex(input: string): string {
  return input.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Trim and validate the configured admin path. Returns `null` when the
 * caller's value is missing, not a string, or normalises to an empty
 * slug — in which case the masker is a strict no-op. This matches the
 * "no admin path persisted" branch in the guard middleware
 * ({@link ../../middleware/admin-path-guard.ts}) where there is simply
 * nothing to mask.
 */
function normalizeMaskTarget(adminPath: string | null | undefined): string | null {
  if (typeof adminPath !== 'string') return null;
  const trimmed = adminPath.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

/**
 * Replace every occurrence of `adminPath` in `input` with the
 * configured `placeholder`. Matching is case-insensitive (see module
 * doc-block) and global. `input` is returned unchanged when:
 *
 *   - it is not a string (defensive — the function is exported and
 *     callers may forget the type contract);
 *   - {@link normalizeMaskTarget} returns `null`;
 *   - the path does not actually appear in the string (avoids
 *     allocating a new identical string).
 */
export function maskAdminPathInString(
  input: string,
  adminPath: string | null | undefined,
  placeholder: string = ADMIN_PATH_PLACEHOLDER,
): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  const target = normalizeMaskTarget(adminPath);
  if (target === null) return input;
  // Quick reject: avoid building a regex when the substring isn't even
  // present (case-insensitive check via `toLowerCase`). For typical
  // log lines this hits the fast path on the vast majority of records.
  if (!input.toLowerCase().includes(target.toLowerCase())) return input;
  const re = new RegExp(escapeForRegex(target), 'gi');
  return input.replace(re, placeholder);
}

/**
 * Mask the admin path inside a value of any shape that the audit
 * logger / structured logger might carry: a raw string, a JSON-shaped
 * metadata object, an array of such, or a primitive that has no
 * strings to mask.
 *
 * Behaviour:
 *
 *   - When {@link shouldRetainRawAdminPath} is `true` (LOG_LEVEL=debug),
 *     the value is returned unchanged. This is the "raw path may be
 *     retained" carve-out of Req 5.5.
 *
 *   - When `adminPath` is null/empty (e.g. instance still
 *     uninitialized), the value is returned unchanged — there is
 *     nothing to mask.
 *
 *   - For strings, defers to {@link maskAdminPathInString}.
 *
 *   - For arrays and plain objects, returns a new array/object whose
 *     elements/values have been recursively masked. Untouched if the
 *     mask is a no-op for every leaf — but for simplicity we always
 *     allocate a fresh container; log objects are small and short-lived.
 *
 *   - For anything else (numbers, booleans, null, Date, …), returns
 *     the value as-is.
 *
 * Type parameter `T` is preserved through the call so TypeScript
 * inference still works for callers (e.g. `maskAdminPath(metadata,
 * path)` keeps the metadata type).
 */
export function maskAdminPath<T>(
  value: T,
  adminPath: string | null | undefined,
  opts?: MaskAdminPathOptions,
): T {
  if (shouldRetainRawAdminPath(opts?.level)) return value;
  const target = normalizeMaskTarget(adminPath);
  if (target === null) return value;
  const placeholder = opts?.placeholder ?? ADMIN_PATH_PLACEHOLDER;
  return maskRecursive(value, target, placeholder) as T;
}

/**
 * Internal walker — split out so the public {@link maskAdminPath} can
 * keep its parameter shape narrow and skip the env lookup once per
 * top-level call.
 */
function maskRecursive(
  value: unknown,
  target: string,
  placeholder: string,
): unknown {
  if (typeof value === 'string') {
    return maskAdminPathInString(value, target, placeholder);
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskRecursive(item, target, placeholder));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    // Iterate own enumerable string keys only — symbols would be a
    // strange thing to find on a JSON-shaped log payload but we err on
    // the safe side by not touching them (and dropping them is also
    // not our job here).
    for (const key of Object.keys(value)) {
      out[key] = maskRecursive((value as Record<string, unknown>)[key], target, placeholder);
    }
    return out;
  }
  return value;
}

/**
 * Type-guard for the "JSON-object" shape we recurse into. Excludes
 * `null`, arrays, and class instances (those have a non-`Object`
 * prototype). Walking class instances would force us to clone via
 * their constructor, which is both fragile and not what audit
 * metadata looks like in practice.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
