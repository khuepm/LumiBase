import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { MailQuestion, MailCheck } from 'lucide-react';
import { useId } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { z } from 'zod';
import { parseRetryAfterSeconds, formatWait } from './backup-code-page';

/**
 * "Forgot admin path" page — PUBLIC, pre-auth recovery UI.
 *
 * Implements Req 14.5 and design.md §5.1 (the `/recovery/*` routes under
 * `publicLayoutRoute`). Counterpart to the CMS endpoint from task 10.7:
 *
 *   POST /api/v1/admin/security/forgot-path
 *     body { email }
 *     → 200 { data: { sent: true } }   (ALWAYS — anti-enumeration)
 *     → 429 { errors: [{ code: 'RATE_LIMITED' }] } + Retry-After header
 *
 * ── Anti-enumeration is the whole point (Req 14.5) ───────────────────
 *
 * The server returns the SAME generic 200 whether or not the email
 * matches the Bootstrap Admin — it never reveals which accounts exist.
 * This page mirrors that faithfully: ANY 200 (and even a network error,
 * treated gracefully) renders ONE generic success message
 * ("If that email belongs to the admin account, we've sent recovery
 * instructions…"). The message is identical regardless of the input, so
 * the UI leaks nothing the server doesn't.
 *
 * Only a 429 RATE_LIMITED breaks the uniform success — and that's a
 * property of the requester's IP, not of any account's existence, so
 * surfacing it doesn't enable enumeration.
 *
 * ── Network errors are treated as success ────────────────────────────
 *
 * A network failure could otherwise become a side channel ("the request
 * to that email hung → maybe it triggered a real send"). To keep the
 * observable behaviour uniform we render the same generic success panel
 * on a network error as on a 200. The operator is told to check their
 * inbox; if nothing arrives they can retry. This is deliberate — see the
 * mutation's error handling below.
 *
 * ── Accessibility ────────────────────────────────────────────────────
 *
 *   - `useId()`-driven label/error wiring; `<label htmlFor>`.
 *   - `aria-invalid` + `aria-describedby` for the inline email error.
 *   - The rate-limit banner is `role="alert"`; the success panel uses
 *     `aria-live="polite"`.
 *   - A link back to `/recovery/backup-code`.
 *
 * ── i18n ─────────────────────────────────────────────────────────────
 *
 * Inline English copy, matching the deliberate convention of the setup
 * steps. A swap to keys under `recovery.forgotPath.*` (design §5.6) is a
 * tracked follow-up; we do NOT block this page on wiring backend i18n.
 *
 * Spec refs: requirements §14.5; design.md §5.1 (route tree), §4.8
 * (endpoint contract), §5.6 (i18n keys — follow-up).
 */

// ────────────────────────────────────────────────────────────────────────
// Form schema
// ────────────────────────────────────────────────────────────────────────

const forgotPathSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
});

type ForgotPathFormValues = z.infer<typeof forgotPathSchema>;

// ────────────────────────────────────────────────────────────────────────
// Request types
// ────────────────────────────────────────────────────────────────────────

/**
 * Outcome of a forgot-path submit. We collapse the security-relevant
 * branches deliberately:
 *
 *   - 'sent'        → any 200 OR a network error (uniform success copy).
 *   - 'rate_limited'→ 429; carries the optional `Retry-After` wait.
 */
export type ForgotPathOutcome =
  | { kind: 'sent' }
  | { kind: 'rate_limited'; retryAfterSeconds: number | undefined };

/**
 * POST the forgot-path request. NEVER throws for the success/network
 * branches — it resolves to a `ForgotPathOutcome` so the UI can stay
 * uniform. A 429 resolves to `rate_limited`; everything else (200, 4xx
 * other than 429, 5xx, network error) resolves to `sent`, keeping the
 * observable behaviour indistinguishable across account existence.
 */
async function postForgotPath(
  values: ForgotPathFormValues,
): Promise<ForgotPathOutcome> {
  let response: Response;
  try {
    response = await fetch('/api/v1/admin/security/forgot-path', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ email: values.email }),
    });
  } catch {
    // Network error → treat as generic success to avoid a side channel.
    return { kind: 'sent' };
  }

  if (response.status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(
      response.headers.get('Retry-After'),
    );
    return { kind: 'rate_limited', retryAfterSeconds };
  }

  // 200 (the documented happy path) and any other non-429 status all map
  // to the same generic success — the server already guarantees a 200 for
  // the real flow, and we refuse to differentiate the rest.
  return { kind: 'sent' };
}

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

export function ForgotPathPage() {
  const emailId = useId();
  const bannerId = useId();

  const form = useForm<ForgotPathFormValues>({
    resolver: zodResolver(forgotPathSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { email: '' },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form;

  const mutation = useMutation<ForgotPathOutcome, never, ForgotPathFormValues>({
    mutationKey: ['recovery', 'forgot-path'],
    mutationFn: postForgotPath,
    retry: false,
  });

  const onSubmit: SubmitHandler<ForgotPathFormValues> = (values) => {
    mutation.mutate(values);
  };

  // A successful submit (whether the email matched or not) flips to the
  // generic confirmation panel.
  if (mutation.isSuccess && mutation.data.kind === 'sent') {
    return <ForgotPathSentPanel />;
  }

  const rateLimited =
    mutation.isSuccess && mutation.data.kind === 'rate_limited'
      ? mutation.data
      : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md rounded-xl border bg-background p-8 shadow-sm">
        <form noValidate className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <header className="space-y-2">
            <div className="flex items-center gap-2">
              <MailQuestion
                className="h-5 w-5 text-primary"
                aria-hidden="true"
              />
              <h1 className="text-lg font-semibold tracking-tight">
                Recover your admin path
              </h1>
            </div>
            <p className="text-sm text-muted-foreground">
              Enter the admin email. If it matches the admin account,
              we&rsquo;ll email you instructions to get back in.
            </p>
          </header>

          {/* ── Rate-limit banner ────────────────────────────────────── */}
          {rateLimited ? (
            <div
              id={bannerId}
              role="alert"
              className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200"
            >
              {rateLimited.retryAfterSeconds !== undefined
                ? `Too many recovery attempts. Try again in about ${formatWait(
                  rateLimited.retryAfterSeconds,
                )}.`
                : 'Too many recovery attempts. Try again later.'}
            </div>
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

          {/* ── Submit ───────────────────────────────────────────────── */}
          <button
            type="submit"
            disabled={isSubmitting || mutation.isPending}
            className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mutation.isPending ? 'Sending…' : 'Send recovery instructions'}
          </button>

          {/* ── Have-a-code link ─────────────────────────────────────── */}
          <p className="text-center text-sm text-muted-foreground">
            Have a backup code?{' '}
            <a
              href="backup-code"
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              Recover with a backup code
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

/**
 * Generic confirmation panel. Rendered on ANY successful submit
 * regardless of whether the email matched — the copy is identical so it
 * never reveals account existence (Req 14.5).
 */
function ForgotPathSentPanel() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md space-y-6 rounded-xl border bg-background p-8 shadow-sm">
        <header className="space-y-2">
          <div className="flex items-center gap-2">
            <MailCheck className="h-5 w-5 text-emerald-600" aria-hidden="true" />
            <h1 className="text-lg font-semibold tracking-tight">
              Check your inbox
            </h1>
          </div>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            If that email belongs to the admin account, we&rsquo;ve sent
            recovery instructions. Check your inbox (and spam folder).
          </p>
        </header>

        <p className="text-center text-sm text-muted-foreground">
          Have a backup code instead?{' '}
            <a
              href="backup-code"
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
            Recover with a backup code
          </a>
          .
        </p>
      </div>
    </div>
  );
}

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}

/**
 * Label + inline error wrapper. Owns the `<label htmlFor>` linkage so the
 * input gets a clickable label and a stable `role="alert"` error region.
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

function inputClass(hasError: boolean, extra = ''): string {
  const base =
    'block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-primary/30';
  const border = hasError
    ? 'border-red-500 focus:border-red-500 focus:ring-red-500/30'
    : 'border-border focus:border-primary';
  return `${base} ${border} ${extra}`.trim();
}

export default ForgotPathPage;
