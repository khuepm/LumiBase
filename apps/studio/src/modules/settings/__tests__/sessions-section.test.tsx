// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionsSection, describeUserAgent, type SessionRow } from '../sessions-section';

/**
 * "Active sessions" card on Settings → Security (#730): lists sessions,
 * flags this device, signs out one session or every other session.
 */

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionsSection />
    </QueryClientProvider>,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const row = (sessionId: string, ua: string | null, current = false): SessionRow => ({
  id: `row-${sessionId}`,
  sessionId,
  audience: 'studio',
  startedAt: '2026-11-01T10:00:00.000Z',
  lastSeenAt: '2026-11-14T10:00:00.000Z',
  expiresAt: '2026-12-01T10:00:00.000Z',
  lastIp: '203.0.113.7',
  lastUserAgent: ua,
  current,
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

describe('describeUserAgent', () => {
  it('names common browser/OS pairs and flags mobiles', () => {
    expect(describeUserAgent(MAC_CHROME)).toEqual({ label: 'Chrome on macOS', mobile: false });
    expect(describeUserAgent(IPHONE_SAFARI)).toEqual({ label: 'Safari on iOS', mobile: true });
    expect(describeUserAgent(null).label).toBe('Unknown device');
    expect(describeUserAgent('lumibase-sdk/2.0.0').label).toBe('lumibase-sdk');
  });
});

describe('SessionsSection', () => {
  it('lists sessions, marks this device and hides its sign-out button', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: [row('fam-a', MAC_CHROME, true), row('fam-b', IPHONE_SAFARI)] }),
    );
    renderSection();

    expect(await screen.findByText('This device')).toBeInTheDocument();
    expect(screen.getByText(/Safari on iOS/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out Chrome on macOS' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out Safari on iOS' })).toBeInTheDocument();
  });

  it('signs out one session by its stable session id', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [row('fam-a', MAC_CHROME, true), row('fam-b', IPHONE_SAFARI)] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { revoked: true } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [row('fam-a', MAC_CHROME, true)] }));
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out Safari on iOS' }));
    expect(await screen.findByText('Session signed out.')).toBeInTheDocument();
    const [revokeUrl, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(revokeUrl).toMatch(/\/api\/v1\/me\/sessions\/fam-b$/);
    expect(init.method).toBe('DELETE');
    await waitFor(() => expect(screen.queryByText(/Safari on iOS/)).toBeNull());
  });

  it('signs out every other session with scope=others', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [row('fam-a', MAC_CHROME, true), row('fam-b', IPHONE_SAFARI)] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { status: 'other_sessions_revoked', revoked: 1 } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [row('fam-a', MAC_CHROME, true)] }));
    renderSection();

    const button = await screen.findByRole('button', { name: /Sign out other sessions/ });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByText('Signed out 1 other session.')).toBeInTheDocument();
    const [revokeUrl] = fetchMock.mock.calls[1] as [string];
    expect(revokeUrl).toMatch(/\/api\/v1\/me\/sessions\?scope=others$/);
  });

  it('disables "Sign out other sessions" when this is the only session', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [row('fam-a', MAC_CHROME, true)] }));
    renderSection();
    await screen.findByText('This device');
    expect(screen.getByRole('button', { name: /Sign out other sessions/ })).toBeDisabled();
  });

  it('shows an error instead of an empty list when loading fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { errors: [] }));
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load sessions');
  });
});
