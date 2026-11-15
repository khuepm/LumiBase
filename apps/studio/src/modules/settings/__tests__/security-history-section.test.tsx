// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SecurityHistoryItem } from '@lumibase/contracts';
import { SecurityHistorySection, describeHistoryItem } from '../security-history-section';

/**
 * "Security history" card on Settings → Security (#739): lists the caller's
 * events with a device label, loads more by cursor, switches scope, and
 * exports CSV/JSON.
 */

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SecurityHistorySection />
    </QueryClientProvider>,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob([JSON.stringify(body)]),
  } as unknown as Response;
}

const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

const item = (id: string, over: Partial<SecurityHistoryItem> = {}): SecurityHistoryItem => ({
  id,
  kind: 'sign_in',
  occurredAt: '2026-11-14T10:00:00.000Z',
  siteId: 'site-a',
  ipApprox: '203.0.113.x',
  userAgent: ANDROID,
  countryCode: 'VN',
  details: {},
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('describeHistoryItem', () => {
  it('words the common kinds', () => {
    expect(describeHistoryItem(item('a', { details: { method: 'totp' } }))).toBe('Signed in with two-factor code');
    expect(describeHistoryItem(item('a', { kind: 'new_device' }))).toBe('Signed in from a new device');
    expect(describeHistoryItem(item('a', { kind: 'sessions_revoked', details: { scope: 'others', revoked: 2 } })))
      .toBe('Signed out 2 other session(s)');
  });
});

describe('SecurityHistorySection', () => {
  it('lists events with device, shortened IP and a review flag, and loads more', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [item('a', { kind: 'new_device' }), item('b')],
          meta: { nextCursor: 'c1' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { data: [item('c', { kind: 'password_changed', userAgent: null, ipApprox: null })], meta: { nextCursor: null } }),
      );
    renderSection();

    expect(await screen.findByText('Signed in from a new device')).toBeTruthy();
    expect(screen.getAllByText(/Chrome on Android · 203\.0\.113\.x · VN/)).toHaveLength(2);
    expect(screen.getByText('Review')).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/v1/me/security-history?limit=20&scope=site');

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(await screen.findByText('Password changed')).toBeTruthy();
    expect(String(fetchMock.mock.calls[1]![0])).toContain('cursor=c1');
    await waitFor(() => expect(screen.queryByRole('button', { name: /load more/i })).toBeNull());
  });

  it('switches to all of the caller\'s sites', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [], meta: { nextCursor: null } }));
    renderSection();
    expect(await screen.findByText('No security events yet.')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'account' } });
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('scope=account'));
  });

  it('exports CSV through the authenticated endpoint', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [], meta: { nextCursor: null } }))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    renderSection();
    await screen.findByText('No security events yet.');

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[1]! as [string, { headers: Record<string, string> }];
    expect(url).toContain('/api/v1/me/security-history/export?format=csv&scope=site');
    expect(init.headers.Authorization).toMatch(/^Bearer /);
  });

  it('shows the server message when an export is refused', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [], meta: { nextCursor: null } }))
      .mockResolvedValueOnce(jsonResponse(429, { errors: [{ message: 'Too many exports. Try again later.' }] }));
    renderSection();
    await screen.findByText('No security events yet.');
    fireEvent.click(screen.getByRole('button', { name: /export json/i }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Too many exports. Try again later.');
  });
});
