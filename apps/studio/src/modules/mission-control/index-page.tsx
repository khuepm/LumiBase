import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Clock, Gauge, Inbox, OctagonX } from 'lucide-react';
import type { ReactNode } from 'react';
import { DashboardWidget, WidgetSkeleton } from '@/components/dashboard-widget';
import { cn } from '@/lib/cn';
import { ActivityFeed } from './activity-feed';
import { missionControlApi } from './api';
import { ExceptionInbox } from './inbox';
import {
  MissionControlLayout,
  useMissionControlActions,
  useMissionControlBase,
} from './layout';
import { RolloutFlagsPanel } from './rollout-flags';
import { SloTable, sloHealthCard, sloSummary, useSloRows } from './slo-table';
import { useInboxData } from './use-inbox';

/**
 * Mission Control dashboard (content-os-ui task 3; Req 2.1-2.5).
 *
 * The operator's "is the system OK, does it need me?" answer in one glance:
 * a stat row over the whole Content OS, the five most urgent exceptions
 * with their inline actions, and SLO health per intent. Every card links
 * into the sub-route that holds the full story.
 *
 * Progressive (#757): every card and section reads its own query and shows
 * its own placeholder, so the board paints as each source answers instead of
 * waiting on the slowest one, and a widget that throws is contained by its
 * `DashboardWidget` boundary.
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
  loading = false,
}: {
  icon: ReactNode;
  value: string;
  /** Source still loading: show a placeholder, never a fake value. */
  loading?: boolean;
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
          !loading && tone === 'alert' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span>
        {loading ? (
          <span aria-label={`Loading ${label}`} className="block h-5 w-10 animate-pulse rounded bg-muted" />
        ) : (
          <span className="block text-lg font-semibold leading-tight">{value}</span>
        )}
        <span className="block text-xs text-muted-foreground">{label}</span>
      </span>
    </>
  );
  const cls =
    'flex w-full items-center gap-3 rounded-lg border bg-background p-3 text-start hover:bg-muted/40';
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

function SloHealthSection({ base }: { base: string }) {
  const { rows, isLoading } = useSloRows();
  if (isLoading) return <WidgetSkeleton label="Loading SLO health" />;
  return <SloTable rows={rows} linkBase={`${base}/intents`} />;
}

function DashboardBody() {
  const base = useMissionControlBase();
  const { openKillSwitch } = useMissionControlActions();
  const { counts, loading } = useInboxData();
  const { rows, isLoading: sloLoading } = useSloRows();
  const killSwitchQuery = useQuery({
    queryKey: ['mc-kill-switch'],
    queryFn: missionControlApi.killSwitch,
  });

  const activeFreezes = killSwitchQuery.data?.active.length ?? 0;
  const needsHuman = counts.approvals + counts.questions + counts.intentErrors;
  const sloCard = sloHealthCard(sloSummary(rows));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          icon={<Inbox className="h-4 w-4" />}
          value={String(needsHuman)}
          loading={loading.approvals || loading.questions || loading.intents}
          label="awaiting decision"
          tone={needsHuman > 0 ? 'alert' : 'ok'}
          to={`${base}/inbox`}
        />
        <StatCard
          icon={<Clock className="h-4 w-4" />}
          value={
            counts.nearestAutoCommitAt ? formatRemaining(counts.nearestAutoCommitAt) : '—'
          }
          loading={loading.staged}
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
          value={sloCard.value}
          loading={sloLoading}
          label={sloCard.label}
          tone={sloCard.tone}
          to={`${base}/intents`}
        />
        <StatCard
          icon={<OctagonX className="h-4 w-4" />}
          value={String(activeFreezes)}
          loading={killSwitchQuery.isLoading}
          label={activeFreezes === 1 ? 'active freeze' : 'active freezes'}
          tone={activeFreezes > 0 ? 'alert' : 'ok'}
          onClick={openKillSwitch}
        />
        <StatCard
          icon={<AlertTriangle className="h-4 w-4" />}
          value={String(counts.incidents)}
          loading={loading.autonomy}
          label="open incidents"
          tone={counts.incidents > 0 ? 'alert' : 'ok'}
          to={`${base}/inbox`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[3fr_2fr]">
        <DashboardWidget
          title="Exceptions"
          action={
            <Link to={`${base}/inbox` as never} className="text-xs text-primary hover:underline">
              Open inbox →
            </Link>
          }
        >
          <ExceptionInbox limit={5} />
        </DashboardWidget>

        <div className="space-y-4">
          <DashboardWidget
            title="SLO health"
            action={
              <Link to={`${base}/intents` as never} className="text-xs text-primary hover:underline">
                All intents →
              </Link>
            }
          >
            <SloHealthSection base={base} />
          </DashboardWidget>

          <DashboardWidget
            title="Agent activity"
            action={
              <Link to={`${base}/goals` as never} className="text-xs text-primary hover:underline">
                Goal tree →
              </Link>
            }
          >
            <ActivityFeed />
          </DashboardWidget>

          {/* Rollout switchboard (content-os-ui Req 15): which subsystems are armed. */}
          <DashboardWidget title="Rollout">
            <RolloutFlagsPanel />
          </DashboardWidget>
        </div>
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
