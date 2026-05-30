// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import {
  SecurityAuditTab,
  AUDIT_EVENT_CODES,
  buildAuditLogQuery,
  buildAuditExportQuery,
  toIsoOrNull,
  validateRange,
  EMPTY_FILTERS,
  type AuditLogEntry,
} from '../security-audit-tab';

/**
 * Tests for the "Security audit" tab (admin-setup-wizard task 12.4).
 *
 * The tab reads `GET /api/v1/admin/security/audit-log` (cursor-paginated
 * list) and downloads `GET /api/v1/admin/security/audit-log/export`
 * (one-shot NDJSON blob). It renders:
 *   - the filter UI (event dropdown + "All", email, from/to, Search +
 *     Export buttons);
 *   - the result rows from a 200 list response;
 *   - a "Load more" button when `nextCursor` is present, gone when null;
 *   - an event-filtered re-fetch (asserting the `event=` query param);
 *   - an export download (mocked `URL.createObjectURL` + stubbed anchor
 *     click), and a "too large" message on a 413.
 *
 * `fetch` is stubbed per-test via `vi.stubGlobal`. The component uses
 * TanStack Query, so it's wrapped in a fresh `QueryClient` (retry off)
 * per render, mirroring the recovery-page tests.
 *
 * **Validates: Requirements 15.4, 15.6**
 */

// ── test scaffolding ──────────────────────────────────────────────────

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

/** Build a minimal JSON `Response`-like stub for the fetch mock. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

/** Build a 200 `Response`-like stub whose `.blob()` resolves (export). */
function blobResponse(status: number, text = ''): Response {
  return {
    status,
    headers: { get: () => null },
    blob: async () => ({ size: text.length, type: 'application/x-ndjson' }) as Blob,
    json: async () => ({}),
  } as unknown as Response;
}

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: 'evt_1',
    timestamp: '2024-01-15T10:30:00.000Z',
    event: 'login_failed',
    actorEmail: 'admin@example.com',
    targetEmail: null,
    ip: '203.0.113.7',
    userAgent: 'curl/8.1',
    countryCode: 'US',
    metadata: {},
    requestId: 'req_abc',
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── pure helpers ──────────────────────────────────────────────────────

describe('buildAuditLogQuery (pure helper)', () => {
  it('omits empty params', () => {
    expect(buildAuditLogQuery(EMPTY_FILTERS)).toBe('');
  });

  it('includes event + trimmed email', () => {
    const qs = buildAuditLogQuery({
      ...EMPTY_FILTERS,
      event: 'login_failed',
      email: '  Admin@Example.com  ',
    });
    const params = new URLSearchParams(qs);
    expect(params.get('event')).toBe('login_failed');
    expect(params.get('email')).toBe('Admin@Example.com');
  });

  it('converts from/to datetime-local to ISO and appends a cursor', () => {
    const qs = buildAuditLogQuery(
      { ...EMPTY_FILTERS, from: '2024-01-01T00:00', to: '2024-02-01T00:00' },
      'CURSOR123',
    );
    const params = new URLSearchParams(qs);
    expect(params.get('from')).toBe(new Date('2024-01-01T00:00').toISOString());
    expect(params.get('to')).toBe(new Date('2024-02-01T00:00').toISOString());
    expect(params.get('cursor')).toBe('CURSOR123');
  });
});

describe('buildAuditExportQuery (pure helper)', () => {
  it('never includes a cursor (export streams the full set)', () => {
    const qs = buildAuditExportQuery({
      ...EMPTY_FILTERS,
      event: 'ip_blocked',
    });
    const params = new URLSearchParams(qs);
    expect(params.get('event')).toBe('ip_blocked');
    expect(params.has('cursor')).toBe(false);
  });
});

describe('toIsoOrNull (pure helper)', () => {
  it('returns null for empty input', () => {
    expect(toIsoOrNull('')).toBeNull();
    expect(toIsoOrNull('   ')).toBeNull();
  });

  it('returns an ISO string for a valid datetime-local value', () => {
    expect(toIsoOrNull('2024-01-01T00:00')).toBe(
      new Date('2024-01-01T00:00').toISOString(),
    );
  });

  it('returns null for an unparseable value', () => {
    expect(toIsoOrNull('not-a-date')).toBeNull();
  });
});

describe('validateRange (pure helper)', () => {
  it('passes when one or both bounds are absent', () => {
    expect(validateRange(EMPTY_FILTERS)).toBeNull();
    expect(validateRange({ ...EMPTY_FILTERS, from: '2024-01-01T00:00' })).toBeNull();
  });

  it('rejects a reversed range', () => {
    expect(
      validateRange({
        ...EMPTY_FILTERS,
        from: '2024-02-01T00:00',
        to: '2024-01-01T00:00',
      }),
    ).toMatch(/before/i);
  });

  it('passes an ordered range', () => {
    expect(
      validateRange({
        ...EMPTY_FILTERS,
        from: '2024-01-01T00:00',
        to: '2024-02-01T00:00',
      }),
    ).toBeNull();
  });
});

// ── filter UI ─────────────────────────────────────────────────────────

describe('SecurityAuditTab — filter UI', () => {
  it('renders the event dropdown with "All events" + all 15 codes', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(200, { data: { items: [], nextCursor: null } }),
    ));
    renderWithClient(<SecurityAuditTab />);

    const select = screen.getByLabelText('Event') as HTMLSelectElement;
    const options = within(select).getAllByRole('option');
    // "All events" + 15 codes.
    expect(options).toHaveLength(AUDIT_EVENT_CODES.length + 1);
    expect(options[0]).toHaveTextContent('All events');
    for (const code of AUDIT_EVENT_CODES) {
      expect(within(select).getByRole('option', { name: code })).toBeInTheDocument();
    }
  });

  it('renders the email, from, to inputs and Search + Export buttons', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(200, { data: { items: [], nextCursor: null } }),
    ));
    renderWithClient(<SecurityAuditTab />);

    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export ndjson/i })).toBeInTheDocument();
  });
});

// ── list rendering + Load more ─────────────────────────────────────────

describe('SecurityAuditTab — list rendering', () => {
  it('renders rows from a 200 list response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          items: [
            makeEntry({ id: 'evt_1', event: 'login_failed', actorEmail: 'alice@example.com' }),
            makeEntry({ id: 'evt_2', event: 'user_locked', actorEmail: 'bob@example.com' }),
          ],
          nextCursor: null,
        },
      }),
    ));
    renderWithClient(<SecurityAuditTab />);

    // Await a row-unique value (the actor emails aren't dropdown option
    // text, unlike the event codes which collide with the <option>s).
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();

    // The event badges live in the results table; scope the lookup there
    // so it doesn't match the identically-named dropdown <option>s.
    const table = screen.getByRole('table');
    expect(within(table).getByText('login_failed')).toBeInTheDocument();
    expect(within(table).getByText('user_locked')).toBeInTheDocument();
  });

  it('shows the empty state when there are no items', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(200, { data: { items: [], nextCursor: null } }),
    ));
    renderWithClient(<SecurityAuditTab />);

    expect(
      await screen.findByText('No audit events match these filters.'),
    ).toBeInTheDocument();
  });

  it('shows "Load more" when nextCursor is present and appends the next page', async () => {
    const fetchMock = vi
      .fn()
      // page 1 → has a next cursor
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: { items: [makeEntry({ id: 'evt_1', actorEmail: 'alice@example.com' })], nextCursor: 'CURSOR_2' },
        }),
      )
      // page 2 → no further cursor
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: { items: [makeEntry({ id: 'evt_2', actorEmail: 'bob@example.com' })], nextCursor: null },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<SecurityAuditTab />);

    // Page 1 rendered + Load more visible.
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    const loadMore = screen.getByRole('button', { name: /load more/i });
    expect(loadMore).toBeInTheDocument();

    // Click Load more → fetch page 2 with cursor=CURSOR_2.
    fireEvent.click(loadMore);

    expect(await screen.findByText('bob@example.com')).toBeInTheDocument();
    // First page still present (appended, not replaced).
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();

    // Second fetch carried the cursor.
    const secondUrl = fetchMock.mock.calls[1]![0] as string;
    expect(secondUrl).toContain('cursor=CURSOR_2');

    // Load more disappears once nextCursor is null.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    });
  });
});

// ── event filter re-fetch ───────────────────────────────────────────────

describe('SecurityAuditTab — applying an event filter', () => {
  it('re-fetches with the event= query param on Search', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: { items: [], nextCursor: null } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<SecurityAuditTab />);

    // Initial fetch (no event filter).
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0] as string).not.toContain('event=');

    // Choose an event + Search.
    fireEvent.change(screen.getByLabelText('Event'), {
      target: { value: 'user_locked' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const url = fetchMock.mock.calls[1]![0] as string;
    expect(url).toContain('event=user_locked');
  });
});

// ── error states ────────────────────────────────────────────────────────

describe('SecurityAuditTab — list error states', () => {
  it('shows "Admin access required" on a 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(403, { errors: [{ code: 'FORBIDDEN' }] }),
    ));
    renderWithClient(<SecurityAuditTab />);

    expect(await screen.findByText('Admin access required.')).toBeInTheDocument();
  });

  it('shows the validation message on a 400', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(400, {
        errors: [{ code: 'VALIDATION_ERROR', message: 'Filter "limit" must be an integer.' }],
      }),
    ));
    renderWithClient(<SecurityAuditTab />);

    expect(
      await screen.findByText('Filter "limit" must be an integer.'),
    ).toBeInTheDocument();
  });
});

// ── export download ──────────────────────────────────────────────────────

describe('SecurityAuditTab — Export NDJSON', () => {
  it('fetches the export endpoint with current filters and triggers a download', async () => {
    // Initial list fetch + the export fetch share the same mock; route on URL.
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/audit-log/export')) {
        return Promise.resolve(blobResponse(200, 'line\n'));
      }
      return Promise.resolve(jsonResponse(200, { data: { items: [], nextCursor: null } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    // Stub the object-URL plumbing + the anchor click.
    const createObjectURL = vi.fn().mockReturnValue('blob:mock');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => { });

    renderWithClient(<SecurityAuditTab />);

    // Wait for the initial list load to settle.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Set an event filter, then export.
    fireEvent.change(screen.getByLabelText('Event'), {
      target: { value: 'anomaly_triggered' },
    });
    fireEvent.click(screen.getByRole('button', { name: /export ndjson/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('/audit-log/export') &&
            call[0].includes('event=anomaly_triggered'),
        ),
      ).toBe(true);
    });

    // The blob download path ran.
    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    });

    clickSpy.mockRestore();
  });

  it('shows a "too large" message on a 413 export response', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/audit-log/export')) {
        return Promise.resolve(
          jsonResponse(413, {
            errors: [
              {
                code: 'EXPORT_TOO_LARGE',
                message: 'Export of 200000 rows exceeds the 100000-row cap. Narrow the filters or date range.',
              },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, { data: { items: [], nextCursor: null } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<SecurityAuditTab />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /export ndjson/i }));

    expect(await screen.findByText(/exceeds the 100000-row cap/i)).toBeInTheDocument();
  });
});
