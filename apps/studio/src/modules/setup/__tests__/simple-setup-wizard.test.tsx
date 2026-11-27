// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

import { SimpleSetupWizard } from '../simple-setup-wizard';
import { PRESET_EMAIL_IDENTITY_MODE } from '../setup-drafts';
import { clearEmailIdentityModeDraft, getEmailIdentityModeDraft } from '../steps/step-security';
import { setAccountDraft } from '../steps/step-account';

/**
 * Quick setup review step: docs links (#1039), preset-driven email identity
 * (#1041) and the advanced-setup shortcut in the warning callout (#1043).
 */

async function openReviewStep(): Promise<void> {
  setAccountDraft({
    email: 'admin@example.com',
    password: 'CorrectHorse!Battery9',
    confirmPassword: 'CorrectHorse!Battery9',
    firstName: 'Ada',
    lastName: 'Lovelace',
  });
  render(<SimpleSetupWizard />);
  fireEvent.click(screen.getByRole('button', { name: /Next: Review security defaults/ }));
  await screen.findByText('Review what quick setup will apply');
}

function selectedEmailIdentity(): string | undefined {
  const radios = screen.getAllByRole('radio') as HTMLInputElement[];
  return radios.find((r) => r.checked)?.value;
}

beforeEach(() => navigate.mockReset());
afterEach(() => {
  cleanup();
  clearEmailIdentityModeDraft();
});

describe('PRESET_EMAIL_IDENTITY_MODE', () => {
  it('maps strict to one account per mailbox and the rest to exact', () => {
    expect(PRESET_EMAIL_IDENTITY_MODE).toEqual({ standard: 'exact', strict: 'root', lenient: 'exact' });
  });
});

describe('SimpleSetupWizard review step', () => {
  it('links the preset guide to an existing docs page', async () => {
    await openReviewStep();
    const link = screen.getByRole('link', { name: /How to choose a preset/ });
    expect(link.getAttribute('href')).toBe('https://docs.lumibase.dev/en/docs/security/security-presets/');
  });

  it('switches to one account per mailbox when the strict preset is picked', async () => {
    await openReviewStep();
    expect(selectedEmailIdentity()).toBe('exact');

    fireEvent.change(screen.getByLabelText('Security preset'), { target: { value: 'strict' } });
    expect(selectedEmailIdentity()).toBe('root');
    expect(getEmailIdentityModeDraft()).toBe('root');

    fireEvent.change(screen.getByLabelText('Security preset'), { target: { value: 'standard' } });
    expect(selectedEmailIdentity()).toBe('exact');
  });

  it('keeps a manual override after the preset sets the mode', async () => {
    await openReviewStep();
    fireEvent.change(screen.getByLabelText('Security preset'), { target: { value: 'strict' } });
    const exact = (screen.getAllByRole('radio') as HTMLInputElement[]).find((r) => r.value === 'exact')!;
    fireEvent.click(exact);
    expect(selectedEmailIdentity()).toBe('exact');
  });

  it('opens advanced setup from the warning callout', async () => {
    await openReviewStep();
    fireEvent.change(screen.getByLabelText('Security preset'), { target: { value: 'strict' } });
    fireEvent.click(screen.getByRole('button', { name: /Switch to advanced setup/ }));
    expect(navigate).toHaveBeenCalledWith({ to: '/setup/security' });
  });
});
