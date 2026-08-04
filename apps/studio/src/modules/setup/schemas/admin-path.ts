import { z } from 'zod';

/**
 * Zod schema + helpers for the "Admin Path" step of the Setup Wizard.
 *
 * Implements client-side validation for Req 4.2–4.4 and Req 4.8. The
 * canonical source of truth is the CMS-side validator in
 * `apps/cms/src/modules/setup/path-validator.ts`; this file mirrors the
 * exact same regex / blacklist / reserved-prefix list so the wizard can
 * give immediate inline feedback before round-tripping to the server.
 *
 * Spec refs: requirements §4.2–§4.4, §4.8; design.md §5.5.
 */

// ── Slug shape (Req 4.2) ─────────────────────────────────────────────────

/**
 * Post-normalisation slug shape. Mirrors `ADMIN_PATH_REGEX` in
 * `apps/cms/src/modules/setup/path-validator.ts`:
 *
 *   `^/[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$`
 *
 * The slug starts with `/` and contains 4–64 lowercase alphanumeric or
 * hyphen characters with alphanumeric anchors at both ends.
 */
export const ADMIN_PATH_REGEX = /^\/[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$/;

// ── Default_Admin_Paths (Req 4.3) ────────────────────────────────────────

/**
 * Default_Admin_Paths from the requirements glossary — paths a bot will
 * try first. These must be rejected even if they technically match the
 * regex shape.
 */
export const DEFAULT_ADMIN_PATHS_BLACKLIST: ReadonlyArray<string> = [
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
];

const BLACKLIST_SET: ReadonlySet<string> = new Set(
  DEFAULT_ADMIN_PATHS_BLACKLIST,
);

// ── Reserved prefixes (Req 4.4) ──────────────────────────────────────────

/**
 * Reserved prefixes that collide with system routes. The Req 4.4 list is
 * `/api`, `/setup`, `/health`, `/metrics`, `/scim`; design.md §5.5
 * extends it with `/.well-known`, `/static`, `/assets` to match the
 * backend validator (kept in sync intentionally).
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

// ── Normalisation (Req 4.8) ──────────────────────────────────────────────

/**
 * Normalise raw user input into a canonical `/<slug>` form.
 *
 * Returns `null` when the input cannot be normalised into a non-empty
 * candidate (Req 4.8 — "input không thể chuẩn hóa thành slug hợp lệ,
 * ví dụ chỉ chứa whitespace hoặc ký tự control"). Otherwise returns a
 * string that may or may not pass the format regex; downstream
 * validation decides whether the normalised form is acceptable.
 *
 * Steps mirror the backend `normalizeAdminPath` (apps/cms):
 *   1. drop query / fragment;
 *   2. strip ASCII control chars (0x00–0x1F, 0x7F);
 *   3. trim outer whitespace;
 *   4. lowercase;
 *   5. collapse internal whitespace;
 *   6. collapse repeated slashes;
 *   7. ensure exactly one leading slash;
 *   8. drop trailing slash unless the result is the root.
 *
 * Idempotency: `normalize(normalize(x)) === normalize(x)` for every
 * input that returns non-null on the first pass — see `path-validator`
 * tests on the backend (Property 11).
 */
export function normalizeAdminPath(input: string): string | null {
  if (typeof input !== 'string') return null;

  let out = input;

  // 1. Drop query / fragment.
  const qIdx = out.indexOf('?');
  if (qIdx >= 0) out = out.slice(0, qIdx);
  const fIdx = out.indexOf('#');
  if (fIdx >= 0) out = out.slice(0, fIdx);

  // 2. Strip ASCII control characters.
  out = out.replace(/[\u0000-\u001F\u007F]/g, '');

  // 3. Trim outer whitespace.
  out = out.trim();

  // 4. Lowercase.
  out = out.toLowerCase();

  // 5. Collapse internal whitespace runs.
  out = out.replace(/\s+/g, '');

  // 6. Collapse repeated slashes.
  out = out.replace(/\/+/g, '/');

  if (out.length === 0) return null;

  // 7. Ensure exactly one leading slash.
  if (!out.startsWith('/')) out = `/${out}`;

  // 8. Drop trailing slash (but keep root).
  if (out.length > 1 && out.endsWith('/')) {
    out = out.slice(0, -1);
  }

  // After all stripping, if the result reduced to bare `/` it's not
  // a usable admin path slug — flag as un-normalisable.
  if (out === '/') return null;

  return out;
}

// ── Schema ───────────────────────────────────────────────────────────────

/**
 * Admin path schema. The transform runs `normalizeAdminPath` first so
 * subsequent refines all see a canonical `/<slug>` value; a `null`
 * normalisation surfaces as the explicit "Invalid path format" error
 * required by Req 4.8 *before* any other rule fires.
 */
export const adminPathSchema = z.object({
  adminPath: z
    .string({ error: 'Admin path is required.' })
    .min(1, { error: 'Admin path is required.' })
    .transform((value, ctx) => {
      const normalized = normalizeAdminPath(value);
      if (normalized === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid path format.',
          path: [],
        });
        return z.NEVER;
      }
      return normalized;
    })
    .superRefine((normalized, ctx) => {
      // (1) Shape check — Req 4.2.
      if (!ADMIN_PATH_REGEX.test(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Use /<slug> with 4–64 lowercase alphanumeric or hyphen characters, ' +
            'starting and ending with a letter or digit.',
          path: [],
          params: { rule: 'format' },
        });
        return;
      }

      // (2) Blacklist — Req 4.3.
      if (BLACKLIST_SET.has(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'This path is too predictable. Choose another.',
          path: [],
          params: { rule: 'predictable' },
        });
        return;
      }

      // (3) Reserved prefixes — Req 4.4.
      for (const reserved of RESERVED_PATH_PREFIXES) {
        if (
          normalized === reserved ||
          normalized.startsWith(`${reserved}/`)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Path conflicts with reserved prefix '${reserved}'.`,
            path: [],
            params: { rule: 'reserved' },
          });
          return;
        }
      }
    }),
});

/**
 * Inferred TypeScript type for the Admin Path form. Note `adminPath`
 * is the *normalised* string (output of the transform), not the raw
 * input — the form should display this back to the user as the final
 * canonical form.
 */
export type AdminPathFormValues = z.infer<typeof adminPathSchema>;
