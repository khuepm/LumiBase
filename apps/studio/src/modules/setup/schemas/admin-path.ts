import { z } from 'zod';
import { ADMIN_PATH_REGEX, BLACKLIST_SET, normalizeAdminPath, RESERVED_PATH_PREFIXES } from './admin-path-rules';

// Regex / blacklist / reserved prefixes / normaliser live in the Zod-free
// `admin-path-rules.ts` (#757) and are re-exported here unchanged.
export {
  ADMIN_PATH_REGEX,
  DEFAULT_ADMIN_PATHS_BLACKLIST,
  normalizeAdminPath,
  RESERVED_PATH_PREFIXES,
} from './admin-path-rules';

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
