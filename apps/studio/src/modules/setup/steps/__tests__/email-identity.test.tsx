// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

import {
  clearEmailIdentityModeDraft,
  EmailIdentityGroup,
  getEmailIdentityModeDraft,
  setEmailIdentityModeDraft,
  setPolicyDraft,
} from '../step-security';
import { setAccountDraft } from '../step-account';
import { setPathDraft } from '../step-path';
import { setProjectDraft } from '../step-project';
import { STANDARD_PRESET, lockoutPolicySchema } from '../../schemas/policy';
import { useCompleteSetup } from '../../hooks/use-complete-setup';

/**
 * Setup Wizard email identity choice (#794): the radio group, its module
 * draft, and the `emailIdentityMode` field `useCompleteSetup` sends in the
 * `POST /setup/complete` body.
 */

afterEach(() => {
  cleanup();
  clearEmailIdentityModeDraft();
  vi.restoreAllMocks();
});

describe('EmailIdentityGroup', () => {
  it('defaults to exact and reports a change to root', () => {
    const onChange = vi.fn();
    render(<EmailIdentityGroup value={getEmailIdentityModeDraft()} onChange={onChange} />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['exact', 'root']);
    expect(radios[0]!.checked).toBe(true);
    fireEvent.click(radios[1]!);
    expect(onChange).toHaveBeenCalledWith('root');
  });
});

describe('email identity draft', () => {
  it('is exact by default, settable, and reset by clear', () => {
    expect(getEmailIdentityModeDraft()).toBe('exact');
    setEmailIdentityModeDraft('root');
    expect(getEmailIdentityModeDraft()).toBe('root');
    clearEmailIdentityModeDraft();
    expect(getEmailIdentityModeDraft()).toBe('exact');
  });
});

describe('useCompleteSetup — emailIdentityMode', () => {
  beforeEach(() => {
    setAccountDraft({
      email: 'admin@example.com',
      password: 'CorrectHorse!Battery9',
      confirmPassword: 'CorrectHorse!Battery9',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    setPathDraft({ adminPath: '/lumi-quiet-otter' });
    setPolicyDraft(lockoutPolicySchema.parse({ ...STANDARD_PRESET }));
    setProjectDraft({
      defaultLanguage: 'en',
      siteUrl: 'https://example.com',
      displayTitle: 'LumiBase',
      theme: null,
    } as Parameters<typeof setProjectDraft>[0]);
  });

  async function submitAndCaptureBody(): Promise<Record<string, unknown>> {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { id: 'u1', email: 'admin@example.com', firstName: 'Ada', lastName: 'Lovelace' },
          adminPath: '/lumi-quiet-otter',
          backupCodes: ['a'],
          setupToken: null,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useCompleteSetup(), { wrapper });
    result.current.mutate({});
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it('sends exact by default', async () => {
    const body = await submitAndCaptureBody();
    expect(body.emailIdentityMode).toBe('exact');
  });

  it('sends the chosen mode and resets the draft on success', async () => {
    setEmailIdentityModeDraft('root');
    const body = await submitAndCaptureBody();
    expect(body.emailIdentityMode).toBe('root');
    expect(getEmailIdentityModeDraft()).toBe('exact');
  });
});
