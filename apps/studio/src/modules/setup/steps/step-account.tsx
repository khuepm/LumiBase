import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Eye, EyeOff, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import {
  accountSchema,
  evaluatePasswordRules,
  PASSWORD_MIN_LENGTH,
  PASSWORD_SPECIAL_CHARS,
  type AccountFormValues,
  type PasswordRuleId,
} from '../schemas/account';
import { useSetupStore } from '../setup-store';

/**
 * "Admin Account" step of the Setup Wizard.
 *
 * Implements Req 3.1–3.5, 3.7, 3.10:
 *
 *   - React Hook Form + Zod resolver against `accountSchema`
 *     (`schemas/account.ts`) — covers email format, password rules
 *     (length + classes), confirm-password match, and trim+length
 *     bounds for first/last name (Req 3.1–3.4, 3.10).
 *   - zxcvbn meter is lazy-loaded on mount so the ~400KB payload only
 *     ships when the operator reaches this step (design §5.5). The
 *     submit button is disabled until the meter has loaded AND the
 *     evaluated score is ≥ 3 (Req 3.5, 3.7).
 *   - Inline ✓/✗ rules list driven by `evaluatePasswordRules` so the
 *     same rule definitions power both validation and UX.
 *   - On a passing submit, mirrors the value into a session-only
 *     in-memory draft (see `getAccountDraft` below) and flips the
 *     wizard's `accountValid` flag in the Zustand store so the deep-
 *     link guard for `/setup/path` opens (design §11.2). Any later
 *     edit that breaks validation flips `accountValid` back to false
 *     so navigation guards remain accurate.
 *
 * What this file deliberately does NOT do:
 *   - It does not navigate to `/setup/path` after submit. Routes are
 *     wired in task 3.9; the parent shell drives navigation via the
 *     `onSubmitted` callback.
 *   - It does not persist the plaintext password anywhere. The draft
 *     cache below lives only in module memory for the lifetime of the
 *     tab (cleared by `useCompleteSetup` in task 3.8 once the values
 *     have been posted to `/setup/complete`).
 *   - It does not localize copy. Strings stay inline; task 3.10
 *     replaces them with i18n keys.
 *
 * Spec refs: requirements §3.1–§3.5, §3.7, §3.10; design.md §5.5.
 */

// ────────────────────────────────────────────────────────────────────────
// In-memory account draft
//
// Rationale: the wizard's persisted Zustand store deliberately omits
// secret fields (see `setup-store.ts` doc) so a refresh never lands
// the plaintext password in `sessionStorage`. We still need a place to
// stash the values between this step and `useCompleteSetup` (task
// 3.8), and React Hook Form local state goes away as soon as the
// component unmounts. A module-scoped variable held only in JS heap
// fits: it lives for the tab's lifetime, never touches storage, and
// resets on a hard refresh (forcing the user to re-enter credentials
// rather than ever recover them from disk).
// ────────────────────────────────────────────────────────────────────────

let accountDraft: AccountFormValues | null = null;

/**
 * Read the current in-memory account draft.
 *
 * Returns `null` if the operator hasn't successfully submitted the
 * Account step in this tab yet, or after `clearAccountDraft()` is
 * called by the completion mutation. NEVER persists across refreshes.
 */
export function getAccountDraft(): AccountFormValues | null {
  return accountDraft;
}

/**
 * Drop the in-memory draft. Call this immediately after the values
 * have been posted to `POST /api/v1/setup/complete` (task 3.8) so the
 * plaintext password doesn't outlive its single legitimate use.
 */
export function clearAccountDraft(): void {
  accountDraft = null;
}

/**
 * Write the in-memory account draft. The account step owns normal form
 * submission, while alternate setup surfaces use this for same-tab
 * handoff before opening the full wizard.
 */
export function setAccountDraft(value: AccountFormValues): void {
  accountDraft = value;
}

// ────────────────────────────────────────────────────────────────────────
// zxcvbn lazy-loader
// ────────────────────────────────────────────────────────────────────────

type ZxcvbnFn = (
  password: string,
  userInputs?: ReadonlyArray<string>,
) => { score: 0 | 1 | 2 | 3 | 4 };

/**
 * Module-level cache for the resolved zxcvbn module. Keeps subsequent
 * mounts of `StepAccount` from triggering an extra dynamic import().
 */
let cachedZxcvbn: ZxcvbnFn | null = null;
let cachedZxcvbnPromise: Promise<ZxcvbnFn> | null = null;

function loadZxcvbn(): Promise<ZxcvbnFn> {
  if (cachedZxcvbn) return Promise.resolve(cachedZxcvbn);
  if (cachedZxcvbnPromise) return cachedZxcvbnPromise;
  cachedZxcvbnPromise = import('zxcvbn').then((m) => {
    // The zxcvbn package's CJS export sits on `default` under ESM
    // interop; fall back to the namespace as a function for older
    // bundlers.
    const fn = (m.default ?? m) as unknown as ZxcvbnFn;
    cachedZxcvbn = fn;
    return fn;
  });
  return cachedZxcvbnPromise;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

const MIN_REQUIRED_ZXCVBN_SCORE = 3;

const STRENGTH_LABELS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'Very weak',
  1: 'Weak',
  2: 'Fair',
  3: 'Strong',
  4: 'Very strong',
};

const STRENGTH_BAR_COLORS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'bg-red-500',
  1: 'bg-red-500',
  2: 'bg-amber-500',
  3: 'bg-emerald-500',
  4: 'bg-emerald-600',
};

const RULE_LABELS: Record<PasswordRuleId, string> = {
  length: `At least ${PASSWORD_MIN_LENGTH} characters`,
  lowercase: 'Includes a lowercase letter',
  uppercase: 'Includes an uppercase letter',
  digit: 'Includes a digit',
  special: `Includes a special character (${formatSpecialChars()})`,
};

function formatSpecialChars(): string {
  return Array.from(PASSWORD_SPECIAL_CHARS).join(' ');
}

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

export interface StepAccountProps {
  /**
   * Optional callback invoked after the form passes Zod + zxcvbn gates
   * and the draft + store flag have been updated. Routes in task 3.9
   * use it to navigate to `/setup/path`.
   */
  onSubmitted?: (values: AccountFormValues) => void;
}

export function StepAccount({ onSubmitted }: StepAccountProps) {
  const setAccountValid = useSetupStore((s) => s.setAccountValid);

  // Identity-stable IDs for aria-* wiring. Each field has both an
  // error-text id and a help-text id so we can flip between them via
  // `aria-describedby` without losing the link to the helpful copy.
  const emailId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const firstNameId = useId();
  const lastNameId = useId();

  const form = useForm<AccountFormValues>({
    resolver: zodResolver(accountSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    shouldUnregister: false,
    defaultValues: {
      email: accountDraft?.email ?? '',
      password: accountDraft?.password ?? '',
      confirmPassword: accountDraft?.confirmPassword ?? '',
      firstName: accountDraft?.firstName ?? '',
      lastName: accountDraft?.lastName ?? '',
    },
  });

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting, isValid },
  } = form;

  const passwordValue = watch('password') ?? '';
  const emailValue = watch('email') ?? '';
  const firstNameValue = watch('firstName') ?? '';
  const lastNameValue = watch('lastName') ?? '';

  // Live rules ✓/✗ list. Cheap to recompute every keystroke.
  const ruleStatus = useMemo(
    () => evaluatePasswordRules(passwordValue),
    [passwordValue],
  );

  // ── zxcvbn lazy load + score evaluation ────────────────────────────
  // While the library is loading we treat the score as unknown. Submit
  // is gated until both the library has resolved AND the evaluated
  // score reaches MIN_REQUIRED_ZXCVBN_SCORE (Req 3.7).

  const [zxcvbnReady, setZxcvbnReady] = useState<boolean>(
    cachedZxcvbn !== null,
  );
  const zxcvbnFnRef = useRef<ZxcvbnFn | null>(cachedZxcvbn);

  useEffect(() => {
    if (zxcvbnFnRef.current !== null) return;
    let active = true;
    loadZxcvbn().then((fn) => {
      if (!active) return;
      zxcvbnFnRef.current = fn;
      setZxcvbnReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const passwordScore: 0 | 1 | 2 | 3 | 4 | null = useMemo(() => {
    if (!zxcvbnReady) return null;
    if (passwordValue.length === 0) return 0;
    const fn = zxcvbnFnRef.current;
    if (!fn) return null;
    // Feed user-controlled inputs so zxcvbn can detect "Tony Hawk
    // Tony123!" style passwords that include the operator's own name
    // / email — these are practically guessable even if they pass the
    // raw rules.
    const userInputs = [emailValue, firstNameValue, lastNameValue].filter(
      (v) => v && v.length > 0,
    );
    const result = fn(passwordValue, userInputs);
    return result.score;
  }, [zxcvbnReady, passwordValue, emailValue, firstNameValue, lastNameValue]);

  const meetsZxcvbnGate =
    passwordScore !== null && passwordScore >= MIN_REQUIRED_ZXCVBN_SCORE;

  // Submit-button gating. We deliberately disable the button rather
  // than only relying on the schema so the UX matches the requirement
  // wording ("yêu cầu score ≥ 3 trước khi cho phép submit").
  const submitDisabled =
    isSubmitting ||
    !zxcvbnReady ||
    !meetsZxcvbnGate ||
    passwordValue.length === 0;

  // ── Whenever the form fails validation (or zxcvbn drops below 3),
  //    reset the wizard's `accountValid` flag so deep-linking to a
  //    later step still redirects back here. This complements the
  //    onSubmit handler which sets the flag to true on success.
  useEffect(() => {
    if (!isValid || !meetsZxcvbnGate) {
      setAccountValid(false);
    }
  }, [isValid, meetsZxcvbnGate, setAccountValid]);

  // ── Show / hide password toggles. Two separate flags so revealing
  //    the main password doesn't leak the confirm field (and vice
  //    versa).
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const onSubmit: SubmitHandler<AccountFormValues> = useCallback(
    (values) => {
      // Defence in depth: even if React somehow lost the disabled
      // state on the button, the resolver-gated handler still re-checks
      // zxcvbn before persisting.
      if (!meetsZxcvbnGate) {
        return;
      }
      setAccountDraft(values);
      setAccountValid(true);
      onSubmitted?.(values);
    },
    [meetsZxcvbnGate, onSubmitted, setAccountValid],
  );

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
          Create the admin account
        </h2>
        <p className="text-sm text-muted-foreground">
          This account becomes the bootstrap administrator for the
          instance. Pick a strong, unique password — it can&rsquo;t be
          reset without recovery codes.
        </p>
      </header>

      {/* ── Email ─────────────────────────────────────────────────── */}
      <Field
        id={emailId}
        label="Email"
        error={errors.email?.message}
      >
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

      {/* ── First / Last name ─────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={firstNameId}
          label="First name"
          error={errors.firstName?.message}
        >
          <input
            id={firstNameId}
            type="text"
            autoComplete="given-name"
            aria-invalid={errors.firstName ? 'true' : 'false'}
            aria-describedby={
              errors.firstName ? `${firstNameId}-error` : undefined
            }
            className={inputClass(Boolean(errors.firstName))}
            {...register('firstName')}
          />
        </Field>

        <Field
          id={lastNameId}
          label="Last name"
          error={errors.lastName?.message}
        >
          <input
            id={lastNameId}
            type="text"
            autoComplete="family-name"
            aria-invalid={errors.lastName ? 'true' : 'false'}
            aria-describedby={
              errors.lastName ? `${lastNameId}-error` : undefined
            }
            className={inputClass(Boolean(errors.lastName))}
            {...register('lastName')}
          />
        </Field>
      </div>

      {/* ── Password ──────────────────────────────────────────────── */}
      <Field
        id={passwordId}
        label="Password"
        error={errors.password?.message}
        helpId={`${passwordId}-rules`}
      >
        <div className="relative">
          <input
            id={passwordId}
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            spellCheck={false}
            aria-invalid={errors.password ? 'true' : 'false'}
            aria-describedby={[
              errors.password ? `${passwordId}-error` : null,
              `${passwordId}-rules`,
              `${passwordId}-strength`,
            ]
              .filter(Boolean)
              .join(' ')}
            className={inputClass(Boolean(errors.password), 'pr-10')}
            {...register('password')}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute inset-y-0 right-2 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            tabIndex={-1}
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>

        <PasswordStrengthMeter
          id={`${passwordId}-strength`}
          score={passwordScore}
          ready={zxcvbnReady}
          empty={passwordValue.length === 0}
        />

        <ul
          id={`${passwordId}-rules`}
          className="mt-2 space-y-1 text-xs"
          aria-label="Password requirements"
        >
          {(Object.keys(RULE_LABELS) as PasswordRuleId[]).map((id) => (
            <RuleRow
              key={id}
              ok={ruleStatus[id]}
              label={RULE_LABELS[id]}
            />
          ))}
        </ul>
      </Field>

      {/* ── Confirm password ──────────────────────────────────────── */}
      <Field
        id={confirmId}
        label="Confirm password"
        error={errors.confirmPassword?.message}
      >
        <div className="relative">
          <input
            id={confirmId}
            type={showConfirm ? 'text' : 'password'}
            autoComplete="new-password"
            spellCheck={false}
            aria-invalid={errors.confirmPassword ? 'true' : 'false'}
            aria-describedby={
              errors.confirmPassword ? `${confirmId}-error` : undefined
            }
            className={inputClass(Boolean(errors.confirmPassword), 'pr-10')}
            {...register('confirmPassword')}
          />
          <button
            type="button"
            onClick={() => setShowConfirm((v) => !v)}
            className="absolute inset-y-0 right-2 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label={
              showConfirm ? 'Hide confirm password' : 'Show confirm password'
            }
            tabIndex={-1}
          >
            {showConfirm ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
      </Field>

      {/* ── Submit ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="submit"
          disabled={submitDisabled}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {!zxcvbnReady && passwordValue.length > 0
            ? 'Checking strength…'
            : 'Continue'}
        </button>
      </div>
    </form>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
  /** Optional id of an extra describedby target (e.g. rules list). */
  helpId?: string;
}

/**
 * Common label + error wrapper. Owns the `<label htmlFor>` linkage so
 * each input gets a clickable label and a stable error region the
 * screen reader can announce via `role="alert"`.
 */
function Field({ id, label, error, children }: FieldProps) {
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="block text-sm font-medium text-foreground"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="text-xs text-red-600"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface RuleRowProps {
  ok: boolean;
  label: string;
}

function RuleRow({ ok, label }: RuleRowProps) {
  return (
    <li className="flex items-start gap-2">
      {ok ? (
        <Check
          className="mt-[1px] h-3.5 w-3.5 shrink-0 text-emerald-600"
          aria-hidden="true"
        />
      ) : (
        <X
          className="mt-[1px] h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      )}
      <span className={ok ? 'font-semibold text-emerald-700' : 'text-muted-foreground'}>
        <span className="sr-only">{ok ? 'Met: ' : 'Not met: '}</span>
        {label}
      </span>
    </li>
  );
}

interface PasswordStrengthMeterProps {
  id: string;
  score: 0 | 1 | 2 | 3 | 4 | null;
  ready: boolean;
  empty: boolean;
}

/**
 * Five-segment strength meter rendered below the password input.
 *
 * States:
 *   - meter not loaded yet → muted skeleton + "Checking…" copy;
 *   - empty password → all segments muted, no label;
 *   - score < 3 → segments coloured up to score, "weak" label, plus a
 *     red helper line explaining submit is blocked (Req 3.7);
 *   - score ≥ 3 → segments coloured up to score, neutral label.
 */
function PasswordStrengthMeter({
  id,
  score,
  ready,
  empty,
}: PasswordStrengthMeterProps) {
  if (!ready) {
    return (
      <div
        id={id}
        className="mt-2 text-xs text-muted-foreground"
        aria-live="polite"
      >
        Checking password strength…
      </div>
    );
  }

  if (empty) {
    return (
      <div
        id={id}
        className="mt-2 flex items-center gap-2"
        aria-live="polite"
        aria-label="Password strength: none"
      >
        <div className="flex flex-1 gap-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className="h-1.5 flex-1 rounded-full bg-muted"
              aria-hidden="true"
            />
          ))}
        </div>
      </div>
    );
  }

  const safeScore: 0 | 1 | 2 | 3 | 4 = score ?? 0;
  const label = STRENGTH_LABELS[safeScore];
  const fillCount = safeScore + 1;
  const insufficient = safeScore < MIN_REQUIRED_ZXCVBN_SCORE;

  return (
    <div id={id} className="mt-2 space-y-1" aria-live="polite">
      <div
        className="flex items-center gap-2"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={safeScore}
        aria-valuetext={label}
      >
        <div className="flex flex-1 gap-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={`h-1.5 flex-1 rounded-full ${i < fillCount
                  ? STRENGTH_BAR_COLORS[safeScore]
                  : 'bg-muted'
                }`}
              aria-hidden="true"
            />
          ))}
        </div>
        <span
          className={`min-w-[5.5rem] text-right text-xs ${insufficient ? 'text-red-600' : 'text-emerald-700'
            }`}
        >
          {label}
        </span>
      </div>
      {insufficient ? (
        <p className="text-xs text-red-600">
          Choose a password rated &ldquo;Strong&rdquo; or better to continue.
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

export default StepAccount;
