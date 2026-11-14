// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Login page passkey paths (#735): "Sign in with a passkey" (passwordless) on
 * the credentials step, "Use a passkey" on the MFA step, both hidden where
 * WebAuthn is unavailable (desktop shell, contract C5).
 */

const m = vi.hoisted(() => ({
  supported: true,
  promptPasskey: vi.fn(),
  navigate: vi.fn(),
  setActiveToken: vi.fn(),
  setActiveRefreshToken: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => m.navigate }));
vi.mock('@/lib/api', () => ({
  getActiveSite: () => 'site-a',
  hasActiveToken: () => false,
  setActiveSite: () => {},
  setActiveToken: m.setActiveToken,
  setActiveRefreshToken: m.setActiveRefreshToken,
}));
vi.mock('@/lib/passkeys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/passkeys')>();
  return { ...actual, passkeysSupported: () => m.supported, promptPasskey: m.promptPasskey };
});

const { AdminLoginPage } = await import('../admin-login-page');

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  m.supported = true;
  for (const fn of [m.promptPasskey, m.navigate, m.setActiveToken, m.setActiveRefreshToken]) fn.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;

describe('AdminLoginPage — passkeys', () => {
  it('signs in without a password via a discoverable passkey', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: { ceremonyId: 'cer_0123456789abcdef', options: { challenge: 'c' } } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { token: 'jwt', refreshToken: 'rt' } }));
    m.promptPasskey.mockResolvedValue({ id: 'cred', type: 'public-key' });
    render(<AdminLoginPage adminPath="studio-admin" />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
    await waitFor(() => expect(m.setActiveToken).toHaveBeenCalledWith('jwt'));
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/v1/auth/passkey/options');
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({});
    expect(bodyOf(fetchMock.mock.calls[1]!)).toEqual({ ceremonyId: 'cer_0123456789abcdef', response: { id: 'cred', type: 'public-key' } });
    expect(m.navigate).toHaveBeenCalledWith({ to: '/studio-admin' });
  });

  it('offers the passkey as the second factor when the server lists webauthn', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { status: 'mfa_required', challengeToken: 'chal', expiresIn: 300, methods: ['webauthn'] } }),
    );
    render(<AdminLoginPage adminPath="studio-admin" />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const usePasskey = await screen.findByRole('button', { name: 'Use a passkey' });
    // Passkey-only account: no authenticator-code field, recovery code still reachable.
    expect(screen.queryByLabelText('Authentication code')).toBeNull();
    expect(screen.getByRole('button', { name: 'Use a recovery code instead' })).toBeInTheDocument();

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: { ceremonyId: 'cer_0123456789abcdef', options: {} } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { token: 'jwt2' } }));
    m.promptPasskey.mockResolvedValue({ id: 'cred' });
    fireEvent.click(usePasskey);
    await waitFor(() => expect(m.setActiveToken).toHaveBeenCalledWith('jwt2'));
    expect(bodyOf(fetchMock.mock.calls[1]!)).toEqual({ challengeToken: 'chal' });
    expect(bodyOf(fetchMock.mock.calls[2]!)).toMatchObject({ challengeToken: 'chal', ceremonyId: 'cer_0123456789abcdef' });
  });

  it('keeps the TOTP field when the server lists both methods', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { status: 'mfa_required', challengeToken: 'chal', methods: ['totp', 'webauthn'] } }),
    );
    render(<AdminLoginPage adminPath="studio-admin" />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByLabelText('Authentication code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use a passkey' })).toBeInTheDocument();
  });

  it('hides every passkey control where WebAuthn is unavailable (desktop shell)', async () => {
    m.supported = false;
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { status: 'mfa_required', challengeToken: 'chal', methods: ['webauthn'] } }),
    );
    render(<AdminLoginPage adminPath="studio-admin" />);
    expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/Use a recovery code instead\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use a passkey' })).toBeNull();
  });

  it('shows a calm message when the user cancels the browser prompt', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { ceremonyId: 'cer_0123456789abcdef', options: {} } }));
    m.promptPasskey.mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    render(<AdminLoginPage adminPath="studio-admin" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cancelled or timed out');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
