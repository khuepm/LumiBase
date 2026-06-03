import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useId } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { z } from 'zod';
import { joinAdminPathLogin } from '../setup/steps/step-done';
import {
  evaluatePasswordRules,
  PASSWORD_MIN_LENGTH,
  PASSWORD_SPECIAL_CHARS,
  type PasswordRuleId,
} from '../setup/schemas/account';

/**
 * "Backup code recovery" page — PUBLIC, pre-auth recovery UI.
 *
 * Implements Req 14.4 and design.md §5.1 (the `/recovery/*` routes under
 * `publicLayoutRoute`). This is the operator-facing counterpart to the
 * CMS endpoint built in task 10.7:
 *
 *   POST /api/v1/admin/security/recover
 *     body { email, backupCode }
 *     → 200 { data: { adminPath, oneTimeUnlockToken } }
 *     → 401 { errors: [{ code: 'INVALID_BACKUP_CODE' }] }   (generic)
 *     → 429 { errors: [{ code: 'RATE_LIMITED' }] } + Retry-After header
 *
 * ── Anti-enumeration parity with the server (Req 14.4) ───────────────
 *
 * The CMS collapses EVERY failure branch (unknown email, non-bootstrap
 * account, no matching code, internal error) into a single generic 401
 * `INVALID_BACKUP_CODE` after a uniform random delay. This page mirrors
 * that on the client: a 401 renders ONE generic message ("That email and
 * backup code didn't match…") and NEVER attributes the failure to a
 * specific field — doing otherwise would re-introduce the email-exists
 * signal the server works to suppress.
 *
 * ── On success ───────────────────────────────────────────────────────
 *
 * The 200 body carries:
 *   - `adminPath`         — the secret Studio path the operator likely
 *                           lost; we surface it prominently with a link
 *                           to `${adminPath}/login` so they can navigate
 *                           back in.
 *   - `oneTimeUnlockToken`— a 15-minute single-use credential that lets
 *                           them through the active lockout. How it's
 *                           consumed end-to-end is a later concern; we
 *                           display it (with a note on its nature) so the
 *                           flow is usable today.
 *
 * The login link is a PLAIN `<a href>` (NOT a TanStack `<Link>`) — same
 * rationale as `step-done.tsx`: we want a full document load so the admin
 * path guard middleware (task 4.2) and the authenticated AppShell route
 * tree engage fresh, rather than an in-memory SPA route swap that the
 * public layout doesn't know about. We reuse the exported
 * `joinAdminPathLogin` helper from the Done step so the `${adminPath}/login`
 * join logic stays in one place.
 *
 * ── Accessibility ────────────────────────────────────────────────────
 *
 *   - `useId()`-driven label/error wiring; `<label htmlFor>` per input.
 *   - `aria-invalid` + `aria-describedby` on each field for inline
 *     client-validation errors.
 *   - The server-error banner is `role="alert"` so it's announced when
 *     it appears.
 *   - A link to `/recovery/forgot-path` for operators who lost the admin
 *     path itself (not just access).
 *
 * ── i18n ─────────────────────────────────────────────────────────────
 *
 * Copy is inline English, matching the deliberate convention of the
 * setup steps (`step-account.tsx` etc.): the Studio's i18n is
 * backend-fetched via `react-i18next`, and a swap to keys under
 * `recovery.backupCode.*` (design §5.6) is a tracked follow-up. We do
 * NOT block this page on wiring backend i18n.
 *
 * Spec refs: requirements §14.4; design.md §5.1 (route tree), §4.7
 * (endpoint contract), §5.6 (i18n keys — follow-up).
 */

// ────────────────────────────────────────────────────────────────────────
// Form schema
// ────────────────────────────────────────────────────────────────────────

/**
 * Client-side schema. We keep validation deliberately light — the server
 * is authoritative on the `XXXX-XXXX` backup-code format, so we only
 * require a non-empty string here (over-validating the shape would just
 * give an attacker a free oracle on the format). Email gets a basic RFC
 * check so an obvious typo is caught before a network round-trip.
 */
const backupCodeSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  backupCode: z.string().min(1, 'Enter one of your backup codes.'),
});

type BackupCodeFormValues = z.infer<typeof backupCodeSchema>;

const resetPasswordSchema = z
  .object({
    password: z.string(),
    confirmPassword: z.string(),
  })
  .superRefine((value, ctx) => {
    const rules = evaluatePasswordRules(value.password);
    for (const [rule, ok] of Object.entries(rules) as Array<[PasswordRuleId, boolean]>) {
      if (!ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: passwordRuleLabel(rule),
          path: ['password'],
          params: { rule },
        });
      }
    }
    if (value.password !== value.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Passwords do not match.',
        path: ['confirmPassword'],
      });
    }
  });

type ResetPasswordFormValues = z.infer<typeof resetPasswordSchema>;

// ────────────────────────────────────────────────────────────────────────
// Recovery request + result types
// ────────────────────────────────────────────────────────────────────────

/** Shape of the 200 `data` envelope from `POST /admin/security/recover`. */
export interface RecoverSuccess {
  adminPath: string;
  oneTimeUnlockToken: string;
}

/**
 * Normalized recovery error codes. Mirrors the server's error envelope
 * (`INVALID_BACKUP_CODE`, `RATE_LIMITED`) plus a `VALIDATION_ERROR` /
 * `UNKNOWN` bucket for malformed requests and unexpected responses.
 */
export type RecoverErrorCode =
  | 'INVALID_BACKUP_CODE'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN';

/**
 * Error subtype the mutation throws on any non-200 response. `retryAfterSeconds`
 * is populated from the `Retry-After` header on a 429 when present.
 */
export class RecoverError extends Error {
  readonly code: RecoverErrorCode;
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: RecoverErrorCode,
    message: string,
    status: number | undefined,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'RecoverError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class ResetPasswordError extends Error {
  readonly code: 'INVALID_RECOVERY_TOKEN' | 'RATE_LIMITED' | 'VALIDATION_ERROR' | 'UNKNOWN';
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ResetPasswordError['code'],
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ResetPasswordError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Parse the `Retry-After` header into whole seconds. The header may be a
 * delta-seconds integer (the form our CMS emits) or an HTTP-date; we
 * handle the integer form and fall back to `undefined` for anything we
 * can't read as a positive number, so the UI degrades to a generic
 * "try again later" message rather than rendering NaN.
 */
export function parseRetryAfterSeconds(
  header: string | null,
): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  const asInt = Number(trimmed);
  if (Number.isFinite(asInt) && asInt >= 0) {
    return Math.ceil(asInt);
  }
  // HTTP-date form: compute the delta from now. Defensive — our server
  // emits delta-seconds, but a proxy could rewrite it.
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const deltaMs = asDate - Date.now();
    return deltaMs > 0 ? Math.ceil(deltaMs / 1000) : 0;
  }
  return undefined;
}

/** Project-standard error envelope (loose — `code` may be absent). */
interface ErrorEnvelope {
  errors?: Array<{ code?: string; message?: string }>;
}

function firstErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const envelope = body as ErrorEnvelope;
  if (!Array.isArray(envelope.errors)) return undefined;
  return envelope.errors[0]?.code;
}

/**
 * POST the recover request and map the response to a typed result.
 * Mirrors the fetch conventions in `use-complete-setup.ts`
 * (`credentials: 'same-origin'`, JSON content + accept headers).
 */
async function postRecover(
  values: BackupCodeFormValues,
): Promise<RecoverSuccess> {
  let response: Response;
  try {
    response = await fetch('/api/v1/admin/security/recover', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        email: values.email,
        backupCode: values.backupCode,
      }),
    });
  } catch {
    throw new RecoverError(
      'UNKNOWN',
      'Network error while contacting the server.',
      undefined,
    );
  }

  if (response.status === 200) {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new RecoverError(
        'UNKNOWN',
        'The server response could not be parsed.',
        200,
      );
    }
    const data = (parsed as { data?: Partial<RecoverSuccess> })?.data;
    if (
      !data ||
      typeof data.adminPath !== 'string' ||
      typeof data.oneTimeUnlockToken !== 'string'
    ) {
      throw new RecoverError(
        'UNKNOWN',
        'The server response was missing recovery details.',
        200,
      );
    }
    return {
      adminPath: data.adminPath,
      oneTimeUnlockToken: data.oneTimeUnlockToken,
    };
  }

  // Non-200 — classify against the documented contract.
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.status === 401) {
    // Generic — the server already refuses to say which field was wrong.
    throw new RecoverError(
      'INVALID_BACKUP_CODE',
      'That email and backup code didn’t match.',
      401,
    );
  }

  if (response.status === 429) {
    const retryAfter = parseRetryAfterSeconds(
      response.headers.get('Retry-After'),
    );
    throw new RecoverError(
      'RATE_LIMITED',
      'Too many recovery attempts.',
      429,
      retryAfter,
    );
  }

  if (response.status === 400) {
    throw new RecoverError(
      'VALIDATION_ERROR',
      'The recovery request was rejected as invalid.',
      400,
    );
  }

  const code = firstErrorCode(body);
  throw new RecoverError(
    code === 'RATE_LIMITED'
      ? 'RATE_LIMITED'
      : code === 'INVALID_BACKUP_CODE'
        ? 'INVALID_BACKUP_CODE'
        : 'UNKNOWN',
    `Recovery failed with an unexpected response (HTTP ${response.status}).`,
    response.status,
  );
}

async function postResetPassword(args: {
  unlockToken: string;
  password: string;
}): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/v1/admin/security/reset-password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(args),
    });
  } catch {
    throw new ResetPasswordError('UNKNOWN', 'Network error while resetting password.');
  }

  if (response.status === 200) return;

  if (response.status === 401) {
    throw new ResetPasswordError(
      'INVALID_RECOVERY_TOKEN',
      'This recovery session expired or was already used.',
    );
  }

  if (response.status === 429) {
    throw new ResetPasswordError(
      'RATE_LIMITED',
      'Too many recovery attempts.',
      parseRetryAfterSeconds(response.headers.get('Retry-After')),
    );
  }

  if (response.status === 400) {
    throw new ResetPasswordError(
      'VALIDATION_ERROR',
      'Choose a stronger password.',
    );
  }

  throw new ResetPasswordError(
    'UNKNOWN',
    `Password reset failed with an unexpected response (HTTP ${response.status}).`,
  );
}

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

export function BackupCodePage() {
  const emailId = useId();
  const codeId = useId();
  const bannerId = useId();

  const form = useForm<BackupCodeFormValues>({
    resolver: zodResolver(backupCodeSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { email: '', backupCode: '' },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form;

  const mutation = useMutation<RecoverSuccess, RecoverError, BackupCodeFormValues>(
    {
      mutationKey: ['recovery', 'backup-code'],
      mutationFn: postRecover,
      retry: false,
    },
  );

  const onSubmit: SubmitHandler<BackupCodeFormValues> = (values) => {
    mutation.mutate(values);
  };

  // On success, swap the form out for a success panel that surfaces the
  // recovered admin path + unlock token.
  if (mutation.isSuccess) {
    return <RecoverySuccessPanel result={mutation.data} />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md rounded-xl border bg-background p-8 shadow-sm">
        <form noValidate className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <header className="space-y-2">
            <div className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" aria-hidden="true" />
              <h1 className="text-lg font-semibold tracking-tight">
                Recover with a backup code
              </h1>
            </div>
            <p className="text-sm text-muted-foreground">
              Enter the admin email and one of the backup codes you saved
              during setup. We&rsquo;ll clear the lockout and show you your
              admin path.
            </p>
          </header>

          {/* ── Server error banner (generic, anti-enumeration) ──────── */}
          {mutation.isError ? (
            <ServerErrorBanner id={bannerId} error={mutation.error} />
          ) : null}

          {/* ── Email ────────────────────────────────────────────────── */}
          <Field id={emailId} label="Admin email" error={errors.email?.message}>
            <input
              id={emailId}
              type="email"
              inputMode="email"
              autoComplete="username"
              spellCheck={false}
              aria-invalid={errors.email ? 'true' : 'false'}
              aria-describedby={errors.email ? `${emailId}-error` : undefined}
              className={inputClass(Boolean(errors.email))}
              {...register('email')}
            />
          </Field>

          {/* ── Backup code ──────────────────────────────────────────── */}
          <Field id={codeId} label="Backup code" error={errors.backupCode?.message}>
            <input
              id={codeId}
              type="text"
              inputMode="text"
              autoComplete="one-time-code"
              spellCheck={false}
              placeholder="XXXX-XXXX"
              aria-invalid={errors.backupCode ? 'true' : 'false'}
              aria-describedby={errors.backupCode ? `${codeId}-error` : undefined}
              className={`${inputClass(Boolean(errors.backupCode))} font-mono tracking-wider`}
              {...register('backupCode')}
            />
          </Field>

          {/* ── Submit ───────────────────────────────────────────────── */}
          <button
            type="submit"
            disabled={isSubmitting || mutation.isPending}
            className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mutation.isPending ? 'Checking…' : 'Recover access'}
          </button>

          {/* ── Lost-the-path link ───────────────────────────────────── */}
          <p className="text-center text-sm text-muted-foreground">
            Lost your admin path?{' '}
            <a
              href="forgot-path"
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              Recover it by email
            </a>
            .
          </p>
        </form>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────

interface ServerErrorBannerProps {
  id: string;
  error: RecoverError;
}

/**
 * Top-of-form error banner. Renders generic copy keyed off the
 * normalized error `code`:
 *
 *   - INVALID_BACKUP_CODE → generic "email and code didn't match" (never
 *     attributes the failure to a single field — anti-enumeration).
 *   - RATE_LIMITED        → "too many attempts" + the wait when the
 *     `Retry-After` header was present.
 *   - everything else     → a neutral try-again message.
 */
function ServerErrorBanner({ id, error }: ServerErrorBannerProps) {
  let message: string;
  switch (error.code) {
    case 'INVALID_BACKUP_CODE':
      message =
        'That email and backup code didn’t match. Check them and try again.';
      break;
    case 'RATE_LIMITED':
      message =
        error.retryAfterSeconds !== undefined
          ? `Too many recovery attempts. Try again in about ${formatWait(
            error.retryAfterSeconds,
          )}.`
          : 'Too many recovery attempts. Try again later.';
      break;
    default:
      message =
        'We couldn’t complete recovery right now. Check your connection and try again.';
      break;
  }

  return (
    <div
      id={id}
      role="alert"
      className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200"
    >
      {message}
    </div>
  );
}

interface RecoverySuccessPanelProps {
  result: RecoverSuccess;
}

/**
 * Success panel shown after a 200 response. Surfaces the recovered admin
 * path prominently with a full-navigation link to `${adminPath}/login`,
 * plus the one-time unlock token (with a note on its 15-minute,
 * single-use nature).
 */
function RecoverySuccessPanel({ result }: RecoverySuccessPanelProps) {
  const loginHref = joinAdminPathLogin(result.adminPath);
  const passwordId = useId();
  const confirmId = useId();

  const form = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { password: '', confirmPassword: '' },
  });

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = form;

  const resetMutation = useMutation<void, ResetPasswordError, ResetPasswordFormValues>({
    mutationKey: ['recovery', 'reset-password'],
    mutationFn: (values) =>
      postResetPassword({
        unlockToken: result.oneTimeUnlockToken,
        password: values.password,
      }),
    retry: false,
  });

  const passwordRules = evaluatePasswordRules(watch('password') ?? '');

  const onResetSubmit: SubmitHandler<ResetPasswordFormValues> = (values) => {
    resetMutation.mutate(values);
  };

  if (resetMutation.isSuccess) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
        <div className="w-full max-w-md space-y-6 rounded-xl border bg-background p-8 shadow-sm">
          <header className="space-y-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-600" aria-hidden="true" />
              <h1 className="text-lg font-semibold tracking-tight">
                Password reset
              </h1>
            </div>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Your password was updated. Sign in with the new password.
            </p>
          </header>

          {loginHref ? (
            <a
              href={loginHref}
              className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
            >
              Go to admin login
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md space-y-6 rounded-xl border bg-background p-8 shadow-sm">
        <header className="space-y-2">
          <div className="flex items-center gap-2">
            <ShieldCheck
              className="h-5 w-5 text-emerald-600"
              aria-hidden="true"
            />
            <h1 className="text-lg font-semibold tracking-tight">
              Recovery successful
            </h1>
          </div>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            The backup code was accepted. Set a new password, then sign in.
          </p>
        </header>

        {/* ── Admin path ─────────────────────────────────────────────── */}
        <section className="space-y-2">
          <p className="text-sm font-medium text-foreground">Your admin path</p>
          <code className="block break-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm">
            {result.adminPath}
          </code>
        </section>

        <form noValidate className="space-y-4" onSubmit={handleSubmit(onResetSubmit)}>
          {resetMutation.isError ? (
            <div
              role="alert"
              className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"
            >
              {resetMutation.error.code === 'RATE_LIMITED' &&
              resetMutation.error.retryAfterSeconds !== undefined
                ? `Too many recovery attempts. Try again in about ${formatWait(
                  resetMutation.error.retryAfterSeconds,
                )}.`
                : resetMutation.error.message}
            </div>
          ) : null}

          <Field id={passwordId} label="New password" error={errors.password?.message}>
            <input
              id={passwordId}
              type="password"
              autoComplete="new-password"
              aria-invalid={errors.password ? 'true' : 'false'}
              className={inputClass(Boolean(errors.password))}
              {...register('password')}
            />
          </Field>

          <PasswordRules rules={passwordRules} />

          <Field
            id={confirmId}
            label="Confirm new password"
            error={errors.confirmPassword?.message}
          >
            <input
              id={confirmId}
              type="password"
              autoComplete="new-password"
              aria-invalid={errors.confirmPassword ? 'true' : 'false'}
              className={inputClass(Boolean(errors.confirmPassword))}
              {...register('confirmPassword')}
            />
          </Field>

          <button
            type="submit"
            disabled={isSubmitting || resetMutation.isPending}
            className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resetMutation.isPending ? 'Updating…' : 'Set new password'}
          </button>
        </form>

        {/*
          Plain anchor — NOT a TanStack <Link>. A full document load lets
          the admin path guard (task 4.2) and the authenticated AppShell
          route tree pick the request up fresh; an in-memory SPA swap
          would land on a route the public layout can't serve.
        */}
        {loginHref ? (
          <a
            href={loginHref}
            className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            Go to admin login
          </a>
        ) : (
          <p role="alert" className="text-sm text-red-600">
            The recovered admin path is invalid. Contact an operator before signing in.
          </p>
        )}
      </div>
    </div>
  );
}

function passwordRuleLabel(rule: PasswordRuleId): string {
  switch (rule) {
    case 'length':
      return `At least ${PASSWORD_MIN_LENGTH} characters.`;
    case 'lowercase':
      return 'Includes a lowercase letter.';
    case 'uppercase':
      return 'Includes an uppercase letter.';
    case 'digit':
      return 'Includes a digit.';
    case 'special':
      return `Includes a special character (${[...PASSWORD_SPECIAL_CHARS].join(' ')}).`;
  }
}

function PasswordRules({ rules }: { rules: Record<PasswordRuleId, boolean> }) {
  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {(Object.keys(rules) as PasswordRuleId[]).map((rule) => (
        <li
          key={rule}
          className={rules[rule] ? 'text-emerald-700' : 'text-muted-foreground'}
        >
          {rules[rule] ? 'Met: ' : 'Not met: '}
          {passwordRuleLabel(rule)}
        </li>
      ))}
    </ul>
  );
}

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}

/**
 * Label + inline error wrapper. Owns the `<label htmlFor>` linkage so
 * each input gets a clickable label and a stable `role="alert"` error
 * region the screen reader can announce.
 */
function Field({ id, label, error, children }: FieldProps) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Render a wait duration in human-friendly units. Pure + exported for
 * unit tests.
 */
export function formatWait(seconds: number): string {
  if (seconds < 60) {
    const s = Math.max(1, Math.ceil(seconds));
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function inputClass(hasError: boolean, extra = ''): string {
  const base =
    'block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-primary/30';
  const border = hasError
    ? 'border-red-500 focus:border-red-500 focus:ring-red-500/30'
    : 'border-border focus:border-primary';
  return `${base} ${border} ${extra}`.trim();
}

export default BackupCodePage;
