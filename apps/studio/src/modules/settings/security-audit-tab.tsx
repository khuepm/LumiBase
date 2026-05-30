import { useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useId, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Clock,
  Download,
  Loader2,
  Search,
} from 'lucide-react';

/**
 * "Security audit" tab of the Activity settings page (admin-setup-wizard
 * task 12.4; Req 15.4 + 15.6; design §10.3, §10.4).
 *
 * This is the operator-facing read surface for the `audit_log` table —
 * the admin-only counterpart to the CMS query/export router built in
 * tasks 12.1–12.3:
 *
 *   GET /api/v1/admin/security/audit-log
 *     ?event=&email=&from=&to=&cursor=&limit=
 *     → 200 { data: { items: AuditLogEntry[], nextCursor: string | null } }
 *     → 400 VALIDATION_ERROR | 400 INVALID_RANGE | 403 FORBIDDEN
 *
 *   GET /api/v1/admin/security/audit-log/export
 *     ?event=&email=&from=&to=
 *     → 200 application/x-ndjson (attachment download)
 *     → 413 EXPORT_TOO_LARGE | 400 | 403
 *
 * ── How the two surfaces are consumed ────────────────────────────────
 *
 *   - The paginated LIST is a TanStack `useInfiniteQuery` keyed on the
 *     APPLIED filters. Cursor pagination maps naturally onto an infinite
 *     query: `getNextPageParam` reads `nextCursor`, and "Load more"
 *     calls `fetchNextPage()` to APPEND the next page (the simplest
 *     cursor consumption — design §10.3). The button hides when
 *     `nextCursor` is `null`.
 *   - The EXPORT is a one-shot blob download, NOT a query: a manual
 *     `fetch` whose `Response` is turned into a `Blob` → object URL →
 *     synthetic `<a download>` click → revoke, mirroring the proven
 *     download pattern in `setup/steps/step-recovery.tsx`.
 *
 * ── Draft vs applied filters ─────────────────────────────────────────
 *
 * We keep an editable DRAFT filter (the controlled inputs) separate from
 * the APPLIED filter (what the query is keyed on). "Search" copies draft
 * → applied, which changes the query key and restarts pagination from
 * the first page. This avoids spamming the API on every keystroke
 * (the prompt's explicit-apply preference). The Export button uses the
 * CURRENT DRAFT filters so an operator can export exactly what they see
 * configured.
 *
 * ── Error states (design §10.3) ──────────────────────────────────────
 *
 *   - 403 FORBIDDEN        → "Admin access required" (the session lacks
 *                            the admin role).
 *   - 400 VALIDATION_ERROR
 *     / INVALID_RANGE      → the server's validation message.
 *   - 413 EXPORT_TOO_LARGE → (export only) "Export too large — narrow
 *                            your filters".
 *
 * Client-side we ALSO pre-validate `from < to` and surface an inline
 * error before calling the API, but the server stays authoritative
 * (it independently enforces INVALID_RANGE + the ≤366-day window).
 *
 * ── i18n ─────────────────────────────────────────────────────────────
 *
 * Copy is inline English, matching the deliberate convention of the
 * recovery + setup pages (`backup-code-page.tsx`, `step-recovery.tsx`):
 * the Studio's i18n is backend-fetched and a swap to keys under
 * `settings.securityAudit.*` is a tracked follow-up. The sibling
 * `activity-page.tsx` uses the `t('key', 'Default')` shape; this
 * component favours plain English for the audit-specific copy.
 *
 * Spec refs: requirements §15.4, §15.6; design.md §4.9, §4.10, §10.3,
 * §10.4.
 */

// ────────────────────────────────────────────────────────────────────────
// Event vocabulary
// ────────────────────────────────────────────────────────────────────────

/**
 * The 15 audit event codes offered in the `event` filter dropdown.
 *
 * NOTE: this list MIRRORS the CMS `AUDIT_EVENTS` const in
 * `apps/cms/src/modules/audit/logger.ts`. The Studio deliberately does
 * NOT import from the CMS package (no cross-app coupling), so the list
 * is duplicated here. If the CMS vocabulary changes, update this const
 * to match.
 */
export const AUDIT_EVENT_CODES = [
  'setup_started',
  'setup_completed',
  'bootstrap_admin_created',
  'admin_path_set',
  'lockout_policy_updated',
  'login_success',
  'login_failed',
  'user_locked',
  'user_unlocked',
  'ip_blocked',
  'ip_unblocked',
  'anomaly_triggered',
  'recovery_initiated',
  'recovery_completed',
  'backup_code_used',
] as const;

export type AuditEventCode = (typeof AUDIT_EVENT_CODES)[number];

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

/**
 * An audit-log entry as it arrives over the wire. Mirrors the CMS
 * `AuditLogEntry` (`apps/cms/src/modules/audit/logger.ts`) AFTER JSON
 * serialisation: the `timestamp` is an ISO-8601 string here (the CMS
 * holds it as a `Date`), and the nullable columns surface as `null`.
 */
export interface AuditLogEntry {
  id: string;
  timestamp: string;
  event: string;
  actorEmail: string | null;
  targetEmail: string | null;
  ip: string | null;
  userAgent: string | null;
  countryCode: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
}

/** One page of the cursor-paginated list response (`data` envelope). */
export interface AuditLogPage {
  items: AuditLogEntry[];
  nextCursor: string | null;
}

/**
 * The editable filter set driving both the list query and the export.
 * `event` is `''` for the "All events" default; `from`/`to` hold the raw
 * `<input type="datetime-local">` string (local wall-clock, no zone),
 * converted to ISO-8601 only when building the query string.
 */
export interface AuditFilters {
  event: string;
  email: string;
  from: string;
  to: string;
}

/** The empty default filter — "all events, no email, no date bounds". */
export const EMPTY_FILTERS: AuditFilters = {
  event: '',
  email: '',
  from: '',
  to: '',
};

/** Normalised error codes surfaced by the list query + export fetch. */
export type AuditErrorCode =
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'INVALID_RANGE'
  | 'EXPORT_TOO_LARGE'
  | 'UNKNOWN';

/**
 * Error thrown by {@link fetchAuditLogPage} / {@link downloadAuditExport}
 * on any non-2xx response. `code` is normalised against the documented
 * contract; `message` carries the server's message when present so a
 * 400 can render the precise validation reason (design §10.3).
 */
export class AuditError extends Error {
  readonly code: AuditErrorCode;
  readonly status: number | undefined;

  constructor(code: AuditErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    this.status = status;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Query-string + fetch helpers (pure-ish, exported for unit tests)
// ────────────────────────────────────────────────────────────────────────

/**
 * Convert a `<input type="datetime-local">` value (local wall-clock,
 * e.g. `"2024-01-15T10:30"`) into an ISO-8601 UTC string, or `null` when
 * the input is empty or unparseable. The server validates the format, so
 * an unparseable value is simply omitted client-side rather than sent.
 */
export function toIsoOrNull(localValue: string): string | null {
  const trimmed = localValue.trim();
  if (trimmed.length === 0) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Build the query string (WITHOUT a leading `?`) for the list endpoint
 * from the applied filters plus an optional page `cursor`. Empty params
 * are OMITTED entirely so the server sees only the active constraints.
 * `from`/`to` are converted from the datetime-local form to ISO-8601.
 *
 * Pure + exported so a test can assert the exact param set without a DOM.
 */
export function buildAuditLogQuery(
  filters: AuditFilters,
  cursor?: string | null,
): string {
  const params = new URLSearchParams();
  if (filters.event) params.set('event', filters.event);
  const email = filters.email.trim();
  if (email) params.set('email', email);
  const from = toIsoOrNull(filters.from);
  if (from) params.set('from', from);
  const to = toIsoOrNull(filters.to);
  if (to) params.set('to', to);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

/**
 * Build the query string for the EXPORT endpoint — identical to the list
 * query MINUS pagination (`cursor`/`limit` are meaningless for a
 * full-set export; design §10.4). Reuses {@link buildAuditLogQuery} with
 * no cursor.
 */
export function buildAuditExportQuery(filters: AuditFilters): string {
  return buildAuditLogQuery(filters);
}

/** Read the first error code out of the project-standard envelope. */
function firstError(body: unknown): { code?: string; message?: string } {
  if (typeof body !== 'object' || body === null) return {};
  const envelope = body as { errors?: Array<{ code?: string; message?: string }> };
  if (!Array.isArray(envelope.errors)) return {};
  return envelope.errors[0] ?? {};
}

/** Map an HTTP status + envelope to a normalised {@link AuditError}. */
function toAuditError(status: number, body: unknown): AuditError {
  const { code, message } = firstError(body);
  if (status === 403) {
    return new AuditError('FORBIDDEN', 'Admin access required.', 403);
  }
  if (status === 413) {
    return new AuditError(
      'EXPORT_TOO_LARGE',
      message ?? 'Export too large — narrow your filters.',
      413,
    );
  }
  if (status === 400) {
    return new AuditError(
      code === 'INVALID_RANGE' ? 'INVALID_RANGE' : 'VALIDATION_ERROR',
      message ?? 'The request was rejected as invalid.',
      400,
    );
  }
  return new AuditError(
    'UNKNOWN',
    `Request failed with an unexpected response (HTTP ${status}).`,
    status,
  );
}

/**
 * Fetch a single page of the audit log for the given filters + cursor.
 * Returns the `{ items, nextCursor }` `data` envelope, or throws an
 * {@link AuditError} on any non-200 response.
 *
 * Uses `credentials: 'same-origin'` so the session cookie rides along
 * (matching the recovery pages' fetch conventions).
 */
export async function fetchAuditLogPage(
  filters: AuditFilters,
  cursor?: string | null,
): Promise<AuditLogPage> {
  const qs = buildAuditLogQuery(filters, cursor);
  const url = `/api/v1/admin/security/audit-log${qs ? `?${qs}` : ''}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new AuditError('UNKNOWN', 'Network error while contacting the server.');
  }

  if (response.status === 200) {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new AuditError('UNKNOWN', 'The server response could not be parsed.', 200);
    }
    const data = (parsed as { data?: Partial<AuditLogPage> })?.data;
    return {
      items: Array.isArray(data?.items) ? (data!.items as AuditLogEntry[]) : [],
      nextCursor: typeof data?.nextCursor === 'string' ? data!.nextCursor : null,
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  throw toAuditError(response.status, body);
}

/**
 * Trigger a browser download of the NDJSON export for the given filters.
 * Fetches the export endpoint, turns the `Response` into a `Blob`, mints
 * an object URL, clicks a synthetic `<a download="audit-log-export.ndjson">`,
 * then revokes the URL — the same pattern as `step-recovery.tsx`'s
 * `handleDownload`, but sourcing the bytes from the network rather than a
 * locally-built string.
 *
 * Throws an {@link AuditError} on a non-200 response (e.g. 413
 * EXPORT_TOO_LARGE, 403 FORBIDDEN, 400) so the caller can surface the
 * right message WITHOUT having started a download.
 */
export async function downloadAuditExport(filters: AuditFilters): Promise<void> {
  const qs = buildAuditExportQuery(filters);
  const url = `/api/v1/admin/security/audit-log/export${qs ? `?${qs}` : ''}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/x-ndjson' },
    });
  } catch {
    throw new AuditError('UNKNOWN', 'Network error while contacting the server.');
  }

  if (response.status !== 200) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    throw toAuditError(response.status, body);
  }

  // 200 — stream the body into a Blob and click a synthetic anchor.
  // Defensive feature-checks keep this a safe no-op under SSR / test
  // environments missing the DOM or `URL.createObjectURL`.
  const blob = await response.blob();
  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return;
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = 'audit-log-export.ndjson';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    if (typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Presentation helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Pre-validate the date range on the client: `from < to` when BOTH are
 * present. Returns an error string, or `null` when the range is fine (or
 * one/both bounds are absent). The server independently enforces this
 * (INVALID_RANGE) — this is just a fast inline check (design §10.3).
 */
export function validateRange(filters: AuditFilters): string | null {
  const from = toIsoOrNull(filters.from);
  const to = toIsoOrNull(filters.to);
  if (from && to && new Date(from).getTime() >= new Date(to).getTime()) {
    return '"From" must be before "To".';
  }
  return null;
}

/** Map an {@link AuditError} to the operator-facing banner copy. */
function errorMessage(error: unknown): string {
  if (error instanceof AuditError) {
    switch (error.code) {
      case 'FORBIDDEN':
        return 'Admin access required.';
      case 'EXPORT_TOO_LARGE':
        return error.message || 'Export too large — narrow your filters.';
      case 'VALIDATION_ERROR':
      case 'INVALID_RANGE':
        return error.message || 'The request was rejected as invalid.';
      default:
        return 'Something went wrong loading the audit log. Try again.';
    }
  }
  return 'Something went wrong loading the audit log. Try again.';
}

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

const AUDIT_COLUMN_COUNT = 7;

export function SecurityAuditTab() {
  const eventId = useId();
  const emailId = useId();
  const fromId = useId();
  const toId = useId();

  // Draft = the controlled inputs; applied = what the query is keyed on.
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<AuditFilters>(EMPTY_FILTERS);

  // Inline client-side range error (set on a bad "Search").
  const [rangeError, setRangeError] = useState<string | null>(null);

  // Export state — a one-shot manual fetch, NOT a query.
  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const query = useInfiniteQuery<AuditLogPage, AuditError>({
    queryKey: ['security-audit', applied],
    queryFn: ({ pageParam }) =>
      fetchAuditLogPage(applied, pageParam as string | null | undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: false,
  });

  const items = useMemo<AuditLogEntry[]>(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );

  const handleApply = useCallback(() => {
    const err = validateRange(draft);
    if (err) {
      setRangeError(err);
      return;
    }
    setRangeError(null);
    setExportError(null);
    // Copy the draft into the applied filter; the new query key restarts
    // pagination from the first page.
    setApplied({ ...draft });
  }, [draft]);

  const handleExport = useCallback(async () => {
    const err = validateRange(draft);
    if (err) {
      setRangeError(err);
      return;
    }
    setRangeError(null);
    setExportError(null);
    setExportPending(true);
    try {
      await downloadAuditExport(draft);
    } catch (e) {
      setExportError(errorMessage(e));
    } finally {
      setExportPending(false);
    }
  }, [draft]);

  const isInitialLoading = query.isLoading;
  const listError = query.isError ? errorMessage(query.error) : null;

  return (
    <div className="space-y-4">
      {/* ── Filter UI ─────────────────────────────────────────────── */}
      <form
        className="grid grid-cols-1 gap-4 rounded-lg border bg-background p-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          handleApply();
        }}
      >
        <div className="space-y-1">
          <label htmlFor={eventId} className="block text-sm font-medium text-foreground">
            Event
          </label>
          <select
            id={eventId}
            value={draft.event}
            onChange={(e) => setDraft((d) => ({ ...d, event: e.target.value }))}
            className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
          >
            <option value="">All events</option>
            {AUDIT_EVENT_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor={emailId} className="block text-sm font-medium text-foreground">
            Email
          </label>
          <input
            id={emailId}
            type="text"
            inputMode="email"
            spellCheck={false}
            placeholder="actor or target email"
            value={draft.email}
            onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
            className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor={fromId} className="block text-sm font-medium text-foreground">
            From
          </label>
          <input
            id={fromId}
            type="datetime-local"
            value={draft.from}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
            className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor={toId} className="block text-sm font-medium text-foreground">
            To
          </label>
          <input
            id={toId}
            type="datetime-local"
            value={draft.to}
            onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
            className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
          />
        </div>

        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            <span>Search</span>
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={exportPending}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exportPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="h-4 w-4" aria-hidden="true" />
            )}
            <span>Export NDJSON</span>
          </button>
        </div>
      </form>

      {/* ── Inline range validation (client-side, server is authoritative) ── */}
      {rangeError ? (
        <p role="alert" className="text-sm text-red-600">
          {rangeError}
        </p>
      ) : null}

      {/* ── Export error banner ───────────────────────────────────── */}
      {exportError ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{exportError}</span>
        </div>
      ) : null}

      {/* ── List error banner ─────────────────────────────────────── */}
      {listError ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{listError}</span>
        </div>
      ) : null}

      {/* ── Results table ─────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-lg border bg-background shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Timestamp</th>
              <th className="px-4 py-3">Event</th>
              <th className="px-4 py-3">Actor / Target</th>
              <th className="px-4 py-3">IP</th>
              <th className="px-4 py-3">Country</th>
              <th className="px-4 py-3">Request ID</th>
              <th className="px-4 py-3">Metadata</th>
            </tr>
          </thead>
          <tbody>
            {isInitialLoading && (
              <tr>
                <td colSpan={AUDIT_COLUMN_COUNT} className="px-4 py-8 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {!isInitialLoading && !listError && items.length === 0 && (
              <tr>
                <td colSpan={AUDIT_COLUMN_COUNT} className="px-4 py-8 text-center text-muted-foreground">
                  No audit events match these filters.
                </td>
              </tr>
            )}
            {items.map((row) => (
              <tr key={row.id} className="border-b last:border-0 hover:bg-muted/10 align-top">
                <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <Clock className="h-3 w-3" aria-hidden="true" />
                    {formatTimestamp(row.timestamp)}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex rounded bg-muted px-2 py-0.5 text-xs text-foreground">
                    {row.event}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs">
                  <div className="font-medium text-foreground">{row.actorEmail || '-'}</div>
                  {row.targetEmail ? (
                    <div className="text-muted-foreground">→ {row.targetEmail}</div>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{row.ip || '-'}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{row.countryCode || '-'}</td>
                <td className="px-4 py-3">
                  <span
                    className="inline-block max-w-[140px] truncate font-mono text-xs text-muted-foreground"
                    title={row.requestId ?? ''}
                  >
                    {row.requestId || '-'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <MetadataCell metadata={row.metadata} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Load more (cursor pagination; hidden when no next page) ── */}
      {query.hasNextPage ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {query.isFetchingNextPage ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            <span>Load more</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────

/**
 * Render the `metadata` jsonb compactly: a collapsed `<details>` showing
 * pretty-printed JSON, or a dash when empty. Keeps a potentially large
 * object out of the row's default footprint while staying inspectable.
 */
function MetadataCell({ metadata }: { metadata: Record<string, unknown> }) {
  const keys = metadata ? Object.keys(metadata) : [];
  if (keys.length === 0) {
    return <span className="text-xs text-muted-foreground">-</span>;
  }
  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none text-muted-foreground">
        {keys.length} field{keys.length === 1 ? '' : 's'}
      </summary>
      <pre className="mt-1 max-w-[260px] overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-snug">
        {JSON.stringify(metadata, null, 2)}
      </pre>
    </details>
  );
}

/**
 * Format an ISO-8601 timestamp string for display, falling back to the
 * raw string if it doesn't parse (defensive — the server always sends a
 * valid ISO date).
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export default SecurityAuditTab;
