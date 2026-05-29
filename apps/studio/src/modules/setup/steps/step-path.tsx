import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import {
  ADMIN_PATH_REGEX,
  adminPathSchema,
  normalizeAdminPath,
  type AdminPathFormValues,
} from '../schemas/admin-path';
import { useSetupStore } from '../setup-store';
import { wordlistGenerateUnique } from '../wordlist';

/**
 * "Admin Path" step of the Setup Wizard.
 *
 * Implements Req 4.1, 4.2, 4.5; design.md §5.5:
 *
 *   - React Hook Form + Zod resolver against `adminPathSchema`. The
 *     schema runs `normalizeAdminPath` first so all downstream rules
 *     (regex, blacklist, reserved prefixes — Req 4.2–4.4, 4.8) operate
 *     on the canonical `/<slug>` form.
 *   - "Generate Random" button calls `wordlistGenerateUnique` (≥256
 *     curated words + 6 hex chars, max 8 retries against the
 *     blacklist) and writes the result back into the form. If the
 *     generator exhausts its retry budget — extremely unlikely with
 *     the current wordlist, see `wordlist.ts` — we surface an inline
 *     error rather than swallow it (Req 4.1).
 *   - Live preview box below the input shows the normalised form so
 *     the operator can see exactly what will be stored. Whitespace,
 *     trailing slashes, and case differences in the raw input collapse
 *     into a single canonical string.
 *   - Yellow warning banner above the submit button restates Req 4.5
 *     ("Save this path. Losing it means running the recovery flow.")
 *     and is the visible context for the confirm-checkbox gate.
 *   - Confirm checkbox ("I have saved my admin path.") is required
 *     before submit becomes enabled. This mirrors the pattern from the
 *     Recovery step's "I have saved my backup codes" gate (Req 14.3).
 *
 * What this file deliberately does NOT do:
 *   - It does not navigate to `/setup/security` after submit. The
 *     parent shell drives navigation via `onSubmitted` once routes are
 *     wired in task 3.9.
 *   - It does not localize copy. Strings stay inline; task 3.10 swaps
 *     them for i18n keys.
 *   - It does not check the path against the server-side
 *     `system_state.admin_path` uniqueness — that's the CMS's job at
 *     `POST /setup/complete` (task 2.3). The client-side schema only
 *     enforces the deterministic format/blacklist rules.
 */

// ────────────────────────────────────────────────────────────────────────
// In-memory path draft
//
// Mirrors the pattern from `step-account.tsx`: the persisted Zustand
// store deliberately holds only validity flags + the post-completion
// `adminPath` (see setup-store.ts), so we cache the chosen value here
// in module memory until `useCompleteSetup` (task 3.8) flushes it to
// `POST /api/v1/setup/complete`. Living only in heap means a refresh
// resets the wizard cleanly without ever touching `sessionStorage`.
// ────────────────────────────────────────────────────────────────────────

let pathDraft: AdminPathFormValues | null = null;

/** Read the in-memory admin-path draft, or `null` if not yet captured. */
export function getPathDraft(): AdminPathFormValues | null {
  return pathDraft;
}

/** Drop the draft. Call after `POST /setup/complete` succeeds. */
export function clearPathDraft(): void {
  pathDraft = null;
}

function setPathDraftInternal(value: AdminPathFormValues): void {
  pathDraft = value;
}

// ────────────────────────────────────────────────────────────────────────
// Form values type
// ────────────────────────────────────────────────────────────────────────

/**
 * The form keeps the *raw* input string the operator types so React
 * Hook Form can render it back unmodified between keystrokes. The Zod
 * schema's transform produces the *normalised* string, which is what
 * `AdminPathFormValues` carries — used only at submit time and for the
 * draft cache. We type the form locally to disambiguate.
 */
interface AdminPathFormFields {
  adminPath: string;
}

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

export interface StepPathProps {
  /**
   * Optional callback invoked after the form passes validation, the
   * confirm checkbox is ticked, and the draft + store flag have been
   * updated. Routes in task 3.9 use it to navigate to
   * `/setup/security`.
   */
  onSubmitted?: (values: AdminPathFormValues) => void;
}

export function StepPath({ onSubmitted }: StepPathProps) {
  const setPathValid = useSetupStore((s) => s.setPathValid);
  const setStoreAdminPath = useSetupStore((s) => s.setAdminPath);

  // Identity-stable IDs for aria-* wiring.
  const inputId = useId();
  const previewId = useId();
  const warningId = useId();
  const confirmId = useId();
  const generateErrorId = useId();

  const form = useForm<AdminPathFormFields>({
    resolver: zodResolver(adminPathSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    shouldUnregister: false,
    defaultValues: {
      adminPath: pathDraft?.adminPath ?? '',
    },
  });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    trigger,
    formState: { errors, isSubmitting, isValid },
  } = form;

  const rawValue = watch('adminPath') ?? '';

  // Normalised preview — recomputed every keystroke. We deliberately
  // call `normalizeAdminPath` directly (rather than reading the
  // resolver's output) so the preview updates instantly on input,
  // including before the resolver has run on first focus.
  const preview = useMemo(() => {
    if (rawValue.length === 0) return null;
    const normalized = normalizeAdminPath(rawValue);
    if (normalized === null) return { kind: 'invalid' as const };
    return {
      kind: 'ok' as const,
      value: normalized,
      matchesFormat: ADMIN_PATH_REGEX.test(normalized),
    };
  }, [rawValue]);

  // ── Confirm-checkbox gate ──────────────────────────────────────────
  // The checkbox is local component state rather than a form field so
  // its value never lands in the schema's normalised output. We only
  // need it to gate submit + flag the wizard's `pathValid` state.
  const [confirmed, setConfirmed] = useState<boolean>(false);

  // ── Generator state ────────────────────────────────────────────────
  // `generateError` is set when `wordlistGenerateUnique` exhausts its
  // retry budget; cleared on the next successful generation or on any
  // input change so the operator isn't stuck staring at a stale error.
  const [generateError, setGenerateError] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    const candidate = wordlistGenerateUnique();
    if (candidate === null) {
      setGenerateError(
        "Couldn't generate a unique path. Try again or enter one manually.",
      );
      return;
    }
    setGenerateError(null);
    setValue('adminPath', candidate, {
      shouldValidate: true,
      shouldDirty: true,
      shouldTouch: true,
    });
    // Force a re-validation so the resolver-driven `errors` map clears
    // the previous user input's diagnostics in time for the preview.
    await trigger('adminPath');
  }, [setValue, trigger]);

  // Clear any lingering generator error when the user starts typing.
  useEffect(() => {
    if (rawValue.length === 0) return;
    setGenerateError((prev) => (prev !== null ? null : prev));
  }, [rawValue]);

  // Gate the submit button. We require:
  //   - the form to be valid per the resolver,
  //   - the operator to have ticked the confirm checkbox,
  //   - the form not to be mid-submission.
  const submitDisabled = isSubmitting || !isValid || !confirmed;

  // Whenever the form drops out of "valid + confirmed" (e.g. operator
  // edits the field after a successful preview, or unticks the
  // checkbox) flip the wizard's `pathValid` flag so the deep-link
  // guard at `/setup/security` redirects back here.
  useEffect(() => {
    if (!isValid || !confirmed) {
      setPathValid(false);
    }
  }, [isValid, confirmed, setPathValid]);

  const onSubmit: SubmitHandler<AdminPathFormFields> = useCallback(
    (values) => {
      // Defence in depth: re-check the gate even if the disabled state
      // somehow lapsed.
      if (!confirmed) return;

      // The resolver-transformed value is what we want to persist.
      // `values.adminPath` is already the normalised form because the
      // schema's transform runs before validation surfaces here.
      const normalized = values.adminPath;

      setPathDraftInternal({ adminPath: normalized });
      setStoreAdminPath(normalized);
      setPathValid(true);
      onSubmitted?.({ adminPath: normalized });
    },
    [confirmed, onSubmitted, setPathValid, setStoreAdminPath],
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
          Choose a private admin path
        </h2>
        <p className="text-sm text-muted-foreground">
          Pick a URL slug that bots won&rsquo;t guess. The Studio will
          only respond at this path; everything else returns 404.
        </p>
      </header>

      {/* ── Admin path field ──────────────────────────────────────── */}
      <Field
        id={inputId}
        label="Admin path"
        error={errors.adminPath?.message}
        helpText="Use lowercase letters, digits, and hyphens. 4–64 characters after the leading slash."
      >
        <div className="flex gap-2">
          <input
            id={inputId}
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="/lumi-7f3a9c"
            aria-invalid={errors.adminPath ? 'true' : 'false'}
            aria-describedby={[
              errors.adminPath ? `${inputId}-error` : null,
              `${inputId}-help`,
              preview ? previewId : null,
              generateError ? generateErrorId : null,
            ]
              .filter(Boolean)
              .join(' ') || undefined}
            className={inputClass(Boolean(errors.adminPath))}
            {...register('adminPath')}
          />
          <button
            type="button"
            onClick={handleGenerate}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Generate random
          </button>
        </div>
        {generateError ? (
          <p
            id={generateErrorId}
            role="alert"
            className="mt-1 text-xs text-red-600"
          >
            {generateError}
          </p>
        ) : null}
      </Field>

      {/* ── Live normalised preview ───────────────────────────────── */}
      {preview ? (
        <PathPreview id={previewId} preview={preview} />
      ) : null}

      {/* ── Save-the-path warning banner (Req 4.5) ────────────────── */}
      <aside
        id={warningId}
        role="note"
        className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100"
      >
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <div className="space-y-1 text-sm">
          <p className="font-medium">Save this path.</p>
          <p className="text-amber-900/90 dark:text-amber-100/90">
            Losing it means running the recovery flow with one of your
            backup codes. Bookmark the URL, store it in your password
            manager, or write it down somewhere safe before continuing.
          </p>
        </div>
      </aside>

      {/* ── Confirm-checkbox gate ────────────────────────────────── */}
      <div className="rounded-md border border-border bg-muted/40 p-4">
        <label
          htmlFor={confirmId}
          className="flex items-start gap-3 text-sm"
        >
          <input
            id={confirmId}
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-2 focus:ring-primary/30"
            aria-describedby={warningId}
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span className="text-foreground">
            I have saved my admin path. I understand losing it requires
            the recovery flow.
          </span>
        </label>
      </div>

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
// Sub-components
// ────────────────────────────────────────────────────────────────────────

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  helpText?: string;
  children: ReactNode;
}

function Field({ id, label, error, helpText, children }: FieldProps) {
  const helpId = `${id}-help`;
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="block text-sm font-medium text-foreground"
      >
        {label}
      </label>
      {children}
      {helpText ? (
        <p id={helpId} className="text-xs text-muted-foreground">
          {helpText}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type PreviewState =
  | { kind: 'invalid' }
  | { kind: 'ok'; value: string; matchesFormat: boolean };

interface PathPreviewProps {
  id: string;
  preview: PreviewState;
}

function PathPreview({ id, preview }: PathPreviewProps) {
  if (preview.kind === 'invalid') {
    return (
      <p
        id={id}
        className="text-xs text-muted-foreground"
        aria-live="polite"
      >
        Preview: <span className="font-mono">(invalid format)</span>
      </p>
    );
  }

  return (
    <p
      id={id}
      className="text-xs text-muted-foreground"
      aria-live="polite"
    >
      Preview:{' '}
      <code
        className={
          preview.matchesFormat
            ? 'font-mono text-foreground'
            : 'font-mono text-muted-foreground'
        }
      >
        {preview.value}
      </code>
    </p>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Styling helper
// ────────────────────────────────────────────────────────────────────────

function inputClass(hasError: boolean, extra = ''): string {
  const base =
    'block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-primary/30 font-mono';
  const border = hasError
    ? 'border-red-500 focus:border-red-500 focus:ring-red-500/30'
    : 'border-border focus:border-primary';
  return `${base} ${border} ${extra}`.trim();
}

export default StepPath;
