import { z } from 'zod';

/**
 * Zod schema + presets for the "Login Security" step of the Setup
 * Wizard.
 *
 * Mirrors the canonical CMS policy schema in
 * `apps/cms/src/modules/setup/policy-codec.ts` so the wizard can give
 * inline range feedback before posting to `/api/v1/setup/complete`.
 * The CMS-side schema remains the source of truth for serialization
 * (Req 16); this file only covers the form / UX surface.
 *
 * Spec refs: requirements §6.3 (ranges + defaults), §8.2 (IP floor),
 * §12.4 (`require_mfa` disabled until MFA module ships); design §5.5.
 */

// ── Notification channels (Req 6.3 `notifyChannels`) ─────────────────────

export const notificationChannelSchema = z.enum(['email', 'webhook']);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

// ── Anomaly action (Req 6.3 + Req 12.4) ──────────────────────────────────

/**
 * Enum of anomaly actions accepted by the schema. The form layer
 * disables the `'require_mfa'` option in the UI per Req 12.4 (MFA
 * module not yet shipped); the schema still accepts it so a JSON
 * import that pre-dates the gate doesn't fail validation, but
 * `STANDARD_PRESET` / `STRICT_PRESET` / `LENIENT_PRESET` never select
 * it.
 */
export const anomalyActionSchema = z.enum([
  'notify_only',
  'require_mfa',
  'lock',
]);
export type AnomalyAction = z.infer<typeof anomalyActionSchema>;

// ── Schema (Req 6.3) ─────────────────────────────────────────────────────

/**
 * Lockout policy form schema. Field-by-field rules and bounds match
 * Req 6.3 exactly. Defaults populated from `STANDARD_PRESET` so a fresh
 * form mounts with a sensible baseline and the user only flips fields
 * they care about.
 *
 * On `anomalyScoreThreshold`: Req 6.3 specifies "number ∈ [0, 1] với 2
 * chữ số thập phân". We use `.multipleOf(0.01)` to enforce 2-decimal
 * precision. Floating-point representation makes naive `.multipleOf`
 * brittle for values like `0.7` (which is `0.7000000000000001` in
 * IEEE-754); we accept that risk because the form value comes from a
 * rendered number input and the canonical encoding rounds again to 2
 * decimals on serialisation in the CMS codec.
 *
 * On `webhookUrl` / `webhookSecret`: optional at the field level; the
 * schema-level `.superRefine` requires both whenever
 * `notifyChannels` includes `'webhook'` (Req 6.3 wording — webhook
 * channel is meaningless without a target URL + secret).
 */
export const lockoutPolicySchema = z
  .object({
    userMaxFailedAttempts: z
      .number()
      .int({ message: 'Must be a whole number.' })
      .min(3, { message: 'Must be at least 3.' })
      .max(20, { message: 'Must be at most 20.' })
      .default(5),
    userLockoutDurationSeconds: z
      .number()
      .int({ message: 'Must be a whole number of seconds.' })
      .min(60, { message: 'Must be at least 60 seconds.' })
      .max(86_400, { message: 'Must be at most 86400 seconds (1 day).' })
      .default(900),
    /**
     * Req 6.3 sets the explicit range for `ipMaxFailedAttempts` to
     * [5, 100]. Req 8.2 mentions a global floor of 3 — the wider
     * floor (5) from Req 6.3 takes precedence here so the form's
     * inline error matches what users see on the slider/input.
     */
    ipMaxFailedAttempts: z
      .number()
      .int({ message: 'Must be a whole number.' })
      .min(5, { message: 'Must be at least 5.' })
      .max(100, { message: 'Must be at most 100.' })
      .default(20),
    ipLockoutDurationSeconds: z
      .number()
      .int({ message: 'Must be a whole number of seconds.' })
      .min(60, { message: 'Must be at least 60 seconds.' })
      .max(86_400, { message: 'Must be at most 86400 seconds (1 day).' })
      .default(3600),
    lockoutWindowSeconds: z
      .number()
      .int({ message: 'Must be a whole number of seconds.' })
      .min(60, { message: 'Must be at least 60 seconds.' })
      .max(86_400, { message: 'Must be at most 86400 seconds (1 day).' })
      .default(900),
    geoAnomalyEnabled: z.boolean().default(true),
    timeAnomalyEnabled: z.boolean().default(false),
    deviceAnomalyEnabled: z.boolean().default(true),
    anomalyScoreThreshold: z
      .number()
      .min(0, { message: 'Must be 0.00 or greater.' })
      .max(1, { message: 'Must be 1.00 or less.' })
      .multipleOf(0.01, { message: 'Must have at most 2 decimal places.' })
      .default(0.7),
    anomalyAction: anomalyActionSchema.default('notify_only'),
    notifyChannels: z
      .array(notificationChannelSchema)
      .nonempty({ message: 'Select at least one notification channel.' })
      .default(['email']),
    /**
     * Artificial login-failure delay in milliseconds (Directus
     * `LOGIN_STALL_TIME` parity). Not surfaced as a form control yet —
     * the CMS codec owns the default (500ms) and admins tune it via the
     * security settings API. Declared here so a policy that already
     * carries the field survives the wizard's parse/serialize round-trip
     * instead of being dropped as an unknown field. Bounds mirror the
     * CMS schema (`[0, 5000]`).
     */
    loginStallMs: z
      .number()
      .int({ message: 'Must be a whole number of milliseconds.' })
      .min(0, { message: 'Must be 0 or greater.' })
      .max(5_000, { message: 'Must be at most 5000 milliseconds.' })
      .optional(),
    webhookUrl: z
      .string()
      .url({ message: 'Enter a valid URL.' })
      .max(2048, { message: 'URL must be 2048 characters or fewer.' })
      .optional(),
    webhookSecret: z
      .string()
      .min(1, { message: 'Webhook secret is required.' })
      .max(256, { message: 'Webhook secret must be 256 characters or fewer.' })
      .optional(),
  })
  .superRefine((value, ctx) => {
    // Cross-field: webhook channel requires both URL + secret.
    if (value.notifyChannels.includes('webhook')) {
      if (!value.webhookUrl || value.webhookUrl.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['webhookUrl'],
          message: 'Webhook URL is required when the webhook channel is selected.',
        });
      }
      if (!value.webhookSecret || value.webhookSecret.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['webhookSecret'],
          message:
            'Webhook secret is required when the webhook channel is selected.',
        });
      }
    }
  });

/**
 * Inferred TypeScript type for the Lockout Policy form.
 */
export type LockoutPolicyFormValues = z.infer<typeof lockoutPolicySchema>;

// ── Presets (design §5.5) ────────────────────────────────────────────────

/**
 * Concrete shape of a preset — the input shape (before schema defaults
 * fill anything in). Defined separately so consumers can spread a
 * preset into form `defaultValues` without TypeScript widening every
 * field to its full Zod input union.
 */
type PolicyPresetShape = {
  userMaxFailedAttempts: number;
  userLockoutDurationSeconds: number;
  ipMaxFailedAttempts: number;
  ipLockoutDurationSeconds: number;
  lockoutWindowSeconds: number;
  geoAnomalyEnabled: boolean;
  timeAnomalyEnabled: boolean;
  deviceAnomalyEnabled: boolean;
  anomalyScoreThreshold: number;
  anomalyAction: AnomalyAction;
  notifyChannels: NotificationChannel[];
};

/**
 * "Standard" preset. Values track Req 6.3 defaults exactly so the
 * wizard's default rendering matches the requirement table 1:1.
 *
 *   - 5 user attempts / 15 min lockout
 *   - 20 IP attempts / 60 min lockout
 *   - 15 min sliding window
 *   - geo + device anomaly on, time off
 *   - anomaly threshold 0.70, action `notify_only`
 *   - email-only notification
 */
export const STANDARD_PRESET: Readonly<PolicyPresetShape> = Object.freeze({
  userMaxFailedAttempts: 5,
  userLockoutDurationSeconds: 900,
  ipMaxFailedAttempts: 20,
  ipLockoutDurationSeconds: 3600,
  lockoutWindowSeconds: 900,
  geoAnomalyEnabled: true,
  timeAnomalyEnabled: false,
  deviceAnomalyEnabled: true,
  anomalyScoreThreshold: 0.7,
  anomalyAction: 'notify_only',
  notifyChannels: ['email'] as NotificationChannel[],
});

/**
 * "Strict" preset — tighter thresholds + longer lockouts + all anomaly
 * detectors on, with `lock` as the anomaly action.
 *
 *   - 3 user attempts / 60 min lockout
 *   - 10 IP attempts / 240 min lockout
 *   - 30 min sliding window
 *   - geo + time + device anomaly all on
 *   - anomaly threshold 0.50, action `lock`
 *   - email notification (operators can add webhook in the form)
 */
export const STRICT_PRESET: Readonly<PolicyPresetShape> = Object.freeze({
  userMaxFailedAttempts: 3,
  userLockoutDurationSeconds: 3600,
  ipMaxFailedAttempts: 10,
  ipLockoutDurationSeconds: 14_400,
  lockoutWindowSeconds: 1800,
  geoAnomalyEnabled: true,
  timeAnomalyEnabled: true,
  deviceAnomalyEnabled: true,
  anomalyScoreThreshold: 0.5,
  anomalyAction: 'lock',
  notifyChannels: ['email'] as NotificationChannel[],
});

/**
 * "Lenient" preset — looser thresholds + shorter lockouts + only the
 * lowest-friction anomaly detectors, with `notify_only` action.
 *
 *   - 10 user attempts / 5 min lockout
 *   - 50 IP attempts / 15 min lockout
 *   - 5 min sliding window
 *   - geo anomaly on, time + device off
 *   - anomaly threshold 0.85, action `notify_only`
 *   - email-only notification
 */
export const LENIENT_PRESET: Readonly<PolicyPresetShape> = Object.freeze({
  userMaxFailedAttempts: 10,
  userLockoutDurationSeconds: 300,
  ipMaxFailedAttempts: 50,
  ipLockoutDurationSeconds: 900,
  lockoutWindowSeconds: 300,
  geoAnomalyEnabled: true,
  timeAnomalyEnabled: false,
  deviceAnomalyEnabled: false,
  anomalyScoreThreshold: 0.85,
  anomalyAction: 'notify_only',
  notifyChannels: ['email'] as NotificationChannel[],
});

/**
 * Convenience map keyed by preset id — handy for the preset chooser
 * dropdown in `step-security.tsx`.
 */
export const POLICY_PRESETS = Object.freeze({
  standard: STANDARD_PRESET,
  strict: STRICT_PRESET,
  lenient: LENIENT_PRESET,
} as const);

export type PolicyPresetId = keyof typeof POLICY_PRESETS;
