import { z } from 'zod';

/**
 * Shared password-strength policy (CWE-521).
 *
 * A single source of truth so every place that accepts a new password —
 * account setup, admin-created users, and password recovery/reset — enforces
 * the same minimum length and complexity. Verifying an existing password (login)
 * does NOT use this; it must accept whatever was previously stored.
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** Characters that count toward the "special character" requirement. */
export const PASSWORD_SPECIAL_CHARS = '!@#$%^&*()-_=+[]{};:,.?/';

export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`)
  .refine((value) => /[a-z]/.test(value), 'Password must contain a lowercase letter.')
  .refine((value) => /[A-Z]/.test(value), 'Password must contain an uppercase letter.')
  .refine((value) => /[0-9]/.test(value), 'Password must contain a digit.')
  .refine(
    (value) => [...value].some((ch) => PASSWORD_SPECIAL_CHARS.includes(ch)),
    'Password must contain a special character.',
  );

export type Password = z.infer<typeof PasswordSchema>;
