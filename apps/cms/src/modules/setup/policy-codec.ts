import { z } from 'zod';

/**
 * Lockout / anomaly detection policy codec.
 *
 * Implements Req 16 (round-trip serialization) on top of the schema in
 * Req 6.3:
 *
 *   - {@link serializeLockoutPolicy} produces canonical JSON (keys sorted
 *     alphabetically, no extra whitespace) so byte-equal output is
 *     reproducible across runs and processes.
 *   - {@link parseLockoutPolicy} validates the payload through Zod, fills
 *     missing optional fields with the "Standard" preset defaults
 *     (Req 16.4 forward compatibility), and strips fields the schema
 *     doesn't recognise (Req 16.5) — emitting at most one
 *     `console.warn` per *unknown field name* across the lifetime of
 *     the process so a noisy import doesn't drown the log.
 *
 * For any well-formed `LockoutPolicy`, the round-trip identity holds:
 *
 *   parseLockoutPolicy(serializeLockoutPolicy(p)) deepEqual p
 *
 * (Property 5 / Req 16.3 — proven via fast-check in
 *  `__tests__/policy-codec.test.ts`).
 *
 * References: requirements §6.3, §16; design.md §6.1.
 */

// ── Notification channels (Req 6.3 `notifyChannels`) ─────────────────────

export const notificationChannelSchema = z.enum(['email', 'webhook']);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

// ── "Standard" preset defaults (Req 6.3) ─────────────────────────────────

/**
 * The "Standard" preset values from Req 6.3. Exposed as a frozen const so
 * tests and the wizard can refer to a single source of truth, and so the
 * decoder can drop any modified default back in for missing optional
 * fields.
 */
export const STANDARD_LOCKOUT_POLICY = Object.freeze({
  userMaxFailedAttempts: 5,
  userLockoutDurationSeconds: 900,
  ipMaxFailedAttempts: 20,
  ipLockoutDurationSeconds: 3600,
  lockoutWindowSeconds: 900,
  geoAnomalyEnabled: true,
  timeAnomalyEnabled: false,
  deviceAnomalyEnabled: true,
  anomalyScoreThreshold: 0.7,
  anomalyAction: 'notify_only' as const,
  notifyChannels: ['email'] as readonly NotificationChannel[],
  // Artificial delay (milliseconds) added before returning an
  // `INVALID_CREDENTIALS` response, mirroring Directus' `LOGIN_STALL_TIME`.
  // Independent of the no-enumeration timing parity (which the dummy-hash
  // verify in `auth.ts` already provides): this is a brute-force speed
  // brake that floors *every* failed-credential response at a fixed wall
  // clock, on top of rate-limiting/lockout. `0` disables the stall.
  loginStallMs: 500,
});

/**
 * Strict schema. `parseLockoutPolicy` runs the looser
 * `lockoutPolicyDecodeSchema` first (which fills defaults) and then this
 * schema enforces ranges + types per Req 6.3.
 */
export const lockoutPolicySchema = z.object({
  userMaxFailedAttempts: z.number().int().min(3).max(20),
  userLockoutDurationSeconds: z.number().int().min(60).max(86_400),
  // Req 8.2: floor of 3 enforced wizard-side too; codec mirrors it here.
  // The Req 6.3 explicit range is [5,100], so the effective floor is 5.
  ipMaxFailedAttempts: z.number().int().min(5).max(100),
  ipLockoutDurationSeconds: z.number().int().min(60).max(86_400),
  lockoutWindowSeconds: z.number().int().min(60).max(86_400),
  geoAnomalyEnabled: z.boolean(),
  timeAnomalyEnabled: z.boolean(),
  deviceAnomalyEnabled: z.boolean(),
  // Stored as a finite number with up to 2 decimal places — clamp to [0,1].
  // The "2 decimals" rule is enforced by `serializeLockoutPolicy` /
  // `parseLockoutPolicy` via `Math.round(v * 100) / 100` rather than a
  // refine on the schema, because float-precision noise makes a strict
  // refine fragile (`0.28 * 100 !== 28` on common runtimes).
  anomalyScoreThreshold: z
    .number()
    .min(0)
    .max(1)
    .refine((v) => Number.isFinite(v), { message: 'must be finite' }),
  anomalyAction: z.enum(['notify_only', 'require_mfa', 'lock']),
  notifyChannels: z.array(notificationChannelSchema).max(2),
  // Artificial login-failure delay in milliseconds (Directus parity:
  // `LOGIN_STALL_TIME`). `0` disables the stall; the 5_000ms ceiling
  // keeps a misconfigured value from turning the login route into a
  // self-inflicted DoS (a request held open for the stall still ties up
  // a connection slot).
  loginStallMs: z.number().int().min(0).max(5_000),
  // Optional webhook configuration. Only meaningful when
  // `notifyChannels` contains `'webhook'`; the codec stores the values
  // as-given without enforcing that constraint so consumers can prepare
  // a webhook config before flipping the channel on.
  webhookUrl: z.string().url().max(2048).optional(),
  webhookSecret: z.string().min(1).max(256).optional(),
});

export type LockoutPolicy = z.infer<typeof lockoutPolicySchema>;

/**
 * Decode-side schema: every required field falls back to the Standard
 * preset (Req 16.4). Optional webhook fields stay optional. Unknown
 * fields are stripped automatically by Zod's default `.strip` behaviour
 * (Req 16.5) — see `warnIfUnknownFields` for the dedup'd warn path.
 */
const lockoutPolicyDecodeSchema = z
  .object({
    userMaxFailedAttempts: z
      .number()
      .int()
      .optional()
      .default(STANDARD_LOCKOUT_POLICY.userMaxFailedAttempts),
    userLockoutDurationSeconds: z
      .number()
      .int()
      .optional()
      .default(STANDARD_LOCKOUT_POLICY.userLockoutDurationSeconds),
    ipMaxFailedAttempts: z
      .number()
      .int()
      .optional()
      .default(STANDARD_LOCKOUT_POLICY.ipMaxFailedAttempts),
    ipLockoutDurationSeconds: z
      .number()
      .int()
      .optional()
      .default(STANDARD_LOCKOUT_POLICY.ipLockoutDurationSeconds),
    lockoutWindowSeconds: z
      .number()
      .int()
      .optional()
      .default(STANDARD_LOCKOUT_POLICY.lockoutWindowSeconds),
    geoAnomalyEnabled: z
      .boolean()
      .optional()
      .default(STANDARD_LOCKOUT_POLICY.geoAnomalyEnabled),
    timeAnomalyEnabled: z
      .boolean()
      .optional()
      .default(STANDARD_LOCKOUT_POLICY.timeAnomalyEnabled),
    deviceAnomalyEnabled: z
      .boolean()
      .optional()
      .default(STANDARD_LOCKOUT_POLICY.deviceAnomalyEnabled),
    anomalyScoreThreshold: z
      .number()
      .optional()
      .default(STANDARD_LOCKOUT_POLICY.anomalyScoreThreshold),
    anomalyAction: z
      .enum(['notify_only', 'require_mfa', 'lock'])
      .optional()
      .default(STANDARD_LOCKOUT_POLICY.anomalyAction),
    notifyChannels: z
      .array(notificationChannelSchema)
      .optional()
      .default([...STANDARD_LOCKOUT_POLICY.notifyChannels]),
    loginStallMs: z
      .number()
      .int()
      .optional()
      .default(STANDARD_LOCKOUT_POLICY.loginStallMs),
    webhookUrl: z.string().url().max(2048).optional(),
    webhookSecret: z.string().min(1).max(256).optional(),
  })
  .strip();

/**
 * Stable property order used by {@link serializeLockoutPolicy}. Keeping
 * the array out-of-band (rather than relying on `Object.keys`) means
 * canonical ordering survives refactors. Optional webhook fields come
 * last in alphabetical order; serialization skips them when undefined
 * so byte output stays minimal.
 */
const CANONICAL_KEYS: ReadonlyArray<keyof LockoutPolicy> = [
  'anomalyAction',
  'anomalyScoreThreshold',
  'deviceAnomalyEnabled',
  'geoAnomalyEnabled',
  'ipLockoutDurationSeconds',
  'ipMaxFailedAttempts',
  'lockoutWindowSeconds',
  'loginStallMs',
  'notifyChannels',
  'timeAnomalyEnabled',
  'userLockoutDurationSeconds',
  'userMaxFailedAttempts',
  'webhookSecret',
  'webhookUrl',
] as const;

/**
 * Set of every property name the schema knows about. Used by
 * {@link parseLockoutPolicy} to detect unknown fields *before* they're
 * silently stripped by Zod, so we can warn once per field name.
 */
const KNOWN_FIELDS: ReadonlySet<string> = new Set<string>(CANONICAL_KEYS);

// ── unknown-field warning dedupe (Req 16.5) ─────────────────────────────

/**
 * Tracks unknown field names already warned about during this process
 * lifetime. Each name surfaces a single `console.warn` so a busy import
 * (e.g. a settings re-fetch loop) doesn't flood logs.
 */
const WARNED_UNKNOWN_FIELDS = new Set<string>();

/**
 * Test hook — clears the warning dedupe set so a single test file can
 * deterministically observe the "first time we see X" behaviour.
 */
export function __resetPolicyCodecWarningsForTests(): void {
  WARNED_UNKNOWN_FIELDS.clear();
}

function warnIfUnknownFields(raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) {
    if (KNOWN_FIELDS.has(key)) continue;
    if (WARNED_UNKNOWN_FIELDS.has(key)) continue;
    WARNED_UNKNOWN_FIELDS.add(key);
    // Use `console.warn` directly — the CMS logger middleware isn't
    // available here (this codec is also used by CLI tooling).
    // eslint-disable-next-line no-console
    console.warn(
      `[lumibase] policy-codec: ignoring unknown field "${key}" in ` +
        `lockout policy JSON (forward-compat per Req 16.5).`,
    );
  }
}

/**
 * Validation error returned by {@link parseLockoutPolicy} on type/range
 * failure (Req 16.6).
 */
export interface PolicyValidationError {
  readonly _tag: 'PolicyValidationError';
  readonly issues: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number>;
    readonly message: string;
  }>;
}

export function isPolicyValidationError(
  value: unknown,
): value is PolicyValidationError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { _tag?: unknown })._tag === 'PolicyValidationError'
  );
}

/**
 * Serialize a `LockoutPolicy` into canonical JSON.
 *
 * Properties are emitted in alphabetical key order with no extra
 * whitespace, so two calls with the same logical value produce the same
 * byte string regardless of the field order on the input object.
 * `notifyChannels` is sorted to make the output stable when the same
 * channels are provided in a different order — round-trip via
 * {@link parseLockoutPolicy} preserves the canonical order so the
 * property `parse(serialize(p)) deepEqual canonicalize(p)` holds.
 *
 * Optional `webhookUrl` / `webhookSecret` are emitted only when set,
 * keeping the canonical bytes minimal for the common no-webhook case.
 */
export function serializeLockoutPolicy(policy: LockoutPolicy): string {
  // Run through the strict schema to surface obvious mistakes early —
  // serialization should refuse to emit garbage even if the caller
  // bypassed the type system.
  const validated = lockoutPolicySchema.parse(policy);
  const ordered: Record<string, unknown> = {};
  for (const key of CANONICAL_KEYS) {
    const value = validated[key];
    if (value === undefined) continue; // skip optional/missing fields
    if (key === 'notifyChannels') {
      // Sort channels for byte-stable output regardless of input order.
      ordered[key] = [...(value as NotificationChannel[])].sort();
    } else if (key === 'anomalyScoreThreshold') {
      // Round to 2 decimal places to keep the canonical encoding stable
      // against floating point noise (e.g. 0.7 vs 0.70 vs 0.7000000001).
      ordered[key] = Math.round((value as number) * 100) / 100;
    } else {
      ordered[key] = value;
    }
  }
  return JSON.stringify(ordered);
}

/**
 * Parse a JSON string into a {@link LockoutPolicy}.
 *
 * - Missing optional fields fall back to the "Standard" preset
 *   (Req 16.4).
 * - Unknown fields are stripped silently from the result (Req 16.5).
 *   The first occurrence of each unknown field name produces a single
 *   `console.warn` for the process lifetime; further appearances stay
 *   quiet.
 * - Type/range violations are returned as a {@link PolicyValidationError}
 *   so callers can pattern-match on the result rather than catching
 *   exceptions (Req 16.6).
 */
export function parseLockoutPolicy(
  json: string,
): LockoutPolicy | PolicyValidationError {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return {
      _tag: 'PolicyValidationError',
      issues: [
        {
          path: [],
          message: `invalid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
    };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      _tag: 'PolicyValidationError',
      issues: [{ path: [], message: 'expected JSON object' }],
    };
  }

  // Surface unknown fields via warn-once dedupe before Zod silently
  // strips them.
  warnIfUnknownFields(raw as Record<string, unknown>);

  // Phase 1: fill defaults + strip unknowns.
  const filled = lockoutPolicyDecodeSchema.safeParse(raw);
  if (!filled.success) {
    return zodErrorToValidationError(filled.error);
  }

  // Normalise the threshold to 2 decimal places before strict validation,
  // matching what `serializeLockoutPolicy` writes. This keeps the
  // round-trip identity across float reps.
  const normalised = {
    ...filled.data,
    anomalyScoreThreshold:
      Math.round(filled.data.anomalyScoreThreshold * 100) / 100,
    notifyChannels: [...filled.data.notifyChannels].sort(),
  };

  // Phase 2: enforce ranges + types from Req 6.3.
  const strict = lockoutPolicySchema.safeParse(normalised);
  if (!strict.success) {
    return zodErrorToValidationError(strict.error);
  }

  // Strip optional fields whose values are undefined so downstream
  // `deepEqual` checks don't drift between "absent" and "explicitly
  // undefined".
  const result: LockoutPolicy = { ...strict.data };
  if (result.webhookUrl === undefined) delete result.webhookUrl;
  if (result.webhookSecret === undefined) delete result.webhookSecret;
  return result;
}

function zodErrorToValidationError(error: z.ZodError): PolicyValidationError {
  return {
    _tag: 'PolicyValidationError',
    issues: error.issues.map((issue) => ({
      path: issue.path.filter((p): p is string | number => typeof p === 'string' || typeof p === 'number'),
      message: issue.message,
    })),
  };
}
