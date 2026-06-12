import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { FillIcon } from '@/components/fill-icon';
import { cn } from '@/lib/cn';
import { missionControlApi } from './api';

/**
 * Recent agent activity (content-os-ui task 11.2; Req 10.1-10.3): the
 * latest runs with their goal titles, so the dashboard answers "what has
 * the system been doing" at a glance. Goal titles join client-side; a run
 * whose goal fell off the goals page degrades to a shortened goal id —
 * the run is never dropped.
 */

const FEED_LIMIT = 12;

const STATUS_TONES: Record<string, string> = {
  succeeded: 'bg-emerald-100 text-emerald-800',
  done: 'bg-emerald-100 text-emerald-800',
  running: 'bg-sky-100 text-sky-800',
  queued: 'bg-muted text-muted-foreground',
  awaiting_approval: 'bg-amber-100 text-amber-800',
  failed: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};

function RunStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-0.5 text-[10px]',
        STATUS_TONES[status] ?? 'bg-muted text-muted-foreground',
      )}
    >
      {status}
    </span>
  );
}

export function ActivityFeed() {
  const runsQuery = useQuery({
    queryKey: ['mc-runs'],
    queryFn: missionControlApi.runs,
    refetchInterval: 60_000,
    retry: false,
  });
  const goalsQuery = useQuery({
    queryKey: ['mc-goals'],
    queryFn: missionControlApi.goals,
    refetchInterval: 60_000,
    retry: false,
  });

  if (runsQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading activity…</p>;
  }

  const runs = (runsQuery.data ?? []).slice(0, FEED_LIMIT);
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No agent runs yet.</p>;
  }

  const goalTitles = new Map((goalsQuery.data ?? []).map((g) => [g.id, g.title]));

  return (
    <ul className="space-y-1.5">
      {runs.map((run) => (
        <li key={run.id} className="flex items-start gap-2 text-xs">
          <FillIcon icon={Bot} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-600" />
          <span className="min-w-0">
            <span className="font-medium">{run.agentName}</span>
            <span className="text-muted-foreground"> · {run.model} · </span>
            <RunStatusBadge status={run.status} />
            <span className="block truncate text-muted-foreground">
              {goalTitles.get(run.goalId) ?? `goal ${run.goalId.slice(0, 8)}…`}
            </span>
            <span className="block text-[10px] text-muted-foreground">
              {new Date(run.startedAt).toLocaleString()}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
