// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Settings → Security, TOTP section:
 *   - #1047: setup renders a locally drawn QR code from `otpauthUrl`, keeps the
 *     secret as a copyable fallback, and folds the raw URI away.
 *   - #1048: confirming enrolment adopts the TFA-verified session the server
 *     returns and never navigates away while the recovery codes are shown; a
 *     `403 TFA_REQUIRED` on the status read offers "sign in again with 2FA".
 */

// The other sections have their own tests; keep this one about TOTP.
vi.mock('../passkeys-section', () => ({ PasskeysSection: () => null }));
vi.mock('../sessions-section', () => ({ SESSIONS_QUERY_KEY: ['me-sessions'], SessionsSection: () => null }));
vi.mock('../change-password-section', () => ({ ChangePasswordSection: () => null }));
vi.mock('../security-history-section', () => ({
  SECURITY_HISTORY_QUERY_KEY: ['me-security-history'],
  SecurityHistorySection: () => null,
}));

const OTPAUTH = 'otpauth://totp/LumiBase:admin%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=LumiBase';

let assign: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const disabled = () => jsonResponse(200, { data: { enabled: false, enrolledAt: null, recoveryCodesRemaining: 0 } });

async function renderPage() {
  const api = await import('@/lib/api');
  const { SecuritySettingsPage } = await import('../security-page');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SecuritySettingsPage />
    </QueryClientProvider>,
  );
  return api;
}

async function startSetup() {
  fireEvent.change(await screen.findByLabelText('Confirm password to begin setup'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enable 2FA' }));
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  window.history.replaceState(null, '', '/admin-a7f3c1/settings/security');
  assign = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, pathname: '/admin-a7f3c1/settings/security', search: '', assign },
  });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('TOTP setup QR code (#1047)', () => {
  it('draws the QR code locally and keeps the secret as a fallback', async () => {
    fetchMock
      .mockResolvedValueOnce(disabled())
      .mockResolvedValueOnce(jsonResponse(200, { data: { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: OTPAUTH } }));
    await renderPage();
    await startSetup();

    const qr = await screen.findByRole('img', { name: 'QR code to scan with your authenticator app' });
    const src = qr.getAttribute('src') ?? '';
    expect(src.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeURIComponent(src)).toContain('<svg');
    // Encoded in the browser: the only requests are the two API calls.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [input] of fetchMock.mock.calls) expect(String(input)).toContain('/api/v1/me/tfa');

    expect(screen.getByTestId('totp-secret')).toHaveTextContent('JBSWY3DPEHPK3PXP');
    expect(screen.getByRole('button', { name: 'Copy secret' })).toBeInTheDocument();
    // The raw URI is folded away behind a disclosure.
    const uri = screen.getByText(OTPAUTH);
    expect(uri.closest('details')).not.toBeNull();
    expect(uri.closest('details')).not.toHaveAttribute('open');
  });
});

describe('TOTP enrolment keeps the session usable (#1048)', () => {
  it('stores the upgraded session and does not redirect while recovery codes are shown', async () => {
    fetchMock
      .mockResolvedValueOnce(disabled())
      .mockResolvedValueOnce(jsonResponse(200, { data: { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: OTPAUTH } }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            recoveryCodes: ['aaaa-1111', 'bbbb-2222'],
            session: { token: 'verified-access', refreshToken: 'verified-refresh', refreshTokenExpiresAt: '2030-01-01T00:00:00.000Z' },
          },
        }),
      )
      .mockResolvedValue(jsonResponse(200, { data: { enabled: true, enrolledAt: '2026-11-27T00:00:00.000Z', recoveryCodesRemaining: 2 } }));
    const api = await renderPage();
    api.setActiveToken('password-only-access');
    api.setActiveRefreshToken('password-only-refresh');
    await startSetup();

    fireEvent.change(await screen.findByLabelText('Enter the 6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and enable' }));

    expect(await screen.findByText('aaaa-1111')).toBeInTheDocument();
    expect(api.getActiveToken()).toBe('verified-access');
    expect(api.getActiveRefreshToken()).toBe('verified-refresh');

    // The status refetch goes out with the new token.
    await waitFor(() => expect(screen.getByText(/Status: Enabled/)).toBeInTheDocument());
    const lastCall = fetchMock.mock.calls.at(-1)!;
    expect((lastCall[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer verified-access' });

    // A stray 403 TFA_REQUIRED from elsewhere must not navigate off the codes.
    api.handleTfaRequired('verification_required');
    expect(assign).not.toHaveBeenCalled();
    expect(api.getActiveToken()).toBe('verified-access');
  });

  it('offers "sign in again with 2FA" when the status read answers TFA_REQUIRED', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, {
        errors: [{ code: 'TFA_REQUIRED', message: 'A two-factor verified session is required for this account.', details: { reason: 'verification_required' } }],
      }),
    );
    await renderPage();
    const button = await screen.findByRole('button', { name: 'Sign in again with 2FA' });
    expect(screen.queryByText(/Could not load two-factor status/)).not.toBeInTheDocument();

    fetchMock.mockResolvedValue(jsonResponse(200, { data: { ok: true } }));
    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin-a7f3c1/login?tfa=verify'));
  });
});
