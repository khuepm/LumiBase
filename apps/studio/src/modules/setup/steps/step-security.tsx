import { zodResolver } from '@hookform/resolvers/zod';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
} from 'react';
import {
  useForm,
  type FieldPath,
  type SubmitHandler,
  type UseFormReturn,
} from 'react-hook-form';
import { cn } from '@/lib/cn';
import {
  lockoutPolicySchema,
  POLICY_PRESETS,
  STANDARD_PRESET,
  type LockoutPolicyFormValues,
  type NotificationChannel,
  type PolicyPresetId,
} from '../schemas/policy';
import { useSetupStore } from '../setup-store';

/**
 * "Login Security" step of the Setup Wizard — Phase C surface only.
 *
 * Implements Req 6.1, 6.2, and the "Failed Attempts" + "Notifications"
 * portions of Req 6.3; design.md §5.5.
 *
 * Phase C scope (this task, 6.5):
 *
 *   - Preset chooser ("Standard" / "Strict" / "Lenient") that pushes
 *     the preset's values into the entire form on selection. The
 *     Standard preset is selected on initial mount (Req 6.2).
 *   - "Failed Attempts" group with the five numeric fields from Req
 *     6.3: `userMaxFailedAttempts`, `userLockoutDurationSeconds`,
 *     `ipMaxFailedAttempts`, `ipLockoutDurationSeconds`,
 *     `lockoutWindowSeconds`. Inline range validation is wired
 *     through `lockoutPolicySchema` (Req 6.3 ranges, Req 6.4).
 *   - "Notifications" group with the `notifyChannels` checkbox list
 *     (`email`, `webhook`) and a conditional `webhookUrl` /
 *     `webhookSecret` pair that appears only when the `webhook`
 *     channel is ticked.
 *
 * Phase D scope (deferred to task 8.3): the "Geographic Anomaly",
 * "Time Anomaly", "Device Anomaly", and "Anomaly Action" groups, plus
 * the GeoIP capability warning. Until task 8.3 lands, those fields
 * stay invisible in the UI but are still part of the form's value
 * shape — the preset chooser populates them on every selection so
 * `lockoutPolicySchema` always sees a complete object on submit, the
 * `useCompleteSetup` mutation gets a full policy, and task 8.3 can
 * surface them without a schema change.
 *
 * On a passing submit, the values are mirrored into a session-only
 * in-memory draft (see `getPolicyDraft` below) and the wizard's
 * `policyValid` flag flips to `true` so the deep-link guard for the
 * next step opens (design §11.2). Any later edit that breaks
 * validation flips `policyValid` back to false so navigation guards
 * remain accurate.
 *
 * What this file deliberately does NOT do:
 *
 *   - It does not navigate to `/setup/recovery` after submit. Routes
 *     are wired in task 6.6; the parent shell drives navigation via
 *     the `onSubmitted` callback.
 *   - It does not call any backend. The `/setup/complete` POST is
 *     orchestrated later by `useCompleteSetup` from the Recovery
 *     step (task 10.3 / 10.4). This step only collects + validates
 *     locally.
 *   - It does not localize copy. Strings stay inline; the matching
 *     i18n keys already live under `setup.steps.security.*` in the
 *     locale bundles (task 3.10) and a follow-up swap will reach
 *     them without changing the schema or form shape.
 *
 * Spec refs: requirements §6.1, §6.2, §6.3 (Failed Attempts +
 * Notifications); design.md §5.5.
 */

// ────────────────────────────────────────────────────────────────────────
// In-memory policy draft
//
// Mirrors the pattern from `step-account.tsx` and `step-path.tsx`: the
// persisted Zustand store deliberately holds only validity flags + the
// post-completion `adminPath`, so we cache the chosen policy values
// here in module memory until `useCompleteSetup` (task 6.5 consumer)
// flushes them to `POST /api/v1/setup/complete`. Living only in heap
// means a refresh resets the wizard cleanly without ever touching
// `sessionStorage`.
//
// We hold the FULL `LockoutPolicyFormValues` shape (Phase C visible
// fields + Phase D defaults from the chosen preset) so the recovery
// step can submit a complete policy without having to know which
// fields are exposed yet.
// ────────────────────────────────────────────────────────────────────────

let policyDraft: LockoutPolicyFormValues | null = null;

/** Read the in-memory policy draft, or `null` if not yet captured. */
export function getPolicyDraft(): LockoutPolicyFormValues | null {
  return policyDraft;
}

/** Drop the draft. Call after `POST /setup/complete` succeeds. */
export function clearPolicyDraft(): void {
  policyDraft = null;
}

function setPolicyDraftInternal(value: LockoutPolicyFormValues): void {
  policyDraft = value;
}

// ────────────────────────────────────────────────────────────────────────
// Form values type
// ────────────────────────────────────────────────────────────────────────

/**
 * The form holds the full lockout policy shape inferred from
 * `lockoutPolicySchema`. We re-export the type alias so the rest of
 * this file can stay short.
 */
type SecurityFormValues = LockoutPolicyFormValues;

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Tuple type the Zod schema infers for `notifyChannels` — non-empty
 * by construction. Cast helper used in places where TypeScript can't
 * statically prove that a `.length >= 1` array is the tuple form
 * (e.g. result of `Array.from(new Set(...))` in the channel toggle
 * handler, or spreading the preset's `NotificationChannel[]`).
 */
type NonEmptyChannels = [NotificationChannel, ...NotificationChannel[]];

/**
 * Build the form's `defaultValues` from a preset + an optional
 * draft. When a draft exists (the operator has previously submitted
 * the step in this tab) we use it so the form mounts with their
 * choices intact; otherwise we mount with the Standard preset (Req
 * 6.2).
 *
 * Note: `webhookUrl` / `webhookSecret` are intentionally omitted from
 * the presets — they only become meaningful when the operator picks
 * the `'webhook'` channel. We default them to empty strings here so
 * the controlled inputs render without a `value: undefined` warning.
 *
 * Exported so unit tests can pin the preset → form-values mapping
 * without spinning up React.
 */
export function buildDefaultValues(
  preset: PolicyPresetId,
  draft: SecurityFormValues | null,
): SecurityFormValues {
  if (draft !== null) return draft;
  const base = POLICY_PRESETS[preset];
  // Every preset in `POLICY_PRESETS` has at least one notification
  // channel by construction, so the tuple cast below is safe. The
  // schema's runtime `nonempty` check still applies on submit so a
  // future preset that ever ships with `[]` would surface a
  // validation error rather than a silent type lie.
  return {
    userMaxFailedAttempts: base.userMaxFailedAttempts,
    userLockoutDurationSeconds: base.userLockoutDurationSeconds,
    ipMaxFailedAttempts: base.ipMaxFailedAttempts,
    ipLockoutDurationSeconds: base.ipLockoutDurationSeconds,
    lockoutWindowSeconds: base.lockoutWindowSeconds,
    geoAnomalyEnabled: base.geoAnomalyEnabled,
    timeAnomalyEnabled: base.timeAnomalyEnabled,
    deviceAnomalyEnabled: base.deviceAnomalyEnabled,
    anomalyScoreThreshold: base.anomalyScoreThreshold,
    anomalyAction: base.anomalyAction,
    notifyChannels: [...base.notifyChannels] as NonEmptyChannels,
  };
}

/**
 * Restoring the preset selection on remount: when the form mounts
 * from a saved draft we don't know which preset id the operator
 * picked last time, only the resulting field values. This helper
 * compares the draft against each preset's value table and returns
 * the matching id, or `null` when the draft has been customised
 * away from any preset. Used only to highlight the active preset
 * card in the chooser; the form values themselves come from the
 * draft regardless.
 *
 * Exported so unit tests can pin the inverse mapping (preset →
 * preset id) without spinning up React.
 */
export function inferActivePreset(
  values: SecurityFormValues,
): PolicyPresetId | null {
  const ids: PolicyPresetId[] = ['standard', 'strict', 'lenient'];
  for (const id of ids) {
    const preset = POLICY_PRESETS[id];
    if (
      values.userMaxFailedAttempts === preset.userMaxFailedAttempts &&
      values.userLockoutDurationSeconds ===
      preset.userLockoutDurationSeconds &&
      values.ipMaxFailedAttempts === preset.ipMaxFailedAttempts &&
      values.ipLockoutDurationSeconds === preset.ipLockoutDurationSeconds &&
      values.lockoutWindowSeconds === preset.lockoutWindowSeconds &&
      values.geoAnomalyEnabled === preset.geoAnomalyEnabled &&
      values.timeAnomalyEnabled === preset.timeAnomalyEnabled &&
      values.deviceAnomalyEnabled === preset.deviceAnomalyEnabled &&
      values.anomalyScoreThreshold === preset.anomalyScoreThreshold &&
      values.anomalyAction === preset.anomalyAction &&
      values.notifyChannels.length === preset.notifyChannels.length &&
      preset.notifyChannels.every((c) =>
        (values.notifyChannels as NotificationChannel[]).includes(c),
      )
    ) {
      return id;
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

export interface StepSecurityProps {
  /**
   * Optional callback invoked after the form passes validation and
   * the draft + store flag have been updated. Routes in task 6.6 use
   * it to navigate to the next wizard step (Phase D adds the rest of
   * StepSecurity, then `/setup/recovery`).
   */
  onSubmitted?: (values: SecurityFormValues) => void;
}

export function StepSecurity({ onSubmitted }: StepSecurityProps) {
  const setPolicyValid = useSetupStore((s) => s.setPolicyValid);

  // ── Preset state ───────────────────────────────────────────────────
  // The chooser maintains its own UI state separate from the form
  // values: a draft might not match any preset exactly, in which case
  // the chooser shows no card highlighted but the form still renders
  // the saved values. On a fresh mount with no draft we default to
  // 'standard' (Req 6.2).
  const initialPreset: PolicyPresetId = useMemo(() => {
    if (policyDraft === null) return 'standard';
    return inferActivePreset(policyDraft) ?? 'standard';
  }, []);

  const form = useForm<SecurityFormValues>({
    resolver: zodResolver(lockoutPolicySchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    shouldUnregister: false,
    defaultValues: buildDefaultValues(initialPreset, policyDraft),
  });

  const {
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting, isValid },
  } = form;

  // Pull values that drive conditional UI. `notifyChannels` toggles
  // the webhook URL/secret pair; the preset chooser highlight
  // recomputes whenever any field changes.
  const allValues = watch();
  const channels: NotificationChannel[] =
    (allValues.notifyChannels as NotificationChannel[] | undefined) ?? [];
  const webhookSelected = channels.includes('webhook');

  // ── Preset card highlight ─────────────────────────────────────────
  // We compute this every render rather than memoising on every field
  // because the comparison is cheap (≤11 primitive equalities) and the
  // dependency surface for `useMemo` would basically be the entire
  // form value object.
  const activePreset: PolicyPresetId | null = inferActivePreset(allValues);

  const handlePresetSelect = useCallback(
    (id: PolicyPresetId) => {
      // Apply preset values via `reset` so React Hook Form knows about
      // every field change and dirties them all in one shot. We
      // preserve `webhookUrl` / `webhookSecret` since presets don't
      // define them — wiping the operator's typed-in values just
      // because they clicked a preset would be hostile UX.
      const preset = POLICY_PRESETS[id];
      reset(
        {
          userMaxFailedAttempts: preset.userMaxFailedAttempts,
          userLockoutDurationSeconds: preset.userLockoutDurationSeconds,
          ipMaxFailedAttempts: preset.ipMaxFailedAttempts,
          ipLockoutDurationSeconds: preset.ipLockoutDurationSeconds,
          lockoutWindowSeconds: preset.lockoutWindowSeconds,
          geoAnomalyEnabled: preset.geoAnomalyEnabled,
          timeAnomalyEnabled: preset.timeAnomalyEnabled,
          deviceAnomalyEnabled: preset.deviceAnomalyEnabled,
          anomalyScoreThreshold: preset.anomalyScoreThreshold,
          anomalyAction: preset.anomalyAction,
          notifyChannels: [...preset.notifyChannels] as NonEmptyChannels,
          webhookUrl: allValues.webhookUrl,
          webhookSecret: allValues.webhookSecret,
        },
        { keepErrors: false, keepDirty: false, keepTouched: false },
      );
    },
    [reset, allValues.webhookUrl, allValues.webhookSecret],
  );

  // Whenever the form drops out of "valid" flip the wizard's
  // `policyValid` flag back to false so the deep-link guard on the
  // next step bounces back here. Only flip TO true on a successful
  // submit (in `onSubmit`), so editing the form between submits doesn't
  // accidentally re-open the next step.
  useEffect(() => {
    if (!isValid) setPolicyValid(false);
  }, [isValid, setPolicyValid]);

  const onSubmit: SubmitHandler<SecurityFormValues> = useCallback(
    (values) => {
      // The resolver-transformed value is what we want to persist.
      setPolicyDraftInternal(values);
      setPolicyValid(true);
      onSubmitted?.(values);
    },
    [onSubmitted, setPolicyValid],
  );

  const submitDisabled = isSubmitting || !isValid;

  return (
    <form
      noValidate
      className="space-y-6"
      onSubmit={handleSubmit(onSubmit)}
      aria-labelledby="setup-step-heading"
    >
      <header className="space-y-1">
        <h2
          id="setup-step-heading"
          className="text-lg font-semibold tracking-tight"
        >
          Configure login security
        </h2>
        <p className="text-sm text-muted-foreground">
          Set thresholds for failed login attempts and choose how to be
          notified about security events.
        </p>
      </header>

      {/* ── Preset chooser ────────────────────────────────────────── */}
      <PresetChooser
        active={activePreset}
        onSelect={handlePresetSelect}
      />

      {/* ── Failed Attempts ───────────────────────────────────────── */}
      <FailedAttemptsGroup form={form} errors={errors} />

      {/* ── Notifications ─────────────────────────────────────────── */}
      <NotificationsGroup
        form={form}
        errors={errors}
        channels={channels}
        webhookSelected={webhookSelected}
      />

      {/* ── Submit ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="submit"
          disabled={submitDisabled}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Continue
        </button>
      </div>
    </form>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Preset chooser
// ────────────────────────────────────────────────────────────────────────

interface PresetChooserProps {
  active: PolicyPresetId | null;
  onSelect: (id: PolicyPresetId) => void;
}

interface PresetOption {
  id: PolicyPresetId;
  label: string;
  description: string;
}

const PRESET_OPTIONS: ReadonlyArray<PresetOption> = [
  {
    id: 'standard',
    label: 'Standard',
    description: 'Balanced defaults suitable for most teams.',
  },
  {
    id: 'strict',
    label: 'Strict',
    description: 'Lower thresholds and longer lockouts.',
  },
  {
    id: 'lenient',
    label: 'Lenient',
    description: 'Higher thresholds for low-risk environments.',
  },
];

/**
 * Three-card radio group. Implemented as native `<input type="radio">`
 * elements wrapped in styled labels so screen readers and keyboard
 * users get the standard radio semantics for free; we only repaint
 * the chrome.
 */
function PresetChooser({ active, onSelect }: PresetChooserProps) {
  const groupId = useId();
  return (
    <fieldset
      className="space-y-2"
      aria-describedby={`${groupId}-help`}
    >
      <legend className="text-sm font-medium text-foreground">
        Preset
      </legend>
      <p id={`${groupId}-help`} className="text-xs text-muted-foreground">
        Apply default values to every group below. You can fine-tune
        after picking a preset.
      </p>
      <div
        className="grid gap-3 sm:grid-cols-3"
        role="radiogroup"
        aria-label="Lockout policy preset"
      >
        {PRESET_OPTIONS.map((option) => {
          const inputId = `${groupId}-${option.id}`;
          const isActive = active === option.id;
          return (
            <label
              key={option.id}
              htmlFor={inputId}
              className={cn(
                'flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition',
                isActive
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                  : 'border-border bg-background hover:bg-muted/40',
              )}
            >
              <span className="flex items-center gap-2">
                <input
                  id={inputId}
                  type="radio"
                  name={`${groupId}-preset`}
                  className="h-4 w-4 border-border text-primary focus:ring-2 focus:ring-primary/30"
                  checked={isActive}
                  onChange={() => onSelect(option.id)}
                />
                <span className="font-medium text-foreground">
                  {option.label}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">
                {option.description}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Failed Attempts group
// ────────────────────────────────────────────────────────────────────────

interface FailedAttemptsGroupProps {
  form: UseFormReturn<SecurityFormValues>;
  errors: UseFormReturn<SecurityFormValues>['formState']['errors'];
}

interface FailedAttemptsField {
  name: FieldPath<SecurityFormValues>;
  label: string;
  help: string;
  min: number;
  max: number;
}

const FAILED_ATTEMPTS_FIELDS: ReadonlyArray<FailedAttemptsField> = [
  {
    name: 'userMaxFailedAttempts',
    label: 'Per-user max attempts',
    help: 'Lock a user after this many failed attempts within the window.',
    min: 3,
    max: 20,
  },
  {
    name: 'userLockoutDurationSeconds',
    label: 'User lockout duration (seconds)',
    help: 'How long to keep a user locked.',
    min: 60,
    max: 86_400,
  },
  {
    name: 'ipMaxFailedAttempts',
    label: 'Per-IP max attempts',
    help: 'Block an IP after this many failed attempts within the window.',
    min: 5,
    max: 100,
  },
  {
    name: 'ipLockoutDurationSeconds',
    label: 'IP lockout duration (seconds)',
    help: 'How long to keep an IP blocked.',
    min: 60,
    max: 86_400,
  },
  {
    name: 'lockoutWindowSeconds',
    label: 'Sliding window (seconds)',
    help: 'Counter window for tallying failed attempts.',
    min: 60,
    max: 86_400,
  },
];

function FailedAttemptsGroup({ form, errors }: FailedAttemptsGroupProps) {
  const { register } = form;
  return (
    <fieldset className="space-y-4 rounded-md border border-border p-4">
      <legend className="px-1 text-sm font-semibold text-foreground">
        Failed Attempts
      </legend>
      <p className="-mt-2 text-xs text-muted-foreground">
        How many failed sign-ins to tolerate before locking a user or
        blocking an IP.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        {FAILED_ATTEMPTS_FIELDS.map((field) => (
          <NumberField
            key={field.name}
            label={field.label}
            help={`${field.help} Range ${field.min}–${field.max}.`}
            min={field.min}
            max={field.max}
            error={
              (errors[field.name as keyof SecurityFormValues] as
                | { message?: string }
                | undefined)?.message
            }
            // `valueAsNumber` makes RHF coerce the empty/non-numeric
            // input to `NaN` rather than `''` — Zod then surfaces the
            // expected error instead of a confusing "expected number,
            // got string" mismatch on first edit.
            registerProps={register(field.name, { valueAsNumber: true })}
          />
        ))}
      </div>
    </fieldset>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Notifications group
// ────────────────────────────────────────────────────────────────────────

interface NotificationsGroupProps {
  form: UseFormReturn<SecurityFormValues>;
  errors: UseFormReturn<SecurityFormValues>['formState']['errors'];
  channels: NotificationChannel[];
  webhookSelected: boolean;
}

const NOTIFICATION_CHANNELS: ReadonlyArray<{
  id: NotificationChannel;
  label: string;
}> = [
    { id: 'email', label: 'Email' },
    { id: 'webhook', label: 'Webhook' },
  ];

function NotificationsGroup({
  form,
  errors,
  channels,
  webhookSelected,
}: NotificationsGroupProps) {
  const { register, setValue, trigger } = form;
  const groupId = useId();
  const channelsErrorId = `${groupId}-channels-error`;

  const channelsError =
    (errors.notifyChannels as { message?: string } | undefined)?.message;

  const handleToggleChannel = useCallback(
    (channel: NotificationChannel, checked: boolean) => {
      // RHF doesn't ship a first-class array-of-strings checkbox group,
      // so we maintain the value via `setValue`. The schema's
      // `superRefine` only runs after the form value updates, so we
      // explicitly re-trigger validation on the dependent webhook
      // fields (and the channels array itself) so any cross-field
      // error clears immediately when the operator unticks `webhook`.
      const next = checked
        ? Array.from(new Set([...channels, channel]))
        : channels.filter((c) => c !== channel);
      // The schema's `nonempty` runtime check produces an inline error
      // when `next.length === 0` — that's the desired UX, the operator
      // sees "Select at least one notification channel." rather than
      // having the unchecked state silently rejected. We cast through
      // `unknown` because RHF's setValue wants the tuple form, but at
      // this point we deliberately may hand it an empty array so the
      // resolver can surface the friendly error.
      setValue(
        'notifyChannels',
        next as unknown as NonEmptyChannels,
        {
          shouldValidate: true,
          shouldDirty: true,
          shouldTouch: true,
        },
      );
      void trigger(['notifyChannels', 'webhookUrl', 'webhookSecret']);
    },
    [channels, setValue, trigger],
  );

  return (
    <fieldset className="space-y-4 rounded-md border border-border p-4">
      <legend className="px-1 text-sm font-semibold text-foreground">
        Notifications
      </legend>
      <p className="-mt-2 text-xs text-muted-foreground">
        Where to send security event notifications. At least one channel
        must be selected.
      </p>

      {/* ── Channel checkboxes ────────────────────────────────────── */}
      <div
        role="group"
        aria-label="Notification channels"
        aria-describedby={channelsError ? channelsErrorId : undefined}
        className="space-y-2"
      >
        {NOTIFICATION_CHANNELS.map((option) => {
          const inputId = `${groupId}-channel-${option.id}`;
          const checked = channels.includes(option.id);
          return (
            <label
              key={option.id}
              htmlFor={inputId}
              className="flex items-center gap-3 text-sm"
            >
              <input
                id={inputId}
                type="checkbox"
                className="h-4 w-4 rounded border-border text-primary focus:ring-2 focus:ring-primary/30"
                checked={checked}
                onChange={(e) =>
                  handleToggleChannel(option.id, e.target.checked)
                }
              />
              <span className="text-foreground">{option.label}</span>
            </label>
          );
        })}
        {channelsError ? (
          <p
            id={channelsErrorId}
            role="alert"
            className="text-xs text-red-600"
          >
            {channelsError}
          </p>
        ) : null}
      </div>

      {/* ── Conditional webhook fields ────────────────────────────── */}
      {webhookSelected ? (
        <div className="space-y-4 rounded-md border border-dashed border-border bg-muted/20 p-3">
          <TextField
            label="Webhook URL"
            help="HTTPS endpoint that will receive security event POSTs."
            placeholder="https://example.com/lumibase/security"
            error={
              (errors.webhookUrl as { message?: string } | undefined)
                ?.message
            }
            registerProps={register('webhookUrl')}
            type="url"
            autoComplete="off"
          />
          <TextField
            label="Webhook secret"
            help="Used to sign webhook payloads with HMAC-SHA256. Keep this safe."
            error={
              (errors.webhookSecret as { message?: string } | undefined)
                ?.message
            }
            registerProps={register('webhookSecret')}
            type="password"
            autoComplete="off"
          />
        </div>
      ) : null}
    </fieldset>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────

interface NumberFieldProps {
  label: string;
  help: string;
  min: number;
  max: number;
  error?: string;
  registerProps: ReturnType<UseFormReturn<SecurityFormValues>['register']>;
}

/**
 * Numeric input with inline range validation feedback. The actual
 * validation lives in `lockoutPolicySchema`; we just render whatever
 * message the resolver surfaces for this field. `min` / `max` on the
 * native input give browser-level UX (spinner clamping) but never
 * replace the schema's authoritative check (Req 6.4).
 */
function NumberField({
  label,
  help,
  min,
  max,
  error,
  registerProps,
}: NumberFieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="block text-sm font-medium text-foreground"
      >
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={[helpId, error ? errorId : null]
          .filter(Boolean)
          .join(' ')}
        className={inputClass(Boolean(error))}
        {...registerProps}
      />
      <p id={helpId} className="text-xs text-muted-foreground">
        {help}
      </p>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface TextFieldProps {
  label: string;
  help?: string;
  placeholder?: string;
  type?: 'text' | 'url' | 'password';
  autoComplete?: string;
  error?: string;
  registerProps: ReturnType<UseFormReturn<SecurityFormValues>['register']>;
}

function TextField({
  label,
  help,
  placeholder,
  type = 'text',
  autoComplete,
  error,
  registerProps,
}: TextFieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="block text-sm font-medium text-foreground"
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={[help ? helpId : null, error ? errorId : null]
          .filter(Boolean)
          .join(' ') || undefined}
        className={inputClass(Boolean(error))}
        {...registerProps}
      />
      {help ? (
        <p id={helpId} className="text-xs text-muted-foreground">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Styling helper
// ────────────────────────────────────────────────────────────────────────

function inputClass(hasError: boolean, extra = ''): string {
  const base =
    'block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-primary/30';
  const border = hasError
    ? 'border-red-500 focus:border-red-500 focus:ring-red-500/30'
    : 'border-border focus:border-primary';
  return `${base} ${border} ${extra}`.trim();
}

export default StepSecurity;

// Re-export the constant for consumers of the same preset table (e.g.
// the recovery step's review summary in task 10.3) so they don't have
// to reach into the schema module directly.
export { STANDARD_PRESET };
