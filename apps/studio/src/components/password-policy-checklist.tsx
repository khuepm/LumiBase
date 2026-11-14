import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { useMemo } from 'react';
import {
  DEFAULT_PASSWORD_POLICY,
  evaluatePasswordPolicy,
  toPublicPasswordPolicy,
  type PasswordRuleId,
  type PasswordRuleResult,
  type PasswordStrengthScore,
  type PublicPasswordPolicy,
} from '@lumibase/contracts/schemas';
import { getApiBaseUrl } from '@/lib/api-base';

/**
 * Live password checklist + strength meter (#733).
 *
 * Driven by the SAME `evaluatePasswordPolicy` the CMS runs on every
 * password-setting route, against the rule set from the public
 * `GET /api/v1/auth/password-policy` — so a green checklist means the server
 * will accept the password (bar the optional server-only breach check, whose
 * verdict is shown from the 400 body via `serverRules`).
 *
 * Used by: Settings → Security (change password), the backup-code recovery
 * reset, and — for its rule rows — the setup wizard's account step.
 */

export const PASSWORD_POLICY_QUERY_KEY = ['auth-password-policy'] as const;

const FALLBACK_POLICY: PublicPasswordPolicy = toPublicPasswordPolicy(DEFAULT_PASSWORD_POLICY);

async function fetchPasswordPolicy(): Promise<PublicPasswordPolicy> {
  const res = await fetch(`${getApiBaseUrl()}/api/v1/auth/password-policy`, {
    headers: { Accept: 'application/json', 'X-Lumi-Client': 'studio' },
  });
  if (!res.ok) throw new Error('Failed to load the password policy.');
  return ((await res.json()) as { data: PublicPasswordPolicy }).data;
}

/**
 * The instance's public password rule set. Until it loads (or if it cannot
 * load) the default policy is shown — the server still enforces the real one
 * and answers with per-rule errors, so the worst case is a checklist that is
 * slightly off, never a bypass.
 */
export function usePasswordPolicy(): PublicPasswordPolicy {
  const query = useQuery({
    queryKey: PASSWORD_POLICY_QUERY_KEY,
    queryFn: fetchPasswordPolicy,
    staleTime: 60_000,
    retry: false,
  });
  return query.data ?? FALLBACK_POLICY;
}

/** Pull the per-rule list out of a `PASSWORD_POLICY` error body, if that is what it is. */
export function readPasswordPolicyError(body: unknown): PasswordRuleResult[] | null {
  const first = (body as { errors?: Array<{ code?: string; rules?: PasswordRuleResult[] }> } | null)?.errors?.[0];
  return first?.code === 'PASSWORD_POLICY' && Array.isArray(first.rules) ? first.rules : null;
}

export const STRENGTH_LABELS: Readonly<Record<PasswordStrengthScore, string>> = {
  0: 'Very weak',
  1: 'Weak',
  2: 'Fair',
  3: 'Strong',
  4: 'Very strong',
};

const STRENGTH_BAR_COLORS: Readonly<Record<PasswordStrengthScore, string>> = {
  0: 'bg-red-500',
  1: 'bg-red-500',
  2: 'bg-amber-500',
  3: 'bg-emerald-500',
  4: 'bg-emerald-600',
};

function ruleLabel(rule: PasswordRuleId, policy: PublicPasswordPolicy): string {
  switch (rule) {
    case 'min_length':
      return `At least ${policy.minLength} characters`;
    case 'max_length':
      return `At most ${policy.maxLength} characters`;
    case 'lowercase':
      return 'Includes a lowercase letter';
    case 'uppercase':
      return 'Includes an uppercase letter';
    case 'digit':
      return 'Includes a digit';
    case 'special':
      return `Includes a special character (${policy.specialChars})`;
    case 'min_strength':
      return `Hard to guess (strength “${STRENGTH_LABELS[policy.minStrength as PasswordStrengthScore]}” or better)`;
    case 'not_breached':
      return 'Not found in known data breaches';
  }
}

export interface PasswordPolicyChecklistProps {
  /** Base id; the meter is `${id}-strength`, the list `${id}-rules` (for aria-describedby). */
  id: string;
  password: string;
  policy: PublicPasswordPolicy;
  /** E-mail / names of the account — passwords built from them score lower. */
  userInputs?: ReadonlyArray<string | null | undefined>;
  /** Rules from the server's last `PASSWORD_POLICY` answer (shows e.g. `not_breached`). */
  serverRules?: ReadonlyArray<PasswordRuleResult> | null;
}

/** `true` when the client-side rules all pass — use it to gate the submit button. */
export function passwordMeetsPolicy(
  password: string,
  policy: PublicPasswordPolicy,
  userInputs: ReadonlyArray<string | null | undefined> = [],
): boolean {
  return evaluatePasswordPolicy(password, policy, userInputs).ok;
}

const NO_INPUTS: ReadonlyArray<string> = [];

export function PasswordPolicyChecklist({ id, password, policy, userInputs = NO_INPUTS, serverRules }: PasswordPolicyChecklistProps) {
  const evaluation = useMemo(
    () => evaluatePasswordPolicy(password, policy, userInputs),
    [password, policy, userInputs],
  );
  const empty = password.length === 0;
  // `max_length` is noise unless it fails.
  const rows = evaluation.rules.filter((r) => r.rule !== 'max_length' || !r.ok);
  const breach = serverRules?.find((r) => r.rule === 'not_breached');
  const strengthRule = evaluation.rules.find((r) => r.rule === 'min_strength');

  return (
    <div className="mt-2 space-y-2">
      <div
        id={`${id}-strength`}
        className="flex items-center gap-2"
        aria-live="polite"
        aria-label={empty ? 'Password strength: none' : `Password strength: ${STRENGTH_LABELS[evaluation.score]}`}
      >
        <div className="flex flex-1 gap-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              aria-hidden="true"
              className={`h-1.5 flex-1 rounded-full ${
                !empty && i <= evaluation.score ? STRENGTH_BAR_COLORS[evaluation.score] : 'bg-muted'
              }`}
            />
          ))}
        </div>
        {!empty ? (
          <span className="w-20 text-right text-xs text-muted-foreground">{STRENGTH_LABELS[evaluation.score]}</span>
        ) : null}
      </div>

      {!empty && strengthRule && !strengthRule.ok ? (
        <p className="text-xs text-red-600">{strengthRule.message}</p>
      ) : null}

      <ul id={`${id}-rules`} className="space-y-1 text-xs" aria-label="Password requirements">
        {rows.map((r) => (
          <RuleRow key={r.rule} ok={!empty && r.ok} label={ruleLabel(r.rule, policy)} />
        ))}
        {policy.breachCheck ? (
          breach ? (
            <RuleRow ok={breach.ok} label={breach.ok ? ruleLabel('not_breached', policy) : breach.message} />
          ) : (
            <li className="text-muted-foreground">Checked against known data breaches when you save.</li>
          )
        ) : null}
      </ul>
    </div>
  );
}

function RuleRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 ${ok ? 'text-emerald-600' : 'text-muted-foreground'}`}>
      {ok ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <X className="h-3.5 w-3.5" aria-hidden="true" />}
      <span>{label}</span>
      <span className="sr-only">{ok ? '(met)' : '(not met)'}</span>
    </li>
  );
}
