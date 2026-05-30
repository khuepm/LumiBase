// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import {
  BackupCodePage,
  parseRetryAfterSeconds,
  formatWait,
} from '../backup-code-page';

/**
 * Tests for the public backup-code recovery page.
 *
 * The page POSTs `{ email, backupCode }` to
 * `POST /api/v1/admin/security/recover` (task 10.7) and renders:
 *   - a success panel with the returned `adminPath` on 200,
 *   - a GENERIC error on 401 INVALID_BACKUP_CODE (anti-enumeration —
 *     never attributes the failure to a single field),
 *   - a rate-limit message on 429 RATE_LIMITED.
 *
 * `fetch` is stubbed per-test via `vi.stubGlobal`. The component uses
 * TanStack Query, so it's wrapped in a fresh `QueryClient` (retry
 * disabled) per render.
 *
 * **Validates: Requirements 14.4, 14.5**
 */

// A QueryClient with retries off so error states render deterministically
// on the first (only) attempt.
function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

/** Build a minimal `Response`-like stub for the fetch mock. */
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

describe('BackupCodePage — rendering', () => {
  it('renders the email + backup code inputs and a submit button', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderWithClient(<BackupCodePage />);

    expect(screen.getByLabelText('Admin email')).toBeInTheDocument();
    expect(screen.getByLabelText('Backup code')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Recover access' }),
    ).toBeInTheDocument();
  });

  it('links to the forgot-path page', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderWithClient(<BackupCodePage />);
    expect(
      screen.getByRole('link', { name: 'Recover it by email' }),
    ).toHaveAttribute('href', '/recovery/forgot-path');
  });
});

describe('BackupCodePage — successful recovery (200)', () => {
  it('shows the success panel with the returned adminPath + login link', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          adminPath: '/lumi-7f3a9c',
          oneTimeUnlockToken: 'unlock-token-abc123',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<BackupCodePage />);

    fireEvent.input(screen.getByLabelText('Admin email'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.input(screen.getByLabelText('Backup code'), {
      target: { value: 'A2BC-D3EF' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recover access' }));

    // Success panel surfaces the admin path.
    expect(await screen.findByText('Recovery successful')).toBeInTheDocument();
    expect(screen.getByText('/lumi-7f3a9c')).toBeInTheDocument();
    // The login CTA is a full-navigation anchor to `${adminPath}/login`.
    expect(
      screen.getByRole('link', { name: 'Go to admin login' }),
    ).toHaveAttribute('href', '/lumi-7f3a9c/login');
    // The one-time unlock token is surfaced too.
    expect(screen.getByText('unlock-token-abc123')).toBeInTheDocument();

    // Posted to the documented endpoint with the right body.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    const url = call[0];
    const init = call[1] as RequestInit;
    expect(url).toBe('/api/v1/admin/security/recover');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'admin@example.com',
      backupCode: 'A2BC-D3EF',
    });
  });
});

describe('BackupCodePage — invalid backup code (401)', () => {
  it('shows a generic error that does not attribute the failure to a field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(401, { errors: [{ code: 'INVALID_BACKUP_CODE' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<BackupCodePage />);

    fireEvent.input(screen.getByLabelText('Admin email'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.input(screen.getByLabelText('Backup code'), {
      target: { value: 'WRON-GXXX' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recover access' }));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(
      /that email and backup code didn’t match/i,
    );
    // Anti-enumeration: never names which field was wrong.
    expect(banner.textContent ?? '').not.toMatch(/email (was|is) (wrong|invalid|unknown)/i);

    // Still on the form (no success panel).
    expect(screen.queryByText('Recovery successful')).not.toBeInTheDocument();
  });
});

describe('BackupCodePage — rate limited (429)', () => {
  it('shows a rate-limit message and surfaces the Retry-After wait', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        429,
        { errors: [{ code: 'RATE_LIMITED' }] },
        { 'Retry-After': '120' },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<BackupCodePage />);

    fireEvent.input(screen.getByLabelText('Admin email'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.input(screen.getByLabelText('Backup code'), {
      target: { value: 'A2BC-D3EF' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recover access' }));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/too many recovery attempts/i);
    // 120s → "2 minutes".
    expect(banner).toHaveTextContent(/2 minutes/i);
  });

  it('falls back to a generic wait message when Retry-After is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(429, { errors: [{ code: 'RATE_LIMITED' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<BackupCodePage />);

    fireEvent.input(screen.getByLabelText('Admin email'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.input(screen.getByLabelText('Backup code'), {
      target: { value: 'A2BC-D3EF' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recover access' }));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/try again later/i);
  });
});

describe('BackupCodePage — client validation', () => {
  it('blocks submit and never calls fetch on an invalid email', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<BackupCodePage />);

    fireEvent.input(screen.getByLabelText('Admin email'), {
      target: { value: 'not-an-email' },
    });
    fireEvent.input(screen.getByLabelText('Backup code'), {
      target: { value: 'A2BC-D3EF' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recover access' }));

    // The resolver rejects before any network call.
    await waitFor(() => {
      expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('parseRetryAfterSeconds (pure helper)', () => {
  it('parses integer delta-seconds', () => {
    expect(parseRetryAfterSeconds('90')).toBe(90);
  });

  it('returns undefined for a null/empty header', () => {
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds('')).toBeUndefined();
  });

  it('returns undefined for unparseable values', () => {
    expect(parseRetryAfterSeconds('soon')).toBeUndefined();
  });
});

describe('formatWait (pure helper)', () => {
  it('renders seconds below a minute', () => {
    expect(formatWait(30)).toBe('30 seconds');
    expect(formatWait(1)).toBe('1 second');
  });

  it('rounds up to whole minutes at/above 60s', () => {
    expect(formatWait(60)).toBe('1 minute');
    expect(formatWait(120)).toBe('2 minutes');
    expect(formatWait(150)).toBe('3 minutes');
  });
});
