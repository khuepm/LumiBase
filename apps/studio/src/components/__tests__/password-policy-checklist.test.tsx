// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { DEFAULT_PASSWORD_POLICY, toPublicPasswordPolicy } from '@lumibase/contracts/schemas';

import {
  PasswordPolicyChecklist,
  passwordMeetsPolicy,
  readPasswordPolicyError,
} from '../password-policy-checklist';
import { ChangePasswordSection } from '../../modules/settings/change-password-section';

/**
 * Studio side of #733: the live checklist + meter run the shared
 * `evaluatePasswordPolicy`, and a `PASSWORD_POLICY` answer from the server is
 * shown rule by rule.
 */

const policy = toPublicPasswordPolicy(DEFAULT_PASSWORD_POLICY);

function withClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PasswordPolicyChecklist', () => {
  it('marks each rule met / not met as the password changes', () => {
    const { rerender } = render(<PasswordPolicyChecklist id="pw" password="abc" policy={policy} />);
    expect(screen.getByText('At least 12 characters').parentElement).toHaveTextContent('(not met)');
    expect(screen.getByText('Includes a lowercase letter').parentElement).toHaveTextContent('(met)');

    rerender(<PasswordPolicyChecklist id="pw" password="CorrectHorseBatteryStaple!42" policy={policy} />);
    for (const li of screen.getAllByRole('listitem')) expect(li).toHaveTextContent('(met)');
    expect(screen.getByLabelText('Password strength: Very strong')).toBeInTheDocument();
  });

  it('explains why a rule-compliant password is still too guessable', () => {
    render(<PasswordPolicyChecklist id="pw" password="Password1234!" policy={policy} />);
    expect(screen.getByText(/commonly used password/)).toBeInTheDocument();
  });

  it('follows the instance policy (e.g. a longer minimum)', () => {
    render(<PasswordPolicyChecklist id="pw" password="x" policy={{ ...policy, minLength: 20 }} />);
    expect(screen.getByText('At least 20 characters')).toBeInTheDocument();
  });

  it('announces the server-only breach check, then shows its verdict', () => {
    const breachPolicy = { ...policy, breachCheck: true };
    const { rerender } = render(<PasswordPolicyChecklist id="pw" password="x" policy={breachPolicy} />);
    expect(screen.getByText(/Checked against known data breaches/)).toBeInTheDocument();
    rerender(
      <PasswordPolicyChecklist
        id="pw"
        password="x"
        policy={breachPolicy}
        serverRules={[{ rule: 'not_breached', ok: false, message: 'This password appears in known data breaches.' }]}
      />,
    );
    expect(screen.getByText('This password appears in known data breaches.')).toBeInTheDocument();
  });

  it('helpers: passwordMeetsPolicy + readPasswordPolicyError', () => {
    expect(passwordMeetsPolicy('CorrectHorseBatteryStaple!42', policy)).toBe(true);
    expect(passwordMeetsPolicy('short', policy)).toBe(false);
    const rules = [{ rule: 'min_length', ok: false, message: 'm' }];
    expect(readPasswordPolicyError({ errors: [{ code: 'PASSWORD_POLICY', rules }] })).toEqual(rules);
    expect(readPasswordPolicyError({ errors: [{ code: 'VALIDATION' }] })).toBeNull();
  });
});

describe('ChangePasswordSection', () => {
  it('keeps submit disabled until the policy passes, then shows server rule failures', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.endsWith('/api/v1/auth/password-policy')) {
          return new Response(JSON.stringify({ data: { ...policy, breachCheck: true } }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            errors: [
              {
                code: 'PASSWORD_POLICY',
                message: 'Password does not meet the policy',
                rules: [{ rule: 'not_breached', ok: false, message: 'This password appears in known data breaches. Choose a different one.' }],
              },
            ],
          }),
          { status: 400 },
        );
      }),
    );

    withClient(<ChangePasswordSection />);
    const submit = screen.getByRole('button', { name: 'Change password' });
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old-password' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'weak' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'weak' } });
    expect(submit).toBeDisabled();

    const strong = 'CorrectHorseBatteryStaple!42';
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: strong } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: strong } });
    await waitFor(() => expect(screen.getByText(/Checked against known data breaches/)).toBeInTheDocument());
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('appears in known data breaches'));
    expect(calls.some((u) => u.endsWith('/api/v1/me/change-password'))).toBe(true);
  });
});
