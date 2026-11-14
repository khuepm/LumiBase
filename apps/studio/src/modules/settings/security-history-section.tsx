import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { SecurityHistoryItem, SecurityHistoryKind } from '@lumibase/contracts';
import { describeUserAgent } from '@lumibase/contracts';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';

/**
 * Security history (#739). The caller's own sign-ins, failed attempts, new
 * devices, password / MFA changes and session revocations from
 * `GET /api/v1/me/security-history`, newest first, with "Load more" and an
 * export (`/export?format=csv|json`). Same bearer + `getApiBaseUrl()`
 * plumbing as the sessions section so it works cross-origin and in the
 * desktop shell (contract C2).
 */

export type HistoryScope = 'site' | 'account';

export const SECURITY_HISTORY_QUERY_KEY = ['me-security-history'] as const;

const PAGE_SIZE = 20;

const KIND_LABELS: Record<SecurityHistoryKind, string> = {
  sign_in: 'Signed in',
  sign_in_failed: 'Failed sign-in attempt',
  mfa_challenge_failed: 'Wrong two-factor code',
  new_device: 'Signed in from a new device',
  suspicious_sign_in: 'Unusual sign-in flagged',
  account_locked: 'Account temporarily locked',
  account_unlocked: 'Account unlocked by an administrator',
  password_changed: 'Password changed',
  password_reset_requested: 'Password reset requested',
  password_reset: 'Password reset',
  mfa_enabled: 'Two-factor authentication enabled',
  mfa_disabled: 'Two-factor authentication disabled',
  session_revoked: 'Session signed out',
  sessions_revoked: 'Sessions signed out',
  session_token_reuse: 'Session ended: refresh token reused',
};

const ATTENTION: ReadonlySet<SecurityHistoryKind> = new Set<SecurityHistoryKind>([
  'sign_in_failed',
  'mfa_challenge_failed',
  'new_device',
  'suspicious_sign_in',
  'account_locked',
  'session_token_reuse',
]);

export function describeHistoryItem(item: SecurityHistoryItem): string {
  const base = KIND_LABELS[item.kind] ?? item.kind;
  const d = item.details;
  if (item.kind === 'sign_in' && d.method === 'totp') return `${base} with two-factor code`;
  if (item.kind === 'sessions_revoked' && d.scope === 'others') {
    return typeof d.revoked === 'number' ? `Signed out ${d.revoked} other session(s)` : 'Signed out other sessions';
  }
  if (item.kind === 'sessions_revoked' && d.scope === 'all') return 'Signed out everywhere';
  return base;
}

const headers = () => ({
  Accept: 'application/json',
  'X-Lumi-Site': getActiveSite(),
  'X-Lumi-Client': 'studio',
  Authorization: `Bearer ${getActiveToken()}`,
});

const url = (path: string) => `${getApiBaseUrl()}${path}`;

interface HistoryPage {
  data: SecurityHistoryItem[];
  meta: { nextCursor: string | null };
}

async function fetchPage(scope: HistoryScope, cursor: string | null): Promise<HistoryPage> {
  const qs = new URLSearchParams({ limit: String(PAGE_SIZE), scope });
  if (cursor) qs.set('cursor', cursor);
  const res = await fetch(url(`/api/v1/me/security-history?${qs.toString()}`), { headers: headers() });
  if (!res.ok) throw new Error('Failed to load security history.');
  return (await res.json()) as HistoryPage;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function SecurityHistorySection() {
  const [scope, setScope] = useState<HistoryScope>('site');
  const [message, setMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null);

  const query = useInfiniteQuery({
    queryKey: [...SECURITY_HISTORY_QUERY_KEY, scope],
    queryFn: ({ pageParam }) => fetchPage(scope, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.meta.nextCursor,
  });

  async function download(format: 'csv' | 'json') {
    setExporting(format);
    setMessage(null);
    try {
      const res = await fetch(
        url(`/api/v1/me/security-history/export?format=${format}&scope=${scope}`),
        { headers: headers() },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { errors?: { message?: string }[] } | null;
        throw new Error(body?.errors?.[0]?.message ?? 'Export failed.');
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `security-history.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setExporting(null);
    }
  }

  const items = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <section
      id="security-history"
      aria-labelledby="security-history-heading"
      className="rounded-md border border-border bg-background p-4 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="security-history-heading" className="font-medium">Security history</h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm">
            <span className="sr-only">Show history for</span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value === 'account' ? 'account' : 'site')}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            >
              <option value="site">This site</option>
              <option value="account">All my sites</option>
            </select>
          </label>
          {(['csv', 'json'] as const).map((format) => (
            <button
              key={format}
              type="button"
              disabled={exporting !== null}
              onClick={() => void download(format)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-60"
            >
              {exporting === format ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="h-4 w-4" aria-hidden="true" />
              )}
              Export {format.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Sign-ins, new devices, password and two-factor changes and signed-out sessions for your
        account, newest first. IP addresses are shortened. If you do not recognise an entry, sign
        that session out above and change your password.
      </p>

      {message ? (
        <p role="alert" className="text-sm text-red-600">{message}</p>
      ) : null}

      {query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-red-600">
          Could not load security history. Reload to try again.
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No security events yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => {
            const device = item.userAgent ? describeUserAgent(item.userAgent).label : null;
            const where = [
              device,
              item.ipApprox,
              item.countryCode,
              scope === 'account' && item.siteId ? `site ${item.siteId}` : null,
            ].filter((v): v is string => Boolean(v));
            return (
              <li key={item.id} className="py-2.5">
                <p className="text-sm font-medium">
                  {describeHistoryItem(item)}
                  {ATTENTION.has(item.kind) ? (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                      Review
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground break-all">
                  {formatWhen(item.occurredAt)}
                  {where.length > 0 ? ` · ${where.join(' · ')}` : null}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {query.hasNextPage ? (
        <button
          type="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
          className="inline-flex items-center gap-2 text-sm text-primary underline-offset-2 hover:underline disabled:opacity-60"
        >
          {query.isFetchingNextPage ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Load more
        </button>
      ) : null}
    </section>
  );
}
