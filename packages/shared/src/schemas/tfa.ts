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

export const TotpDisableSchema = z.object({
  password: z.string().min(1),
  code: TotpCodeSchema,
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
