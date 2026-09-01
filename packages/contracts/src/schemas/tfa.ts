import { z } from 'zod';

export const TotpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6,8}$/, 'Code must be 6–8 digits.');

export const TotpVerifyLoginSchema = z
  .object({
    challengeToken: z.string().min(1),
    code: TotpCodeSchema.optional(),
    recoveryCode: z.string().min(8).max(32).optional(),
  })
  .refine((v) => (v.code ? 1 : 0) + (v.recoveryCode ? 1 : 0) === 1, {
    message: 'Provide either code or recoveryCode.',
  });

export const TotpSetupSchema = z.object({
  password: z.string().min(1),
});

export const TotpConfirmSchema = z.object({
  code: TotpCodeSchema,
  secret: z.string().min(16).max(128),
});

/**
 * Disabling accepts a recovery code as an alternative to a live TOTP code.
 * Without that alternative a user whose seed cannot be decrypted — because the
 * key that wrapped it was retired — is stuck: recovery codes still let them log
 * in, but every path that removes or replaces the broken factor demands a code
 * only the missing key could verify. Password step-up is still required either
 * way, and disabling bumps `tokenVersion` + revokes refresh tokens, so this
 * widens the input, not the trust.
 */
export const TotpDisableSchema = z
  .object({
    password: z.string().min(1),
    code: TotpCodeSchema.optional(),
    recoveryCode: z.string().min(8).max(32).optional(),
  })
  .refine((v) => (v.code ? 1 : 0) + (v.recoveryCode ? 1 : 0) === 1, {
    message: 'Provide either code or recoveryCode.',
  });

export const TotpRegenerateRecoverySchema = z.object({
  password: z.string().min(1),
  code: TotpCodeSchema,
});

export type TotpVerifyLoginInput = z.infer<typeof TotpVerifyLoginSchema>;
export type TotpSetupInput = z.infer<typeof TotpSetupSchema>;
export type TotpConfirmInput = z.infer<typeof TotpConfirmSchema>;
export type TotpDisableInput = z.infer<typeof TotpDisableSchema>;
export type TotpRegenerateRecoveryInput = z.infer<typeof TotpRegenerateRecoverySchema>;
