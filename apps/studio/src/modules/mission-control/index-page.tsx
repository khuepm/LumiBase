import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Clock, Gauge, Inbox, OctagonX } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { missionControlApi } from './api';
import { ExceptionInbox } from './inbox';
import {
  MissionControlLayout,
  useMissionControlActions,
  useMissionControlBase,
} from './layout';
import { SloTable, useSloRows } from './slo-table';
import { useInboxData } from './use-inbox';

/**
 * Mission Control dashboard (content-os-ui task 3; Req 2.1-2.5).
 *
 * The operator's "is the system OK, does it need me?" answer in one glance:
 * a stat row over the whole Content OS, the five most urgent exceptions
 * with their inline actions, and SLO health per intent. Every card links
 * into the sub-route that holds the full story.
 */

function formatRemaining(deadline: string): string {
  const remaining = new Date(deadline).getTime() - Date.now();
  if (remaining <= 0) return 'committing…';
  const minutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function StatCard({
  icon,
  value,
  label,
  tone,
  to,
  onClick,
}: {
  icon: ReactNode;
  value: string;
  label: string;
  tone?: 'alert' | 'ok';
  to?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span
        className={cn(
          'inline-flex h-8 w-8 items-center justify-center rounded-md',
          tone === 'alert' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span>
        <span className="block text-lg font-semibold leading-tight">{value}</span>
        <span className="block text-xs text-muted-foreground">{label}</span>
      </span>
    </>
  );
  const cls =
    'flex w-full items-center gap-3 rounded-lg border bg-background p-3 text-left hover:bg-muted/40';
  return to ? (
    <Link to={to as never} className={cls}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  );
}

function DashboardBody() {
  const base = useMissionControlBase();
  const { openKillSwitch } = useMissionControlActions();
  const { counts, isLoading } = useInboxData();
  const { rows, isLoading: sloLoading } = useSloRows();
  const killSwitchQuery = useQuery({
    queryKey: ['mc-kill-switch'],
    queryFn: missionControlApi.killSwitch,
  });

  const activeFreezes = killSwitchQuery.data?.active.length ?? 0;
  const needsHuman = counts.approvals + counts.intentErrors;
  const activeRows = rows.filter((r) => r.intent.status === 'active');
  const sloHealth =
    activeRows.length === 0
      ? null
      : Math.round(activeRows.reduce((sum, r) => sum + r.health, 0) / activeRows.length);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          icon={<Inbox className="h-4 w-4" />}
          value={isLoading ? '…' : String(needsHuman)}
          label="awaiting decision"
          tone={needsHuman > 0 ? 'alert' : 'ok'}
          to={`${base}/inbox`}
        />
        <StatCard
          icon={<Clock className="h-4 w-4" />}
          value={
            counts.nearestAutoCommitAt ? formatRemaining(counts.nearestAutoCommitAt) : '—'
          }
          label={
            counts.staged > 0
              ? `next auto-commit (${counts.staged} staged)`
              : 'nothing staged'
          }
          tone={counts.staged > 0 ? 'alert' : 'ok'}
          to={`${base}/inbox`}
        />
        <StatCard
          icon={<Gauge className="h-4 w-4" />}
          value={sloLoading ? '…' : sloHealth === null ? '—' : `${sloHealth}%`}
          label="SLO health (active intents)"
          tone={sloHealth !== null && sloHealth < 90 ? 'alert' : 'ok'}
          to={`${base}/intents`}
        />
        <StatCard
          icon={<OctagonX className="h-4 w-4" />}
          value={String(activeFreezes)}
          label={activeFreezes === 1 ? 'active freeze' : 'active freezes'}
          tone={activeFreezes > 0 ? 'alert' : 'ok'}
          onClick={openKillSwitch}
        />
        <StatCard
          icon={<AlertTriangle className="h-4 w-4" />}
          value={String(counts.incidents)}
          label="open incidents"
          tone={counts.incidents > 0 ? 'alert' : 'ok'}
          to={`${base}/inbox`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[3fr_2fr]">
        <section className="rounded-lg border bg-background p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Exceptions</h2>
            <Link to={`${base}/inbox` as never} className="text-xs text-primary hover:underline">
              Open inbox →
            </Link>
          </div>
          <ExceptionInbox limit={5} />
        </section>

        <section className="rounded-lg border bg-background p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">SLO health</h2>
            <Link to={`${base}/intents` as never} className="text-xs text-primary hover:underline">
              All intents →
            </Link>
          </div>
          {sloLoading ? (
            <p className="text-sm text-muted-foreground">Loading SLO health…</p>
          ) : (
            <SloTable rows={rows} linkBase={`${base}/intents`} />
          )}
        </section>
      </div>
    </div>
  );
}

export function MissionControlPage() {
  return (
    <MissionControlLayout>
      <DashboardBody />
    </MissionControlLayout>
  );
}
