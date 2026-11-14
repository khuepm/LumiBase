import { useMutation } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import type { PasswordRuleResult } from '@lumibase/contracts/schemas';
import { getActiveSite, getActiveToken, handleUnauthorized } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';
import {
  PasswordPolicyChecklist,
  passwordMeetsPolicy,
  readPasswordPolicyError,
  usePasswordPolicy,
} from '@/components/password-policy-checklist';

/**
 * Change password (#733) — `POST /api/v1/me/change-password`.
 *
 * Live checklist + strength meter come from the shared policy evaluator, so
 * the button only enables once the server's rules pass. A `PASSWORD_POLICY`
 * answer (e.g. the optional breach check, or the account e-mail inside the
 * password) is shown rule by rule. On success the server revokes every
 * session of the account, so the Studio sends the user to sign in again.
 *
 * Same bearer + `getApiBaseUrl()` plumbing as the other Security sections
 * (desktop shell contract C2).
 */

const headers = () => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'X-Lumi-Site': getActiveSite(),
  'X-Lumi-Client': 'studio',
  Authorization: `Bearer ${getActiveToken()}`,
});

class ChangePasswordError extends Error {
  constructor(
    message: string,
    readonly rules: PasswordRuleResult[] | null,
  ) {
    super(message);
  }
}

export function ChangePasswordSection() {
  const baseId = useId();
  const policy = usePasswordPolicy();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<ChangePasswordError | null>(null);
  const [done, setDone] = useState(false);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${getApiBaseUrl()}/api/v1/me/change-password`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { errors?: { message?: string }[] } | null;
        throw new ChangePasswordError(
          body?.errors?.[0]?.message ?? 'Could not change the password.',
          readPasswordPolicyError(body),
        );
      }
    },
    onSuccess: () => {
      setError(null);
      setDone(true);
      // Every session (this one included) was revoked server-side.
      setTimeout(() => handleUnauthorized(), 1500);
    },
    onError: (err: Error) => setError(err instanceof ChangePasswordError ? err : new ChangePasswordError(err.message, null)),
  });

  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit =
    current.length > 0 && passwordMeetsPolicy(next, policy) && confirm === next && !mutation.isPending && !done;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (canSubmit) mutation.mutate();
  };

  return (
    <section className="rounded-md border border-border bg-background p-4 space-y-3">
      <h2 className="flex items-center gap-2 font-medium">
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        Change password
      </h2>
      {done ? (
        <p role="status" className="text-sm text-emerald-700">
          Password changed. All sessions were signed out — sign in again with your new password.
        </p>
      ) : (
        <form className="space-y-3" onSubmit={onSubmit}>
          <div className="space-y-1">
            <label htmlFor={`${baseId}-current`} className="block text-sm font-medium">Current password</label>
            <input
              id={`${baseId}-current`}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${baseId}-new`} className="block text-sm font-medium">New password</label>
            <input
              id={`${baseId}-new`}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => {
                setNext(e.target.value);
                setError(null);
              }}
              aria-describedby={`${baseId}-new-strength ${baseId}-new-rules`}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <PasswordPolicyChecklist id={`${baseId}-new`} password={next} policy={policy} serverRules={error?.rules} />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${baseId}-confirm`} className="block text-sm font-medium">Confirm new password</label>
            <input
              id={`${baseId}-confirm`}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch ? 'true' : 'false'}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            {mismatch ? <p className="text-xs text-red-600">Passwords do not match.</p> : null}
          </div>
          {error ? (
            <div role="alert" className="text-sm text-red-600">
              {error.rules ? (
                <ul className="list-disc pl-5">
                  {error.rules.filter((r) => !r.ok).map((r) => (
                    <li key={r.rule}>{r.message}</li>
                  ))}
                </ul>
              ) : (
                error.message
              )}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-60"
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Change password
          </button>
        </form>
      )}
    </section>
  );
}
