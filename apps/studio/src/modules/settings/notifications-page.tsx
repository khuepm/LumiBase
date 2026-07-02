import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import {
  BellRing,
  BellOff,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Send,
  ShieldCheck,
} from 'lucide-react';
import {
  disablePush,
  enablePush,
  getPushState,
  getPushStatus,
  sendTestPush,
  type PushState,
} from '@/lib/push';

/**
 * Settings → Notifications (push-noti feature).
 *
 * A simple per-tenant control surface: a server "check" panel, a per-browser
 * enable/verify toggle, and a short guide for connecting the frontend. The
 * VAPID key is a deployment-wide shared resource; subscriptions and delivery
 * are isolated per tenant (site_id + RLS) — the copy here makes that explicit.
 */

function StatusRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
      )}
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

export function NotificationsSettingsPage() {
  const statusQuery = useQuery({
    queryKey: ['push', 'status'],
    queryFn: getPushStatus,
    retry: false,
  });

  const [pushState, setPushState] = useState<PushState>('unsupported');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    void getPushState().then(setPushState);
  }, []);

  const toggle = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (pushState === 'subscribed') {
        await disablePush();
        setPushState('unsubscribed');
        setMessage({ kind: 'ok', text: 'Push disabled on this browser.' });
      } else {
        const { state, reason } = await enablePush();
        setPushState(state);
        setMessage(
          state === 'subscribed'
            ? { kind: 'ok', text: 'Push enabled on this browser.' }
            : { kind: 'err', text: reason ?? 'Could not enable push.' },
        );
      }
      void statusQuery.refetch();
    } finally {
      setBusy(false);
    }
  }, [pushState, statusQuery]);

  const test = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await sendTestPush();
      setMessage({
        kind: 'ok',
        text: `Test dispatched — ${res.subscriptions} Web Push subscription(s) for this site${
          res.realtimeAvailable ? ' + in-app' : ''
        }. Watch the bell / your OS notifications.`,
      });
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Test failed.' });
    } finally {
      setBusy(false);
    }
  }, []);

  const status = statusQuery.data;

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Notifications</h1>
        <p className="text-sm text-muted-foreground">
          Push notifications for operational agent events (approvals, veto windows, incidents,
          goal/run status) — delivered in-app and via Web Push. Subscriptions are scoped to this
          site only.
        </p>
      </header>

      {/* 1. Server check */}
      <section className="rounded-lg border bg-background p-4 shadow-sm">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" /> Server check
        </h2>
        {statusQuery.isLoading ? (
          <div className="py-4 text-sm text-muted-foreground">Checking…</div>
        ) : statusQuery.isError || !status ? (
          <div className="py-4 text-sm text-destructive">Failed to load push status.</div>
        ) : (
          <div className="divide-y">
            <StatusRow
              ok={status.vapidConfigured}
              label="Web Push (VAPID)"
              detail={
                status.vapidConfigured
                  ? 'VAPID keys are configured for this deployment.'
                  : 'No VAPID keys — Web Push is disabled. An operator must set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT.'
              }
            />
            <StatusRow
              ok={status.realtimeAvailable}
              label="In-app realtime"
              detail={
                status.realtimeAvailable
                  ? 'SiteRoom realtime is available (Cloudflare).'
                  : 'No SiteRoom binding — in-app realtime is off (e.g. Docker). The inbox poll is the fallback.'
              }
            />
            <StatusRow
              ok={status.subscriptions > 0}
              label="Enrolled browsers (this site)"
              detail={`${status.subscriptions} Web Push subscription(s) registered for this tenant.`}
            />
          </div>
        )}
      </section>

      {/* 2. This browser + verify */}
      <section className="rounded-lg border bg-background p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">This browser</h2>
        {pushState === 'unsupported' ? (
          <p className="text-sm text-muted-foreground">
            This browser does not support the Web Push API. In-app notifications still work while
            the Studio tab is open.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={toggle}
              disabled={busy || pushState === 'denied'}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : pushState === 'subscribed' ? (
                <BellOff className="h-4 w-4" />
              ) : (
                <BellRing className="h-4 w-4" />
              )}
              {pushState === 'subscribed' ? 'Disable push' : 'Enable push'}
            </button>
            <button
              type="button"
              onClick={test}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              <Send className="h-4 w-4" /> Send test notification
            </button>
            {pushState === 'denied' && (
              <span className="text-xs text-amber-600">
                Blocked in browser settings — allow notifications for this site, then reload.
              </span>
            )}
          </div>
        )}
        {message && (
          <p
            className={`mt-3 text-xs ${message.kind === 'ok' ? 'text-emerald-600' : 'text-destructive'}`}
          >
            {message.text}
          </p>
        )}
      </section>

      {/* 3. Guide */}
      <section className="rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-semibold">How to connect the frontend</h2>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            Ensure the deployment has VAPID keys set (see Server check above). Generate a pair with{' '}
            <code className="rounded bg-muted px-1 font-mono text-xs">
              node apps/cms/scripts/generate-vapid-keys.mjs
            </code>
            .
          </li>
          <li>Click <span className="font-medium">Enable push</span> and accept the browser permission prompt.</li>
          <li>
            The browser registers a service worker (<code className="rounded bg-muted px-1 font-mono text-xs">/sw.js</code>)
            and POSTs its subscription to <code className="rounded bg-muted px-1 font-mono text-xs">/api/v1/push/subscriptions</code>{' '}
            (scoped to this site).
          </li>
          <li>Click <span className="font-medium">Send test notification</span> to verify end-to-end delivery.</li>
          <li>
            In-app notifications appear in the bell menu automatically while Studio is open — no
            opt-in needed.
          </li>
        </ol>
        <p className="mt-3 text-xs text-muted-foreground">
          Multi-tenant note: the VAPID key pair is shared across all tenants (it identifies the
          application server to the push service, not the tenant). Each subscription, and every
          notification fan-out, is isolated by <code className="rounded bg-muted px-1 font-mono text-xs">site_id</code>{' '}
          — a tenant only ever receives its own events.
        </p>
      </section>
    </div>
  );
}
