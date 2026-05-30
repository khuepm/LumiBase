// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import { ForgotPathPage } from '../forgot-path-page';

/**
 * Tests for the public forgot-path recovery page.
 *
 * The page POSTs `{ email }` to `POST /api/v1/admin/security/forgot-path`
 * (task 10.7). Per Req 14.5 (anti-enumeration) it ALWAYS shows the same
 * generic success message on a 200 — regardless of input — and a
 * rate-limit message on a 429.
 *
 * `fetch` is stubbed per-test via `vi.stubGlobal`. The component uses
 * TanStack Query, so it's wrapped in a fresh `QueryClient` per render.
 *
 * **Validates: Requirements 14.4, 14.5**
 */

const GENERIC_SENT = /if that email belongs to the admin account/i;

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    status,
    headers: {
      get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ForgotPathPage — rendering', () => {
  it('renders the email input and submit button', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderWithClient(<ForgotPathPage />);

    expect(screen.getByLabelText('Admin email')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Send recovery instructions' }),
    ).toBeInTheDocument();
  });

  it('links back to the backup-code page', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderWithClient(<ForgotPathPage />);
    expect(
      screen.getByRole('link', { name: 'Recover with a backup code' }),
    ).toHaveAttribute('href', '/recovery/backup-code');
  });
});

describe('ForgotPathPage — anti-enumeration success (Req 14.5)', () => {
  it('shows the generic sent message on a 200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: { sent: true } }));
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<ForgotPathPage />);
    fireEvent.input(screen.getByLabelText('Admin email'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Send recovery instructions' }),
    );

    expect(await screen.findByText(GENERIC_SENT)).toBeInTheDocument();
    expect(screen.getByText('Check your inbox')).toBeInTheDocument();
  });

  it('shows the SAME generic message regardless of which email is entered', async () => {
    // First email — a plausible admin address.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: { sent: true } }));
    vi.stubGlobal('fetch', fetchMock);

    const first = renderWithClient(<ForgotPathPage />);
    fireEvent.input(screen.getByLabelText('Admin email'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Send recovery instructions' }),
    );
    const firstMessage = (await screen.findByText(GENERIC_SENT)).textContent;
    first.unmount();
    cleanup();

    // Second email — a random address that does NOT match any account.
    const second = renderWithClient(<ForgotPathPage />);
    fireEvent.input(screen.getByLabelText('Admin email'), {
      target: { value: 'nobody-here@example.org' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Send recovery instructions' }),
    );
    const secondMessage = (await screen.findByText(GENERIC_SENT)).textContent;
    second.unmount();

    // Identical copy → no enumeration signal.
    expect(secondMessage).toBe(firstMessage);
  });

  it('treats a network error as a generic success (no side channel)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<ForgotPathPage />);
    fireEvent.input(screen.getByLabelText('Admin email'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Send recovery instructions' }),
    );

    expect(await screen.findByText(GENERIC_SENT)).toBeInTheDocument();
  });
});

describe('ForgotPathPage — rate limited (429)', () => {
  it('shows the rate-limit message instead of the success panel', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        429,
        { errors: [{ code: 'RATE_LIMITED' }] },
        { 'Retry-After': '60' },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<ForgotPathPage />);
    fireEvent.input(screen.getByLabelText('Admin email'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Send recovery instructions' }),
    );

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/too many recovery attempts/i);
    expect(banner).toHaveTextContent(/1 minute/i);
    // The generic success panel must NOT have rendered.
    expect(screen.queryByText('Check your inbox')).not.toBeInTheDocument();
  });
});

describe('ForgotPathPage — client validation', () => {
  it('blocks submit and never calls fetch on an invalid email', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<ForgotPathPage />);
    fireEvent.input(screen.getByLabelText('Admin email'), {
      target: { value: 'broken' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Send recovery instructions' }),
    );

    expect(
      await screen.findByText('Enter a valid email address.'),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
