import {
  AlertTriangle,
  BookOpen,
  Check,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import {
  useCallback,
  useId,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { z } from 'zod';
import {
  accountSchema,
  evaluatePasswordRules,
  PASSWORD_MIN_LENGTH,
  type AccountFormValues,
} from './schemas/account';
import {
  adminPathSchema,
  normalizeAdminPath,
  type AdminPathFormValues,
} from './schemas/admin-path';
import {
  lockoutPolicySchema,
  POLICY_PRESETS,
  type LockoutPolicyFormValues,
  type PolicyPresetId,
} from './schemas/policy';
import {
  projectConfigurationSchema,
  type ProjectConfigurationFormValues,
} from './schemas/project';
import { SETUP_TOKEN_STORAGE_KEY } from './setup-state-gate';
import { useSetupStore } from './setup-store';
import {
  getAccountDraft,
  setAccountDraft,
} from './steps/step-account';
import {
  getPathDraft,
  setPathDraft,
} from './steps/step-path';
import {
  getPolicyDraft,
  inferActivePreset,
  setPolicyDraft,
} from './steps/step-security';
import {
  getProjectDraft,
  setProjectDraft,
} from './steps/step-project';
import { wordlistGenerateUnique } from './wordlist';

type SimpleStep = 'essentials' | 'review' | 'recovery';

type InviteRole = 'admin' | 'member';

interface InviteDraft {
  email: string;
  role: InviteRole;
}

interface SimpleSetupDraft {
  account: AccountFormValues;
  path: AdminPathFormValues;
  project: ProjectConfigurationFormValues;
}

/**
 * Documentation links surfaced from the wizard. The base intro page and a
 * security-presets guide. Mirrors the hardcoded `https://docs.lumibase.dev/*`
 * pattern already used in `apps/studio/src/lib/release-updates.ts`. If/when a
 * docs route is added in-app these can point there instead.
 */
const DOCS_BASE_URL = 'https://docs.lumibase.dev';
const DOCS_SECURITY_URL = 'https://docs.lumibase.dev/setup/security-presets';
const DOCS_USERS_URL = 'https://docs.lumibase.dev/setup/users';

interface SetupCompleteResponse {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  adminPath: string;
  backupCodes: string[];
  setupToken: null;
  invitedCount?: number;
}

interface FieldErrors {
  email?: string;
  password?: string;
  confirmPassword?: string;
  firstName?: string;
  lastName?: string;
  adminPath?: string;
}

const PASSWORD_RULE_LABELS = {
  length: `At least ${PASSWORD_MIN_LENGTH} characters`,
  lowercase: 'Includes a lowercase letter',
  uppercase: 'Includes an uppercase letter',
  digit: 'Includes a digit',
  special: 'Includes a special character',
} as const;

const SIMPLE_STEPS: Array<{ id: SimpleStep; title: string }> = [
  { id: 'essentials', title: 'Essentials' },
  { id: 'review', title: 'Security review' },
  { id: 'recovery', title: 'Recovery codes' },
];

const DEFAULT_ACCOUNT = {
  email: '',
  password: '',
  confirmPassword: '',
  firstName: '',
  lastName: '',
};

const DEFAULT_PROJECT = {
  defaultLanguage: 'en',
  siteUrl: 'http://localhost:2026',
  displayTitle: 'LumiBase',
  theme: null,
};

export function SimpleSetupWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState<SimpleStep>('essentials');
  const [account, setAccount] = useState(() => getAccountDraft() ?? DEFAULT_ACCOUNT);
  const [adminPath, setAdminPath] = useState(
    () => getPathDraft()?.adminPath ?? wordlistGenerateUnique() ?? '',
  );
  const [securityPreset, setSecurityPreset] = useState<PolicyPresetId>(() => {
    const policyDraft = getPolicyDraft();
    return policyDraft ? inferActivePreset(policyDraft) ?? 'standard' : 'standard';
  });
  const [draft, setDraft] = useState<SimpleSetupDraft | null>(null);
  const [invites, setInvites] = useState<InviteDraft[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [completion, setCompletion] = useState<SetupCompleteResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const activeIndex = SIMPLE_STEPS.findIndex((item) => item.id === step);

  const validateEssentials = useCallback((): SimpleSetupDraft | null => {
    const nextErrors: FieldErrors = {};

    const accountResult = accountSchema.safeParse(account);
    if (!accountResult.success) {
      mergeZodIssues(nextErrors, accountResult.error);
    }

    const pathResult = adminPathSchema.safeParse({ adminPath });
    if (!pathResult.success) {
      nextErrors.adminPath = firstIssueMessage(pathResult.error);
    }

    const projectResult = projectConfigurationSchema.safeParse(
      getProjectDraft() ?? DEFAULT_PROJECT,
    );
    if (!projectResult.success) {
      mergeZodIssues(nextErrors, projectResult.error);
    }

    setErrors(nextErrors);
    if (!accountResult.success || !pathResult.success || !projectResult.success) {
      return null;
    }

    const nextDraft = {
      account: accountResult.data,
      path: pathResult.data,
      project: projectResult.data,
    };
    persistEssentialsDraft(nextDraft);
    setDraft(nextDraft);
    return nextDraft;
  }, [account, adminPath]);

  const handleContinue = useCallback(() => {
    const validDraft = validateEssentials();
    if (validDraft === null) return;
    setDraft(validDraft);
    setStep('review');
    setSubmitError(null);
  }, [validateEssentials]);

  const clearError = useCallback((field: keyof FieldErrors) => {
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  const handleAdvancedSetup = useCallback(() => {
    const hasAccountInput = Object.values(account).some(
      (value) => value.trim().length > 0,
    );
    if (!hasAccountInput) {
      navigate({ to: '/setup/advance' });
      return;
    }
    const validDraft = validateEssentials();
    if (validDraft === null) return;
    navigate({ to: '/setup/security' });
  }, [account, navigate, validateEssentials]);

  const handleComplete = useCallback(async () => {
    const validDraft = draft ?? validateEssentials();
    if (validDraft === null) {
      setStep('essentials');
      return;
    }

    let policy: LockoutPolicyFormValues;
    try {
      policy = lockoutPolicySchema.parse({
        ...POLICY_PRESETS[securityPreset],
      });
    } catch {
      setSubmitError('The selected security preset is invalid.');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const result = await postSetupComplete({
        account: validDraft.account,
        adminPath: validDraft.path.adminPath,
        policy,
        project: validDraft.project,
        invites: sanitizeInvites(invites),
      });

      const store = useSetupStore.getState();
      store.setAccountValid(true);
      store.setPathValid(true);
      store.setPolicyValid(true);
      store.setProjectValid(true);
      store.setAdminPath(result.adminPath);
      store.setCompleted(true);
      clearSetupToken();

      setCompletion(result);
      setStep('recovery');
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : 'Setup could not be completed.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [draft, invites, securityPreset, validateEssentials]);

  return (
    <div className="min-h-screen bg-muted/30 px-4 py-8 sm:py-12">
      <main className="mx-auto w-full max-w-4xl space-y-6">
        <header className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase text-primary">
                Quick setup
              </p>
              <h1 className="text-2xl font-semibold tracking-tight">
                Set up LumiBase in 3 steps
              </h1>
              <p className="max-w-2xl text-sm text-muted-foreground">
                The quick path applies the same production defaults as the full
                wizard. Before anything is created, the review step lists every
                default that will be applied.
              </p>
            </div>
            <button
              type="button"
              onClick={handleAdvancedSetup}
              className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted"
            >
              Advanced setup
            </button>
          </div>
          <SimpleProgress
            activeIndex={activeIndex}
            onStepSelect={(selectedStep) => {
              if (selectedStep === 'essentials') setStep('essentials');
            }}
          />
        </header>

        <section className="rounded-md border bg-background p-5 shadow-sm sm:p-6">
          {step === 'essentials' ? (
            <EssentialsStep
              account={account}
              adminPath={adminPath}
              errors={errors}
              onAccountChange={setAccount}
              onAdminPathChange={setAdminPath}
              onClearError={clearError}
              onContinue={handleContinue}
              onAdvancedSetup={handleAdvancedSetup}
            />
          ) : null}

          {step === 'review' && draft ? (
            <ReviewStep
              draft={draft}
              securityPreset={securityPreset}
              invites={invites}
              submitError={submitError}
              isSubmitting={isSubmitting}
              onBack={() => setStep('essentials')}
              onPresetChange={setSecurityPreset}
              onInvitesChange={setInvites}
              onComplete={handleComplete}
              onAdvancedSetup={() => {
                persistPolicyPreset(securityPreset);
                navigate({ to: '/setup/security' });
              }}
            />
          ) : null}

          {step === 'recovery' && completion ? (
            <RecoveryStep completion={completion} />
          ) : null}
        </section>
      </main>
    </div>
  );
}

interface EssentialsStepProps {
  account: typeof DEFAULT_ACCOUNT;
  adminPath: string;
  errors: FieldErrors;
  onAccountChange: (value: typeof DEFAULT_ACCOUNT) => void;
  onAdminPathChange: (value: string) => void;
  onClearError: (field: keyof FieldErrors) => void;
  onContinue: () => void;
  onAdvancedSetup: () => void;
}

function EssentialsStep({
  account,
  adminPath,
  errors,
  onAccountChange,
  onAdminPathChange,
  onClearError,
  onContinue,
  onAdvancedSetup,
}: EssentialsStepProps) {
  const emailId = useId();
  const firstNameId = useId();
  const lastNameId = useId();
  const passwordId = useId();
  const confirmPasswordId = useId();
  const pathId = useId();
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const passwordRules = useMemo(
    () => evaluatePasswordRules(account.password),
    [account.password],
  );
  const pathPreview = useMemo(() => normalizeAdminPath(adminPath), [adminPath]);

  const handleGeneratePath = useCallback(() => {
    const next = wordlistGenerateUnique();
    if (next !== null) {
      onAdminPathChange(next);
      onClearError('adminPath');
    }
  }, [onAdminPathChange, onClearError]);

  const updateAccount = useCallback(
    <K extends keyof typeof DEFAULT_ACCOUNT>(key: K) =>
      (event: ChangeEvent<HTMLInputElement>) => {
        onAccountChange({ ...account, [key]: event.target.value });
        onClearError(key);
        if (key === 'password') onClearError('confirmPassword');
      },
    [account, onAccountChange, onClearError],
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">
          Account and admin URL
        </h2>
        <p className="text-sm text-muted-foreground">
          These are the setup values that cannot be inferred safely. Project
          identity uses LumiBase defaults in quick setup and can be tuned in
          Advanced setup.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={emailId} label="Admin email" error={errors.email}>
          <input
            id={emailId}
            type="email"
            value={account.email}
            onChange={updateAccount('email')}
            className={inputClass(Boolean(errors.email))}
            autoComplete="email"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={firstNameId} label="First name" error={errors.firstName}>
            <input
              id={firstNameId}
              value={account.firstName}
              onChange={updateAccount('firstName')}
              className={inputClass(Boolean(errors.firstName))}
              autoComplete="given-name"
            />
          </Field>
          <Field id={lastNameId} label="Last name" error={errors.lastName}>
            <input
              id={lastNameId}
              value={account.lastName}
              onChange={updateAccount('lastName')}
              className={inputClass(Boolean(errors.lastName))}
              autoComplete="family-name"
            />
          </Field>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={passwordId} label="Password" error={errors.password}>
          <div className="relative">
            <input
              id={passwordId}
              type={showPassword ? 'text' : 'password'}
              value={account.password}
              onChange={updateAccount('password')}
              className={inputClass(Boolean(errors.password), 'pr-10')}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 inline-flex w-10 items-center justify-center text-muted-foreground transition hover:text-foreground"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
          <ul className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
            {Object.entries(PASSWORD_RULE_LABELS).map(([key, label]) => {
              const passed = passwordRules[key as keyof typeof passwordRules];
              return (
                <li
                  key={key}
                  className={`flex items-center gap-1.5 ${passed ? 'font-semibold text-emerald-700' : 'text-muted-foreground'
                    }`}
                >
                  <Check
                    className={passed ? 'h-3.5 w-3.5 text-emerald-600' : 'h-3.5 w-3.5 text-muted-foreground/50'}
                    aria-hidden="true"
                  />
                  <span>{label}</span>
                </li>
              );
            })}
          </ul>
        </Field>
        <Field
          id={confirmPasswordId}
          label="Confirm password"
          error={errors.confirmPassword}
        >
          <div className="relative">
            <input
              id={confirmPasswordId}
              type={showConfirmPassword ? 'text' : 'password'}
              value={account.confirmPassword}
              onChange={updateAccount('confirmPassword')}
              className={inputClass(Boolean(errors.confirmPassword), 'pr-10')}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword((value) => !value)}
              aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 inline-flex w-10 items-center justify-center text-muted-foreground transition hover:text-foreground"
            >
              {showConfirmPassword ? (
                <EyeOff className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </Field>
      </div>

      <Field
        id={pathId}
        label="Private admin path"
        error={errors.adminPath}
        helpText="Bookmark this URL after setup. It replaces the predictable /admin path."
      >
        <div className="flex gap-2">
          <input
            id={pathId}
            value={adminPath}
            onChange={(event) => {
              onAdminPathChange(event.target.value);
              onClearError('adminPath');
            }}
            className={inputClass(Boolean(errors.adminPath), 'font-mono')}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={handleGeneratePath}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Generate
          </button>
        </div>
        {pathPreview ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Preview:{' '}
            <code className="font-mono text-foreground">{pathPreview}</code>
          </p>
        ) : null}
      </Field>

      <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={onAdvancedSetup}
          className="text-left text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Continue in advanced setup
        </button>
        <button type="button" onClick={onContinue} className={primaryButtonClass}>
          Review security defaults
        </button>
      </div>
    </div>
  );
}

interface ReviewStepProps {
  draft: SimpleSetupDraft;
  securityPreset: PolicyPresetId;
  invites: InviteDraft[];
  submitError: string | null;
  isSubmitting: boolean;
  onBack: () => void;
  onPresetChange: (preset: PolicyPresetId) => void;
  onInvitesChange: (invites: InviteDraft[]) => void;
  onComplete: () => void;
  onAdvancedSetup: () => void;
}

function ReviewStep({
  draft,
  securityPreset,
  invites,
  submitError,
  isSubmitting,
  onBack,
  onPresetChange,
  onInvitesChange,
  onComplete,
  onAdvancedSetup,
}: ReviewStepProps) {
  const preset = POLICY_PRESETS[securityPreset];
  const presetSelectId = useId();
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">
          Review what quick setup will apply
        </h2>
        <p className="text-sm text-muted-foreground">
          Nothing has been written yet. Switch to advanced setup now if you
          want to tune individual lockout, anomaly, or notification fields.
        </p>
      </header>

      <div className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <Field
            id={presetSelectId}
            label="Security preset"
            helpText={describePreset(securityPreset)}
          >
            <select
              id={presetSelectId}
              value={securityPreset}
              onChange={(event) =>
                onPresetChange(event.target.value as PolicyPresetId)
              }
              className={inputClass(false, 'sm:w-64 capitalize')}
            >
              {(['standard', 'strict', 'lenient'] as PolicyPresetId[]).map(
                (id) => (
                  <option key={id} value={id} className="capitalize">
                    {id}
                  </option>
                ),
              )}
            </select>
          </Field>
          <a
            href={DOCS_SECURITY_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 pb-2 text-sm text-primary underline-offset-2 hover:underline"
          >
            <BookOpen className="h-4 w-4" aria-hidden="true" />
            How to choose a preset
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      </div>

      <InviteUsersSection invites={invites} onInvitesChange={onInvitesChange} />

      <section className="grid gap-4 lg:grid-cols-2">
        <ReviewGroup title="Essentials">
          <ReviewItem label="Admin email" value={draft.account.email} />
          <ReviewItem label="Admin path" value={draft.path.adminPath} />
        </ReviewGroup>

        <ReviewGroup title="Security defaults">
          <ReviewItem
            label="User lockout"
            value={`${preset.userMaxFailedAttempts} failed attempts, ${formatDuration(preset.userLockoutDurationSeconds)} lockout`}
          />
          <ReviewItem
            label="IP lockout"
            value={`${preset.ipMaxFailedAttempts} failed attempts, ${formatDuration(preset.ipLockoutDurationSeconds)} lockout`}
          />
          <ReviewItem
            label="Detection"
            value={[
              preset.geoAnomalyEnabled ? 'geo' : null,
              preset.timeAnomalyEnabled ? 'time' : null,
              preset.deviceAnomalyEnabled ? 'device' : null,
            ]
              .filter(Boolean)
              .join(', ') || 'none'}
          />
          <ReviewItem
            label="Notification"
            value={preset.notifyChannels.join(', ')}
          />
        </ReviewGroup>
      </section>

      <aside className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-medium">Advanced settings are still available.</p>
          <p className="mt-1">
            Quick setup lists every hidden default here. Use Advanced setup when
            you need custom webhook notifications, anomaly thresholds, or exact
            lockout windows before the first admin account is created.
          </p>
        </div>
      </aside>

      {submitError ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {submitError}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={onAdvancedSetup}
          className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Open advanced setup instead
        </button>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onBack} className={secondaryButtonClass}>
            Back
          </button>
          <button
            type="button"
            onClick={onComplete}
            disabled={isSubmitting}
            className={primaryButtonClass}
          >
            {isSubmitting ? 'Creating setup...' : 'Create setup'}
          </button>
        </div>
      </div>
    </div>
  );
}

const INVITE_ROLE_OPTIONS: ReadonlyArray<{ value: InviteRole; label: string }> = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
];

/**
 * Optional invite list rendered inside the review step. Each row is an email
 * + role. Invites are created as `status: 'invited'` users when setup
 * completes (see `postSetupComplete`); leaving this empty is valid. Rows with
 * an invalid or empty email are dropped on submit by `sanitizeInvites`, but we
 * surface a soft inline hint so the operator isn't surprised.
 */
function InviteUsersSection({
  invites,
  onInvitesChange,
}: {
  invites: InviteDraft[];
  onInvitesChange: (invites: InviteDraft[]) => void;
}) {
  const updateInvite = useCallback(
    (index: number, patch: Partial<InviteDraft>) => {
      onInvitesChange(
        invites.map((invite, i) =>
          i === index ? { ...invite, ...patch } : invite,
        ),
      );
    },
    [invites, onInvitesChange],
  );

  const addInvite = useCallback(() => {
    onInvitesChange([...invites, { email: '', role: 'member' }]);
  }, [invites, onInvitesChange]);

  const removeInvite = useCallback(
    (index: number) => {
      onInvitesChange(invites.filter((_, i) => i !== index));
    },
    [invites, onInvitesChange],
  );

  return (
    <section className="space-y-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            Invite teammates (optional)
          </h3>
          <p className="text-xs text-muted-foreground">
            They&apos;re added as invited users and appear under Users after
            they sign in. You can also do this later.
          </p>
        </div>
        <a
          href={DOCS_USERS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-2 hover:underline"
        >
          <BookOpen className="h-4 w-4" aria-hidden="true" />
          Roles &amp; access
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>

      {invites.length > 0 ? (
        <ul className="space-y-2">
          {invites.map((invite, index) => {
            const showInvalid =
              invite.email.trim().length > 0 && !isValidEmail(invite.email);
            return (
              <li
                key={index}
                className="flex flex-col gap-2 sm:flex-row sm:items-start"
              >
                <div className="flex-1">
                  <input
                    type="email"
                    value={invite.email}
                    onChange={(event) =>
                      updateInvite(index, { email: event.target.value })
                    }
                    placeholder="teammate@example.com"
                    aria-label={`Invite email ${index + 1}`}
                    className={inputClass(showInvalid)}
                    autoComplete="off"
                  />
                  {showInvalid ? (
                    <p className="mt-1 text-xs text-red-600">
                      Enter a valid email address.
                    </p>
                  ) : null}
                </div>
                <select
                  value={invite.role}
                  onChange={(event) =>
                    updateInvite(index, {
                      role: event.target.value as InviteRole,
                    })
                  }
                  aria-label={`Invite role ${index + 1}`}
                  className={inputClass(false, 'sm:w-36')}
                >
                  {INVITE_ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeInvite(index)}
                  aria-label={`Remove invite ${index + 1}`}
                  className={secondaryButtonClass}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <button
        type="button"
        onClick={addInvite}
        className={secondaryButtonClass}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add teammate
      </button>
    </section>
  );
}

function RecoveryStep({ completion }: { completion: SetupCompleteResponse }) {
  const [confirmed, setConfirmed] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const adminUrl = buildAdminLoginUrl(completion.adminPath);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(completion.backupCodes.join('\n'));
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }, [completion.backupCodes]);

  const handleDownload = useCallback(() => {
    const content = completion.backupCodes.join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'lumibase-backup-codes.txt';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [completion.backupCodes]);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-emerald-700">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          <span className="text-sm font-medium">Setup created</span>
        </div>
        <h2 className="text-lg font-semibold tracking-tight">
          Save your recovery codes
        </h2>
        <p className="text-sm text-muted-foreground">
          These codes are shown once. Save them before opening the admin login.
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">Backup codes</p>
          <div className="flex gap-2">
            <button type="button" onClick={handleCopy} className={secondaryButtonClass}>
              {copyState === 'copied' ? (
                <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              Copy
            </button>
            <button type="button" onClick={handleDownload} className={secondaryButtonClass}>
              <Download className="h-4 w-4" aria-hidden="true" />
              Download
            </button>
          </div>
        </div>
        <ul className="grid gap-2 sm:grid-cols-2">
          {completion.backupCodes.map((code) => (
            <li key={code}>
              <code className="block rounded-md border border-border bg-muted/40 px-3 py-2 text-center font-mono text-sm tracking-wider break-all">
                {code}
              </code>
            </li>
          ))}
        </ul>
        {copyState === 'error' ? (
          <p role="alert" className="text-xs text-red-600">
            Could not copy automatically. Use Download or select the codes.
          </p>
        ) : null}
      </section>

      {completion.invitedCount && completion.invitedCount > 0 ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-100">
          {completion.invitedCount}{' '}
          {completion.invitedCount === 1 ? 'teammate' : 'teammates'} invited —
          they&apos;ll appear under Users after they sign in.
        </p>
      ) : null}

      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-2 focus:ring-primary/30"
        />
        <span>I have saved these backup codes and my private admin path.</span>
      </label>

      <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
        <code className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm break-all">
          {adminUrl}
        </code>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <a
            href={DOCS_BASE_URL}
            target="_blank"
            rel="noreferrer"
            className={secondaryButtonClass}
          >
            <BookOpen className="h-4 w-4" aria-hidden="true" />
            View docs
          </a>
          <a
            href={adminUrl}
            aria-disabled={!confirmed}
            className={
              confirmed
                ? primaryButtonClass
                : `${primaryButtonClass} pointer-events-none opacity-50`
            }
          >
            Go to admin login
          </a>
        </div>
      </div>
    </div>
  );
}

function SimpleProgress({
  activeIndex,
  onStepSelect,
}: {
  activeIndex: number;
  onStepSelect: (step: SimpleStep) => void;
}) {
  return (
    <ol className="grid gap-2 sm:grid-cols-3 cursor-pointer">
      {SIMPLE_STEPS.map((item, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex;
        const canNavigateBack = done && activeIndex < SIMPLE_STEPS.length - 1;
        const marker = (
          <span className="flex items-center gap-2">
            <span
              className={
                done
                  ? 'inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground'
                  : active
                    ? 'inline-flex h-6 w-6 items-center justify-center rounded-full border border-primary text-xs font-semibold text-primary'
                    : 'inline-flex h-6 w-6 items-center justify-center rounded-full border border-border text-xs font-semibold text-muted-foreground'
              }
            >
              {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : index + 1}
            </span>
            <span
              className={
                active || canNavigateBack
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground'
              }
            >
              {item.title}
            </span>
          </span>
        );
        return (
          <li
            key={item.id}
            className={
              active
                ? 'rounded-md border border-primary bg-background p-3 text-sm ring-1 ring-primary/30'
                : 'rounded-md border border-border bg-background p-3 text-sm'
            }
          >
            {canNavigateBack ? (
              <button
                type="button"
                onClick={() => onStepSelect(item.id)}
                className="rounded-md outline-none transition hover:opacity-85 focus-visible:ring-2 focus-visible:ring-primary/30"
                aria-label={`Edit ${item.title}`}
              >
                {marker}
              </button>
            ) : (
              marker
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ReviewGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <dl className="space-y-2">{children}</dl>
    </div>
  );
}

function ReviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 text-sm sm:grid-cols-[9rem_1fr]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground break-words">{value}</dd>
    </div>
  );
}

function Field({
  id,
  label,
  error,
  helpText,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  helpText?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {helpText ? (
        <p className="text-xs text-muted-foreground">{helpText}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function mergeZodIssues(target: FieldErrors, error: z.ZodError): void {
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key !== 'string') continue;
    if (key in target && target[key as keyof FieldErrors]) continue;
    target[key as keyof FieldErrors] = issue.message;
  }
}

function persistEssentialsDraft(draft: SimpleSetupDraft): void {
  setAccountDraft(draft.account);
  setPathDraft(draft.path);
  setProjectDraft(draft.project);

  const store = useSetupStore.getState();
  store.setAccountValid(true);
  store.setPathValid(true);
  store.setProjectValid(true);
  store.setAdminPath(draft.path.adminPath);
}

function persistPolicyPreset(preset: PolicyPresetId): void {
  const parsed = lockoutPolicySchema.parse({
    ...POLICY_PRESETS[preset],
  });
  setPolicyDraft(parsed);
  useSetupStore.getState().setPolicyValid(true);
}

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid value.';
}

function describePreset(preset: PolicyPresetId): string {
  switch (preset) {
    case 'strict':
      return 'Tighter lockouts and all anomaly checks.';
    case 'lenient':
      return 'Lower-friction lockouts for private dev instances.';
    case 'standard':
      return 'Recommended defaults for new production projects.';
  }
}

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function readSetupTokenForRequest(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.sessionStorage.getItem(SETUP_TOKEN_STORAGE_KEY);
    if (stored && stored.trim().length > 0) return stored;
  } catch {
    // sessionStorage may be unavailable.
  }
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get('token');
    if (fromQuery && fromQuery.trim().length > 0) return fromQuery;
  } catch {
    // ignore malformed URLs.
  }
  return null;
}

function clearSetupToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(SETUP_TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

async function postSetupComplete(body: {
  account: AccountFormValues;
  adminPath: string;
  policy: LockoutPolicyFormValues;
  project: ProjectConfigurationFormValues;
  invites: InviteDraft[];
}): Promise<SetupCompleteResponse> {
  const token = readSetupTokenForRequest();
  // Omit `invites` entirely when empty so the request matches the original
  // shape on a no-invite setup (the field is optional server-side).
  const payload = body.invites.length > 0 ? body : { ...body, invites: undefined };
  const response = await fetch('/api/v1/setup/complete', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(
      token === null ? payload : { ...payload, setupToken: token },
    ),
  });

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (response.status !== 201) {
    throw new Error(extractSetupErrorMessage(parsed, response.status));
  }

  if (!isSetupCompleteResponse(parsed)) {
    throw new Error('Setup completed, but the response shape was unexpected.');
  }
  return parsed;
}

function extractSetupErrorMessage(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null) {
    const errors = (body as { errors?: Array<{ message?: string }> }).errors;
    const message = errors?.[0]?.message;
    if (message) return message;
  }
  return `Setup failed with HTTP ${status}.`;
}

function isSetupCompleteResponse(value: unknown): value is SetupCompleteResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SetupCompleteResponse>;
  return (
    typeof candidate.adminPath === 'string' &&
    Array.isArray(candidate.backupCodes) &&
    candidate.backupCodes.every((code) => typeof code === 'string') &&
    candidate.setupToken === null
  );
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/**
 * Reduce the wizard's invite rows to a clean payload for the API: trim +
 * lowercase emails, drop empty/invalid rows, and de-duplicate by email
 * (first occurrence wins). The server re-validates and re-de-dupes, so this
 * is purely to avoid sending obvious junk.
 */
function sanitizeInvites(invites: InviteDraft[]): InviteDraft[] {
  const seen = new Set<string>();
  const result: InviteDraft[] = [];
  for (const invite of invites) {
    const email = invite.email.trim().toLowerCase();
    if (!email || !isValidEmail(email) || seen.has(email)) continue;
    seen.add(email);
    result.push({ email, role: invite.role });
  }
  return result;
}

function buildAdminLoginUrl(adminPath: string): string {
  const normalized = adminPath.startsWith('/') ? adminPath : `/${adminPath}`;
  return `${normalized}/login`;
}

const primaryButtonClass =
  'inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50';

const secondaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';

function inputClass(hasError: boolean, extra = ''): string {
  const base =
    'block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-primary/30';
  const border = hasError
    ? 'border-red-500 focus:border-red-500 focus:ring-red-500/30'
    : 'border-border focus:border-primary';
  return `${base} ${border} ${extra}`.trim();
}

export default SimpleSetupWizard;
