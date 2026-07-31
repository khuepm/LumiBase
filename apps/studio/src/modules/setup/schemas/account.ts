import { z } from 'zod';

/**
 * Zod schema for the "Admin Account" step of the Setup Wizard.
 *
 * Implements the validation rules from Req 3.1–3.4:
 *
 *   - email must match an RFC 5322-simplified pattern (Req 3.2);
 *   - password ≥ 12 chars and contains at least one lowercase letter,
 *     uppercase letter, digit, and special character from the explicit
 *     set in Req 3.3;
 *   - `confirmPassword` must equal `password` (Req 3.4);
 *   - `firstName` / `lastName` trim outer whitespace and stay between
 *     1 and 100 characters after the trim. The 100-char ceiling matches
 *     a sensible default for the existing nullable `text` columns in
 *     `packages/database/src/schema/core.ts` (no explicit length bound
 *     in the Drizzle schema, so we pick a round value that's well below
 *     any postgres `text` limit while leaving room for full names).
 *
 * NOTE on Req 3.5 (zxcvbn ≥ 3 gate):
 *   The strength gate is enforced by the form layer at task 3.5, not
 *   here. zxcvbn (~400KB) is lazy-loaded only on the Account step
 *   (design §5.5) and the schema runs in contexts where the library may
 *   not yet be available (tests, SSR, the codec round-trip in
 *   `apps/cms/src/modules/setup/policy-codec.ts`). Pulling zxcvbn into
 *   this schema would force it into the main bundle and break the
 *   intentional code-split. The form composes a refine on top when the
 *   library is loaded.
 *
 * Spec refs: requirements §3.1–§3.5; design.md §5.5.
 */

// ── Email (Req 3.2) ──────────────────────────────────────────────────────

/**
 * RFC 5322-simplified email regex. Matches the practical subset most
 * email providers accept (local-part with dots / plus / underscores,
 * domain with TLD ≥ 2 chars). Avoids the full RFC grammar — that is
 * impractical to express as a regex and the backend re-validates.
 */
const EMAIL_REGEX =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

// ── Password (Req 3.3) ───────────────────────────────────────────────────

export const PASSWORD_MIN_LENGTH = 12;

/**
 * Special characters explicitly allowed by Req 3.3. Listing them as a
 * Set keeps the per-class check readable and lets us reuse the same
 * constant in the form's "missing class" hint UX.
 */
export const PASSWORD_SPECIAL_CHARS: ReadonlySet<string> = new Set(
  '!@#$%^&*()-_=+[]{};:,.?/'.split(''),
);

const HAS_LOWER = /[a-z]/;
const HAS_UPPER = /[A-Z]/;
const HAS_DIGIT = /[0-9]/;

function hasSpecialChar(value: string): boolean {
  for (const ch of value) {
    if (PASSWORD_SPECIAL_CHARS.has(ch)) return true;
  }
  return false;
}

/**
 * Identifier for each password rule from Req 3.3. The Account step
 * renders a live ✓/✗ list keyed by these ids next to the password
 * input — keep this in sync with the `params.rule` strings emitted by
 * the schema so unit tests can correlate the two.
 */
export type PasswordRuleId =
  | 'length'
  | 'lowercase'
  | 'uppercase'
  | 'digit'
  | 'special';

/**
 * Evaluate every Req 3.3 password rule against `value` and return a
 * map of rule → satisfied. Used by `step-account.tsx` to render the
 * inline rules list without duplicating the regex/length checks.
 */
export function evaluatePasswordRules(
  value: string,
): Record<PasswordRuleId, boolean> {
  return {
    length: value.length >= PASSWORD_MIN_LENGTH,
    lowercase: HAS_LOWER.test(value),
    uppercase: HAS_UPPER.test(value),
    digit: HAS_DIGIT.test(value),
    special: hasSpecialChar(value),
  };
}

// ── First / Last name ────────────────────────────────────────────────────

const NAME_MIN = 1;
const NAME_MAX = 100;

const trimmedName = (label: 'First' | 'Last') =>
  z
    .string()
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(NAME_MIN, { message: `${label} name is required.` })
        .max(NAME_MAX, {
          message: `${label} name must be ${NAME_MAX} characters or fewer.`,
        }),
    );

// ── Combined schema ──────────────────────────────────────────────────────

/**
 * Account form schema. Use `superRefine` (rather than separate `.regex`
 * checks) to add a per-class issue for the password so the form can
 * highlight exactly which class is missing — improving the UX described
 * in design §5.5 (inline error per failing rule).
 */
export const accountSchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(1, { message: 'Email is required.' })
      .max(254, { message: 'Email must be 254 characters or fewer.' })
      .regex(EMAIL_REGEX, { message: 'Enter a valid email address.' }),
    password: z.string(),
    confirmPassword: z.string(),
    firstName: trimmedName('First'),
    lastName: trimmedName('Last'),
  })
  .superRefine((value, ctx) => {
    // Password rules (Req 3.3) — emit a separate issue per failing class
    // so the form can show inline ✓/✗ for each requirement.
    const { password } = value;

    if (password.length < PASSWORD_MIN_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
        params: { rule: 'minLength', minimum: PASSWORD_MIN_LENGTH },
      });
    }
    if (!HAS_LOWER.test(password)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'Password must include a lowercase letter.',
        params: { rule: 'lowercase' },
      });
    }
    if (!HAS_UPPER.test(password)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'Password must include an uppercase letter.',
        params: { rule: 'uppercase' },
      });
    }
    if (!HAS_DIGIT.test(password)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'Password must include a digit.',
        params: { rule: 'digit' },
      });
    }
    if (!hasSpecialChar(password)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'Password must include a special character.',
        params: { rule: 'special' },
      });
    }

    // Cross-field check (Req 3.4).
    if (value.confirmPassword !== password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmPassword'],
        message: 'Passwords do not match.',
      });
    }
  });

/**
 * Inferred TypeScript type for the Account form. After `.superRefine`
 * the inferred type matches the input shape (no transforms beyond the
 * trim on first/last name, which Zod folds into the output).
 */
export type AccountFormValues = z.infer<typeof accountSchema>;
