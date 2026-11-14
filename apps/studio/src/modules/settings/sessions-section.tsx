import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Laptop, Loader2, Smartphone } from 'lucide-react';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';
import { describeUserAgent } from '@lumibase/contracts';

/**
 * Active sessions & devices (#730). Lists the caller's live sign-ins from
 * `GET /api/v1/me/sessions`, revokes one (`DELETE /me/sessions/:sessionId`)
 * or every other one (`DELETE /me/sessions?scope=others`). A revoked
 * device's access token stops working immediately, not at its expiry.
 *
 * Same bearer + `getApiBaseUrl()` plumbing as the two-factor section so it
 * works cross-origin and in the desktop shell (contract C2).
 */

export interface SessionRow {
  id: string;
  sessionId: string;
  audience: string;
  startedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  lastIp: string | null;
  lastUserAgent: string | null;
  current: boolean;
}

export const SESSIONS_QUERY_KEY = ['me-sessions'] as const;

const headers = () => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'X-Lumi-Site': getActiveSite(),
  'X-Lumi-Client': 'studio',
  Authorization: `Bearer ${getActiveToken()}`,
});

const url = (path: string) => `${getApiBaseUrl()}${path}`;

async function fetchSessions(): Promise<SessionRow[]> {
  const res = await fetch(url('/api/v1/me/sessions'), { headers: headers() });
  if (!res.ok) throw new Error('Failed to load sessions.');
  const json = (await res.json()) as { data: SessionRow[] };
  return json.data;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { errors?: { message?: string }[] } | null;
  return body?.errors?.[0]?.message ?? fallback;
}

// `describeUserAgent` lives in `@lumibase/contracts` so the CMS new-device
// email (#739) labels a device exactly like this list does. Re-exported for
// existing importers.
export { describeUserAgent };

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function SessionsSection() {
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const query = useQuery({ queryKey: SESSIONS_QUERY_KEY, queryFn: fetchSessions });

  const revokeOne = useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await fetch(url(`/api/v1/me/sessions/${encodeURIComponent(sessionId)}`), {
        method: 'DELETE',
        headers: headers(),
      });
      if (!res.ok) throw new Error(await errorMessage(res, 'Could not sign out that session.'));
    },
    onSuccess: () => {
      setMessage('Session signed out.');
      void qc.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const revokeOthers = useMutation({
    mutationFn: async () => {
      const res = await fetch(url('/api/v1/me/sessions?scope=others'), {
        method: 'DELETE',
        headers: headers(),
      });
      if (!res.ok) throw new Error(await errorMessage(res, 'Could not sign out other sessions.'));
      const json = (await res.json()) as { data: { revoked: number } };
      return json.data.revoked;
    },
    onSuccess: (revoked) => {
      setMessage(revoked === 1 ? 'Signed out 1 other session.' : `Signed out ${revoked} other sessions.`);
      void qc.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const sessions = query.data ?? [];
  const others = sessions.filter((s) => !s.current).length;

  return (
    <section
      id="active-sessions"
      aria-labelledby="sessions-heading"
      className="rounded-md border border-border bg-background p-4 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="sessions-heading" className="font-medium">Active sessions</h2>
        <button
          type="button"
          disabled={revokeOthers.isPending || others === 0}
          onClick={() => revokeOthers.mutate()}
          className="inline-flex items-center gap-2 rounded-md border border-destructive px-3 py-1.5 text-sm text-destructive disabled:opacity-60"
        >
          {revokeOthers.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Sign out other sessions
        </button>
      </div>
      <p className="text-sm text-muted-foreground">
        Devices signed in to this site with your account. Signing a session out takes effect
        immediately. Changing your password signs out every session; enabling two-factor
        authentication signs out every session except this one.
      </p>

      {message ? (
        <p role="status" className="text-sm">{message}</p>
      ) : null}

      {query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-red-600">
          Could not load sessions. Reload to try again.
        </p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active sessions.</p>
      ) : (
        <ul className="divide-y divide-border">
          {sessions.map((s) => {
            const device = describeUserAgent(s.lastUserAgent);
            const Icon = device.mobile ? Smartphone : Laptop;
            return (
              <li key={s.sessionId} className="flex items-start justify-between gap-3 py-3">
                <div className="flex min-w-0 gap-3">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium">
                      {device.label}
                      {s.current ? (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal">
                          This device
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground break-all">
                      {s.lastIp ?? 'Unknown IP'} · signed in {formatWhen(s.startedAt)} · last active{' '}
                      {formatWhen(s.lastSeenAt)}
                    </p>
                  </div>
                </div>
                {s.current ? null : (
                  <button
                    type="button"
                    disabled={revokeOne.isPending}
                    onClick={() => revokeOne.mutate(s.sessionId)}
                    aria-label={`Sign out ${device.label}`}
                    className="shrink-0 text-sm text-destructive underline-offset-2 hover:underline disabled:opacity-60"
                  >
                    Sign out
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
