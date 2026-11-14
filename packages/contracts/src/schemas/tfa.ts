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

// ── Passkeys / WebAuthn (#735) ─────────────────────────────────────────────

/** A user-chosen passkey label. */
export const PasskeyNameSchema = z.string().trim().min(1).max(64);

/**
 * The browser's `PublicKeyCredential` serialised to JSON (what
 * `@simplewebauthn/browser` returns). Only the envelope is checked here; the
 * cryptographic verification happens server-side.
 */
export const WebAuthnCredentialJsonSchema = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  response: z.record(z.string(), z.unknown()),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional().default({}),
  authenticatorAttachment: z.string().optional(),
});

/** `POST /me/passkeys/registration-options` — password step-up, like TOTP setup. */
export const PasskeyRegistrationOptionsSchema = z.object({
  password: z.string().min(1),
});

/** `POST /me/passkeys` — finish registration. */
export const PasskeyRegisterSchema = z.object({
  ceremonyId: z.string().min(16).max(128),
  response: WebAuthnCredentialJsonSchema,
  name: PasskeyNameSchema.optional(),
});

export const PasskeyRenameSchema = z.object({
  name: PasskeyNameSchema,
});

/** Removing a passkey (and regenerating recovery codes) re-asks for the password. */
export const PasskeyStepUpSchema = z.object({
  password: z.string().min(1),
});

/**
 * `POST /auth/passkey/options` — with `challengeToken` the passkey is the
 * second factor after the password; without it, a passwordless (usernameless)
 * staff sign-in with a discoverable credential.
 */
export const PasskeyLoginOptionsSchema = z.object({
  challengeToken: z.string().min(1).optional(),
});

/** `POST /auth/passkey/verify` — finish either authentication ceremony. */
export const PasskeyLoginVerifySchema = z.object({
  ceremonyId: z.string().min(16).max(128),
  response: WebAuthnCredentialJsonSchema,
  challengeToken: z.string().min(1).optional(),
});

export type PasskeyRegistrationOptionsInput = z.infer<typeof PasskeyRegistrationOptionsSchema>;
export type PasskeyRegisterInput = z.infer<typeof PasskeyRegisterSchema>;
export type PasskeyRenameInput = z.infer<typeof PasskeyRenameSchema>;
export type PasskeyStepUpInput = z.infer<typeof PasskeyStepUpSchema>;
export type PasskeyLoginOptionsInput = z.infer<typeof PasskeyLoginOptionsSchema>;
export type PasskeyLoginVerifyInput = z.infer<typeof PasskeyLoginVerifySchema>;
