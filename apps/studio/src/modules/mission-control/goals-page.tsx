import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bot, GitBranch, User, Workflow } from 'lucide-react';
import { FillIcon } from '@/components/fill-icon';
import { cn } from '@/lib/cn';
import { missionControlApi, type AgentGoalRow, type AgentRunRow } from './api';
import { MissionControlLayout, useMissionControlBase } from './layout';

/**
 * Goal tree (content-os-ui task 13; Req 12.1-12.4): the agent newsroom made
 * visible. Goals nest by parentGoalId — a Planner goal fans out into
 * role-scoped sub-goals — with role/status/origin badges and the latest run
 * per goal. The endpoint returns the latest page only, so an orphan (parent
 * outside the page) renders as a root rather than disappearing.
 */

const ORIGIN_ICONS = { user: User, reconciler: Workflow, planner: GitBranch, flow: Workflow } as const;

const GOAL_TONES: Record<string, string> = {
  done: 'bg-emerald-100 text-emerald-800',
  succeeded: 'bg-emerald-100 text-emerald-800',
  in_progress: 'bg-sky-100 text-sky-800',
  open: 'bg-muted text-muted-foreground',
  failed: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};

interface GoalNode {
  goal: AgentGoalRow;
  children: GoalNode[];
}

export function buildGoalTree(goals: AgentGoalRow[]): GoalNode[] {
  const nodes = new Map(goals.map((g) => [g.id, { goal: g, children: [] as GoalNode[] }]));
  const roots: GoalNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.goal.parentGoalId ? nodes.get(node.goal.parentGoalId) : undefined;
    // Orphans (parent fell off the page) become roots — never dropped (Req 12.4).
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function latestRunByGoal(runs: AgentRunRow[]): Map<string, AgentRunRow> {
  const latest = new Map<string, AgentRunRow>();
  for (const run of runs) {
    const seen = latest.get(run.goalId);
    if (!seen || run.createdAt > seen.createdAt) latest.set(run.goalId, run);
  }
  return latest;
}

function GoalNodeRow({
  node,
  runs,
  depth,
}: {
  node: GoalNode;
  runs: Map<string, AgentRunRow>;
  depth: number;
}) {
  const base = useMissionControlBase();
  const { goal } = node;
  const OriginIcon = ORIGIN_ICONS[goal.origin as keyof typeof ORIGIN_ICONS] ?? User;
  const role = goal.agentRole ?? goal.assigneeAgent;
  const run = runs.get(goal.id);

  return (
    <li>
      <div
        className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2"
        style={{ marginLeft: depth * 24 }}
      >
        <FillIcon
          icon={OriginIcon}
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-label={`origin: ${goal.origin}`}
        />
        <span className="text-sm font-medium">{goal.title}</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-800">
          <FillIcon icon={Bot} className="h-3 w-3" /> {role}
        </span>
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 text-[10px]',
            GOAL_TONES[goal.status] ?? 'bg-muted text-muted-foreground',
          )}
        >
          {goal.status}
        </span>
        {run && (
          <span className="text-[10px] text-muted-foreground">
            last run: {run.status} · {run.model}
          </span>
        )}
        {goal.intentId && (
          <Link
            to={`${base}/intents/${goal.intentId}` as never}
            className="ml-auto text-xs text-primary hover:underline"
          >
            Intent →
          </Link>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="mt-1 space-y-1">
          {node.children.map((child) => (
            <GoalNodeRow key={child.goal.id} node={child} runs={runs} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function GoalsBody() {
  const goalsQuery = useQuery({
    queryKey: ['mc-goals'],
    queryFn: missionControlApi.goals,
    refetchInterval: 60_000,
    retry: false,
  });
  const runsQuery = useQuery({
    queryKey: ['mc-runs'],
    queryFn: missionControlApi.runs,
    refetchInterval: 60_000,
    retry: false,
  });

  if (goalsQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading goals…</p>;
  }

  const roots = buildGoalTree(goalsQuery.data ?? []);
  if (roots.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No goals yet — compose an intent or give an agent a goal to see the newsroom at work.
      </p>
    );
  }

  const runs = latestRunByGoal(runsQuery.data ?? []);
  return (
    <ul className="space-y-1">
      {roots.map((node) => (
        <GoalNodeRow key={node.goal.id} node={node} runs={runs} depth={0} />
      ))}
    </ul>
  );
}

export function GoalsPage() {
  return (
    <MissionControlLayout>
      <GoalsBody />
    </MissionControlLayout>
  );
}
