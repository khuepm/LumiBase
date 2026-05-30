import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, Clock } from 'lucide-react';
import { getApiClient } from '@/lib/api';
import { SecurityAuditTab } from './security-audit-tab';

/**
 * Settings → Activity page.
 *
 * Hosts TWO tabs (admin-setup-wizard task 12.4):
 *
 *   1. "Activity" — the original chronological activity-log table backed
 *      by `client.activity.list(...)`. Its body is unchanged; it has only
 *      moved into a tab panel.
 *   2. "Security audit" — the admin-only audit-log read surface
 *      ({@link SecurityAuditTab}) over `/api/v1/admin/security/audit-log`,
 *      with event/email/date-range filters, cursor "Load more"
 *      pagination, and an NDJSON export (Req 15.4, 15.6; design §10.3).
 *
 * ── Tabs ─────────────────────────────────────────────────────────────
 *
 * `@lumibase/ui` exposes no Tabs primitive yet (it currently only exports
 * `cn`), so the switcher is hand-rolled with the WAI-ARIA tabs pattern:
 * a `role="tablist"` of `role="tab"` buttons driving `aria-selected` +
 * `aria-controls`, each paired with a `role="tabpanel"`. A local
 * `useState<'activity' | 'security'>` owns the active tab — no routing
 * change, so the existing `/settings/activity` route is untouched.
 */

type SettingsTab = 'activity' | 'security';

export function ActivityPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SettingsTab>('activity');

  // Stable ids linking each tab button to its panel (a11y).
  const activityTabId = useId();
  const activityPanelId = useId();
  const securityTabId = useId();
  const securityPanelId = useId();

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">
          {t('activity_log', 'Activity Log')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          View a chronological record of all system events.
        </p>
      </header>

      {/* ── Tab switcher (WAI-ARIA tabs pattern) ──────────────────── */}
      <div role="tablist" aria-label="Activity views" className="flex gap-1 border-b">
        <button
          type="button"
          role="tab"
          id={activityTabId}
          aria-selected={tab === 'activity'}
          aria-controls={activityPanelId}
          onClick={() => setTab('activity')}
          className={tabClass(tab === 'activity')}
        >
          <Activity className="h-4 w-4" aria-hidden="true" />
          <span>{t('activity_tab', 'Activity')}</span>
        </button>
        <button
          type="button"
          role="tab"
          id={securityTabId}
          aria-selected={tab === 'security'}
          aria-controls={securityPanelId}
          onClick={() => setTab('security')}
          className={tabClass(tab === 'security')}
        >
          <span>{t('security_audit_tab', 'Security audit')}</span>
        </button>
      </div>

      {/* ── Activity panel ────────────────────────────────────────── */}
      <div
        role="tabpanel"
        id={activityPanelId}
        aria-labelledby={activityTabId}
        hidden={tab !== 'activity'}
      >
        {tab === 'activity' ? <ActivityLogTable /> : null}
      </div>

      {/* ── Security audit panel ──────────────────────────────────── */}
      <div
        role="tabpanel"
        id={securityPanelId}
        aria-labelledby={securityTabId}
        hidden={tab !== 'security'}
      >
        {tab === 'security' ? <SecurityAuditTab /> : null}
      </div>
    </div>
  );
}

/** Shared className for a tab button, styled by its selected state. */
function tabClass(selected: boolean): string {
  const base =
    'inline-flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition -mb-px';
  return selected
    ? `${base} border-primary text-foreground`
    : `${base} border-transparent text-muted-foreground hover:text-foreground hover:border-border`;
}

/**
 * The original "Activity Log" table — unchanged behaviour, lifted out of
 * the page body into its own component so the page can host it inside a
 * tab panel. Backed by `client.activity.list(...)`.
 */
function ActivityLogTable() {
  const client = getApiClient();

  const activityQuery = useQuery({
    queryKey: ['activity'],
    queryFn: async () => (await client.activity.list({ limit: 100 })).data,
  });

  const activityList = activityQuery.data ?? [];

  return (
    <div className="overflow-hidden rounded-lg border bg-background shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground border-b">
          <tr>
            <th className="px-4 py-3">Timestamp</th>
            <th className="px-4 py-3">User ID</th>
            <th className="px-4 py-3">Action</th>
            <th className="px-4 py-3">Target</th>
            <th className="px-4 py-3">IP / Agent</th>
          </tr>
        </thead>
        <tbody>
          {activityQuery.isLoading && (
            <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
          )}
          {!activityQuery.isLoading && activityList.length === 0 && (
            <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No activity recorded yet.</td></tr>
          )}
          {activityList.map((row) => (
            <tr key={row.id} className="border-b hover:bg-muted/10 last:border-0">
              <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Clock className="h-3 w-3" />
                  {new Date(row.createdAt).toLocaleString()}
                </div>
              </td>
              <td className="px-4 py-3 font-medium">
                {row.userId || 'System'}
              </td>
              <td className="px-4 py-3">
                <span className="inline-flex rounded bg-muted px-2 py-0.5 text-xs text-foreground">
                  {row.action}
                </span>
              </td>
              <td className="px-4 py-3">
                {row.collection ? (
                  <span className="text-muted-foreground">
                    {row.collection} {row.itemId ? `/ ${row.itemId}` : ''}
                  </span>
                ) : '-'}
              </td>
              <td className="px-4 py-3 text-xs text-muted-foreground">
                {row.ip || '-'}
                <br />
                <span className="truncate max-w-[150px] inline-block" title={row.userAgent ?? ''}>
                  {row.userAgent || ''}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
