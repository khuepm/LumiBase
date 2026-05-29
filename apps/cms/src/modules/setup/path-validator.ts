/**
 * Admin path normalization + validation.
 *
 * Two small pure helpers used by both the wizard frontend (mirrored via
 * the shared schema) and the backend handlers:
 *
 *   - {@link normalizeAdminPath} canonicalises raw input to `/<slug>`
 *     before validation runs. Lowercasing, trimming, collapsing repeated
 *     slashes, and stripping the trailing slash all happen here so the
 *     downstream blacklist check operates on the same surface for every
 *     accepted form. (Req 4.8)
 *   - {@link validateAdminPath} rejects predictable paths
 *     (Default_Admin_Paths, reserved system prefixes) and enforces the
 *     character/length contract from Req 4.2.
 *
 * Idempotency property: `normalize(normalize(x)) === normalize(x)` for
 * every input — see Property 11 / Req 4.8 (`__tests__/path-validator.test.ts`).
 *
 * References: requirements §4.2–§4.4, §4.8; design.md §6.1.
 */

/**
 * Slug shape accepted post-normalisation. Spec excerpt from Req 4.2:
 *   `^/[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$`
 *
 * Notes on the bounds:
 *   - leading + trailing characters must be alphanumeric (no double
 *     dashes at the boundary, Req 4.2);
 *   - the middle group `[a-z0-9-]{2,62}` plus the two anchors yields a
 *     slug of 4–64 characters after the leading slash, total length
 *     5–65 including the leading `/`.
 */
export const ADMIN_PATH_REGEX = /^\/[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$/;

/**
 * Default_Admin_Paths from the requirements glossary. Stored as a Set
 * keyed by normalised form so membership tests run in constant time.
 */
export const DEFAULT_ADMIN_PATHS: ReadonlySet<string> = new Set([
  '/admin',
  '/administrator',
  '/studio',
  '/wp-admin',
  '/login',
  '/dashboard',
  '/cms',
  '/api',
  '/setup',
  '/',
]);

/**
 * Reserved prefixes — paths under these collide with system routes and
 * must never become admin paths even if the suffix is unique. (Req 4.4
 * extends the list with `/.well-known`, `/static`, `/assets` for
 * compatibility with assets/auxiliary endpoints.)
 */
export const RESERVED_PATH_PREFIXES: ReadonlyArray<string> = [
  '/api',
  '/setup',
  '/health',
  '/metrics',
  '/scim',
  '/.well-known',
  '/static',
  '/assets',
];

/** Result returned from {@link validateAdminPath}. */
export type AdminPathValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | 'INVALID_FORMAT'
        | 'PATH_PREDICTABLE'
        | 'PATH_RESERVED';
      readonly message: string;
    };

/**
 * Normalise raw user input into a canonical `/<slug>` form.
 *
 * Steps (in order):
 *   1. drop everything after the first `?` or `#` so query strings or
 *      fragments don't leak into the slug;
 *   2. strip ASCII control chars (0x00–0x1F, 0x7F) which are not
 *      part of any valid slug — Req 4.8 explicitly mentions control
 *      chars as one of the failures that must surface "Invalid path
 *      format";
 *   3. trim outer whitespace;
 *   4. lowercase;
 *   5. collapse any internal whitespace runs into nothing (so `/lumi
 *      admin` doesn't accidentally become a multi-segment URL);
 *   6. collapse repeated slashes into a single slash;
 *   7. ensure exactly one leading slash;
 *   8. drop the trailing slash unless the result is the root.
 *
 * The function is total — it always returns a string. The downstream
 * {@link validateAdminPath} decides whether the normalised form is
 * acceptable.
 */
export function normalizeAdminPath(input: string): string {
  if (typeof input !== 'string') return '';

  // 1. Drop query / fragment.
  let out = input;
  const queryIdx = out.indexOf('?');
  if (queryIdx >= 0) out = out.slice(0, queryIdx);
  const fragmentIdx = out.indexOf('#');
  if (fragmentIdx >= 0) out = out.slice(0, fragmentIdx);

  // 2. Strip ASCII control characters. We avoid \p{Cc} so the function
  //    works in any JS runtime regardless of unicode RegExp support.
  out = out.replace(/[\u0000-\u001F\u007F]/g, '');

  // 3. Trim outer whitespace.
  out = out.trim();

  // 4. Lowercase.
  out = out.toLowerCase();

  // 5. Collapse any whitespace runs (spaces, tabs, NBSP, etc.).
  out = out.replace(/\s+/g, '');

  // 6. Collapse repeated slashes.
  out = out.replace(/\/+/g, '/');

  if (out.length === 0) return '';

  // 7. Ensure exactly one leading slash.
  if (!out.startsWith('/')) out = `/${out}`;

  // 8. Drop trailing slash if any (but keep root '/').
  if (out.length > 1 && out.endsWith('/')) {
    out = out.slice(0, -1);
  }

  return out;
}

/**
 * Validate a *normalised* admin path. The caller is expected to have
 * piped its input through {@link normalizeAdminPath} first; this
 * function does not re-normalise so that a bad input which would
 * otherwise be silently rewritten is reported with `INVALID_FORMAT`.
 *
 * Validation order matters for the wizard error UX (Req 4.3, 4.4):
 *   1. format must match the slug regex (`INVALID_FORMAT`);
 *   2. must not be one of the predictable defaults
 *      (`PATH_PREDICTABLE`);
 *   3. must not start with a reserved system prefix (`PATH_RESERVED`).
 */
export function validateAdminPath(
  normalized: string,
): AdminPathValidationResult {
  // (1) Shape check.
  if (typeof normalized !== 'string' || !ADMIN_PATH_REGEX.test(normalized)) {
    return {
      ok: false,
      code: 'INVALID_FORMAT',
      message:
        'Invalid path format. Use /<slug> with 4–64 lowercase alphanumeric or hyphen characters.',
    };
  }

  // (2) Predictable paths blacklist.
  if (DEFAULT_ADMIN_PATHS.has(normalized)) {
    return {
      ok: false,
      code: 'PATH_PREDICTABLE',
      message: 'This path is too predictable. Choose another.',
    };
  }

  // (3) Reserved prefixes.
  for (const reserved of RESERVED_PATH_PREFIXES) {
    if (normalized === reserved || normalized.startsWith(`${reserved}/`)) {
      return {
        ok: false,
        code: 'PATH_RESERVED',
        message: `Path conflicts with reserved prefix '${reserved}'.`,
      };
    }
  }

  return { ok: true };
}
