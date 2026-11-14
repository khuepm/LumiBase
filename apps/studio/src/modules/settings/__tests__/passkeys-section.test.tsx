// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Settings → Security → Passkeys (#735): list, add (password step-up → browser
 * prompt → register), rename, remove; hidden "add" inside the desktop shell.
 */

const pk = vi.hoisted(() => ({
  supported: true,
  createPasskey: vi.fn(),
}));

vi.mock('@/lib/passkeys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/passkeys')>();
  return {
    ...actual,
    passkeysSupported: () => pk.supported,
    createPasskey: pk.createPasskey,
  };
});

const { PasskeysSection } = await import('../passkeys-section');

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PasskeysSection />
    </QueryClientProvider>,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const list = (passkeys: unknown[], extra: Record<string, unknown> = {}) =>
  jsonResponse(200, { data: { passkeys, recoveryCodesRemaining: 8, totpEnabled: false, available: true, ...extra } });

const row = {
  id: 'pk_1',
  name: 'Work laptop',
  createdAt: '2026-11-01T10:00:00.000Z',
  lastUsedAt: null,
  transports: ['internal'],
  backedUp: true,
  deviceType: 'multiDevice',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pk.supported = true;
  pk.createPasskey.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PasskeysSection', () => {
  it('lists passkeys with their sync state', async () => {
    fetchMock.mockResolvedValueOnce(list([row]));
    renderSection();
    expect(await screen.findByText('Work laptop')).toBeInTheDocument();
    expect(screen.getByText(/Synced/)).toBeInTheDocument();
    expect(screen.getByText('8 recovery codes remaining.')).toBeInTheDocument();
  });

  it('adds a passkey: password step-up, browser prompt, then shows the recovery codes once', async () => {
    fetchMock
      .mockResolvedValueOnce(list([]))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ceremonyId: 'cer_0123456789abcdef', options: { challenge: 'c' } } }))
      .mockResolvedValueOnce(jsonResponse(201, { data: { passkey: row, recoveryCodes: ['AAAA-BBBB', 'CCCC-DDDD'] } }))
      .mockResolvedValue(list([row]));
    pk.createPasskey.mockResolvedValue({ id: 'cred', rawId: 'cred', type: 'public-key', response: {} });
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    fireEvent.change(screen.getByLabelText('Name (optional)'), { target: { value: 'Work laptop' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('AAAA-BBBB')).toBeInTheDocument();
    expect(pk.createPasskey).toHaveBeenCalledWith({ challenge: 'c' });
    const [optionsUrl, optionsInit] = fetchMock.mock.calls[1]!;
    expect(String(optionsUrl)).toMatch(/\/api\/v1\/me\/passkeys\/registration-options$/);
    expect(JSON.parse(optionsInit.body as string)).toEqual({ password: 'pw' });
    const [, registerInit] = fetchMock.mock.calls[2]!;
    expect(JSON.parse(registerInit.body as string)).toMatchObject({ ceremonyId: 'cer_0123456789abcdef', name: 'Work laptop' });
  });

  it('reports a cancelled browser prompt without registering', async () => {
    fetchMock
      .mockResolvedValueOnce(list([]))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ceremonyId: 'cer_0123456789abcdef', options: {} } }));
    const cancelled = Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' });
    pk.createPasskey.mockRejectedValue(cancelled);
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('cancelled or timed out');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renames and removes with a password', async () => {
    fetchMock.mockResolvedValueOnce(list([row]));
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Passkey name'), { target: { value: 'Old Mac' } });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { ...row, name: 'Old Mac' } })).mockResolvedValue(list([row]));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(String(patch[0])).toMatch(/\/api\/v1\/me\/passkeys\/pk_1$/);
    expect(JSON.parse(patch[1].body as string)).toEqual({ name: 'Old Mac' });

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.change(screen.getByLabelText('Password to confirm removal'), { target: { value: 'pw' } });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { deleted: true, signedOut: true } })).mockResolvedValue(list([]));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('every session was signed out');
    const del = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')!;
    expect(JSON.parse(del[1].body as string)).toEqual({ password: 'pw' });
  });

  it('inside the desktop shell, explains instead of offering to add', async () => {
    pk.supported = false;
    fetchMock.mockResolvedValueOnce(list([row]));
    renderSection();
    expect(await screen.findByText(/desktop app cannot create one/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a passkey' })).toBeNull();
    // Existing passkeys can still be managed.
    expect(await screen.findByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('explains when the server cannot serve passkeys for this origin', async () => {
    fetchMock.mockResolvedValueOnce(list([], { available: false }));
    renderSection();
    expect(await screen.findByText(/WEBAUTHN_ORIGINS/)).toBeInTheDocument();
  });
});
