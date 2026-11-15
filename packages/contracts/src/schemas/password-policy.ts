import { z } from 'zod';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_SPECIAL_CHARS } from './password';
import {
  estimatePasswordStrength,
  type PasswordStrengthScore,
  type PasswordWeakness,
} from './password-strength';

/**
 * Configurable password policy (#733, epic #674 S04).
 *
 * One rule set, evaluated identically by the CMS (every path that sets a
 * password) and by the Studio (live checklist + strength meter). The server
 * answers a failed check with
 *
 *   { errors: [{ code: 'PASSWORD_POLICY', message, rules: [...] }] }
 *
 * where `rules` lists every rule with `ok: true|false`, so a client can name
 * exactly what failed instead of "Password is too weak".
 *
 * Breach checking (Have I Been Pwned, k-anonymity) is a server-only rule and
 * is OFF by default — turning it on sends a 5-hex-char SHA-1 prefix of each new
 * password to a third party, which is an operator decision.
 */

/** Absolute floor for `minLength` — NIST SP 800-63B never goes below 8. */
export const PASSWORD_POLICY_MIN_LENGTH_FLOOR = 8;
/** Ceiling for `minLength`; must leave room under {@link PASSWORD_MAX_LENGTH}. */
export const PASSWORD_POLICY_MIN_LENGTH_CEILING = 128;

export const PasswordPolicySchema = z
  .object({
    minLength: z
      .number()
      .int()
      .min(PASSWORD_POLICY_MIN_LENGTH_FLOOR)
      .max(PASSWORD_POLICY_MIN_LENGTH_CEILING)
      .default(PASSWORD_MIN_LENGTH),
    requireLowercase: z.boolean().default(true),
    requireUppercase: z.boolean().default(true),
    requireDigit: z.boolean().default(true),
    requireSpecial: z.boolean().default(true),
    /** Minimum zxcvbn-style score (0 disables the strength rule). */
    minStrength: z.number().int().min(0).max(4).default(2),
    /** Reject passwords found in the HIBP corpus. Off by default (privacy). */
    breachCheck: z.boolean().default(false),
  })
  .strict();

export type PasswordPolicy = z.infer<typeof PasswordPolicySchema>;
export type PasswordPolicyInput = z.input<typeof PasswordPolicySchema>;

/** The policy that applies when none is configured. */
export const DEFAULT_PASSWORD_POLICY: Readonly<PasswordPolicy> = Object.freeze(
  PasswordPolicySchema.parse({}),
);

/**
 * The rule set a client may see (served unauthenticated by
 * `GET /api/v1/auth/password-policy`). Every field is something the user needs
 * to pick a compliant password; nothing here is secret.
 */
export interface PublicPasswordPolicy extends PasswordPolicy {
  readonly maxLength: number;
  readonly specialChars: string;
}

export function toPublicPasswordPolicy(policy: PasswordPolicy): PublicPasswordPolicy {
  return {
    minLength: policy.minLength,
    maxLength: PASSWORD_MAX_LENGTH,
    requireLowercase: policy.requireLowercase,
    requireUppercase: policy.requireUppercase,
    requireDigit: policy.requireDigit,
    requireSpecial: policy.requireSpecial,
    specialChars: PASSWORD_SPECIAL_CHARS,
    minStrength: policy.minStrength,
    breachCheck: policy.breachCheck,
  };
}

export const PASSWORD_STRENGTH_LABELS: Readonly<Record<PasswordStrengthScore, string>> = {
  0: 'very weak',
  1: 'weak',
  2: 'fair',
  3: 'strong',
  4: 'very strong',
};

export type PasswordRuleId =
  | 'min_length'
  | 'max_length'
  | 'lowercase'
  | 'uppercase'
  | 'digit'
  | 'special'
  | 'min_strength'
  | 'not_breached';

/** One evaluated rule. Extra fields carry the parameters the message used. */
export interface PasswordRuleResult {
  readonly rule: PasswordRuleId;
  readonly ok: boolean;
  readonly message: string;
  readonly min?: number;
  readonly max?: number;
  readonly actual?: number;
  readonly chars?: string;
  readonly weaknesses?: readonly PasswordWeakness[];
}

export interface PasswordPolicyEvaluation {
  readonly ok: boolean;
  readonly score: PasswordStrengthScore;
  readonly rules: readonly PasswordRuleResult[];
}

const WEAKNESS_HINTS: Readonly<Record<PasswordWeakness, string>> = {
  common_password: 'it contains a commonly used password',
  contains_user_input: 'it contains your name or e-mail',
  sequence: 'it contains a sequence like "abc" or "123"',
  repeat: 'it repeats characters or a pattern',
  keyboard_pattern: 'it contains a keyboard pattern like "qwerty"',
  year: 'it contains a year',
};

/**
 * Evaluate every client-checkable rule of `policy` against `password`.
 * The `not_breached` rule is NOT produced here (it needs the network) — the
 * CMS policy service appends it when `policy.breachCheck` is on.
 */
export function evaluatePasswordPolicy(
  password: string,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
  userInputs: readonly (string | null | undefined)[] = [],
): PasswordPolicyEvaluation {
  const rules: PasswordRuleResult[] = [];
  const length = [...password].length;

  rules.push({
    rule: 'min_length',
    ok: length >= policy.minLength,
    min: policy.minLength,
    actual: length,
    message: `Use at least ${policy.minLength} characters (currently ${length}).`,
  });
  rules.push({
    rule: 'max_length',
    ok: length <= PASSWORD_MAX_LENGTH,
    max: PASSWORD_MAX_LENGTH,
    actual: length,
    message: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
  });
  if (policy.requireLowercase) {
    rules.push({ rule: 'lowercase', ok: /[a-z]/.test(password), message: 'Add a lowercase letter (a–z).' });
  }
  if (policy.requireUppercase) {
    rules.push({ rule: 'uppercase', ok: /[A-Z]/.test(password), message: 'Add an uppercase letter (A–Z).' });
  }
  if (policy.requireDigit) {
    rules.push({ rule: 'digit', ok: /[0-9]/.test(password), message: 'Add a digit (0–9).' });
  }
  if (policy.requireSpecial) {
    rules.push({
      rule: 'special',
      ok: [...password].some((ch) => PASSWORD_SPECIAL_CHARS.includes(ch)),
      chars: PASSWORD_SPECIAL_CHARS,
      message: `Add a special character, one of ${PASSWORD_SPECIAL_CHARS}`,
    });
  }

  const strength = estimatePasswordStrength(password, userInputs);
  if (policy.minStrength > 0) {
    const ok = strength.score >= policy.minStrength;
    const why = strength.weaknesses.map((w) => WEAKNESS_HINTS[w]);
    rules.push({
      rule: 'min_strength',
      ok,
      min: policy.minStrength,
      actual: strength.score,
      weaknesses: strength.weaknesses,
      message: ok
        ? `Strength is ${PASSWORD_STRENGTH_LABELS[strength.score]}.`
        : `Too easy to guess (strength ${PASSWORD_STRENGTH_LABELS[strength.score]}, needs ${PASSWORD_STRENGTH_LABELS[policy.minStrength as PasswordStrengthScore]})${
            why.length > 0 ? `: ${why.join('; ')}` : ''
          }. Make it longer or add unrelated words.`,
    });
  }

  return { ok: rules.every((r) => r.ok), score: strength.score, rules };
}

/** One-line summary naming every failed rule, for the error envelope's `message`. */
export function summarizePasswordPolicyFailure(rules: readonly PasswordRuleResult[]): string {
  const failed = rules.filter((r) => !r.ok);
  if (failed.length === 0) return 'Password meets the policy.';
  return `Password does not meet the policy: ${failed.map((r) => `${r.rule} — ${r.message}`).join(' ')}`;
}
