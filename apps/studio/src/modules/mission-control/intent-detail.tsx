import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { AlertTriangle, Pause, Play } from 'lucide-react';
import { cn } from '@/lib/cn';
import { missionControlApi } from './api';
import { MissionControlLayout, useAdminBase, useMissionControlBase } from './layout';
import { IntentStatusBadge } from './slo-table';

/**
 * Intent detail (content-os-ui task 6.2; Req 5.2-5.5): what the intent
 * governs (rules as cards, schedule, budget, autonomy ceiling) and where
 * reality deviates from it (drift list linking to the items). Pause goes
 * through the kill switch's `intent` scope — that IS the pause mechanism
 * (content-os Req 14.1); resume uses the dedicated resume endpoint.
 */

const LEVEL_LABELS = ['L0 shadow', 'L1 propose', 'L2 co-sign', 'L3 veto-window', 'L4 autopilot'];

function RuleCard({ rule }: { rule: unknown }) {
  if (typeof rule !== 'object' || rule === null) {
    return (
      <li className="rounded-lg border p-3 text-xs">
        <code>{JSON.stringify(rule)}</code>
      </li>
    );
  }
  const { type, ...params } = rule as Record<string, unknown>;
  return (
    <li className="rounded-lg border p-3">
      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-medium">
        {typeof type === 'string' ? type : 'rule'}
      </span>
      {Object.keys(params).length > 0 && (
        <dl className="mt-2 space-y-0.5 text-xs">
          {Object.entries(params).map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="font-mono">{JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

function IntentDetailBody({ intentId }: { intentId: string }) {
  const adminBase = useAdminBase();
  const base = useMissionControlBase();
  const queryClient = useQueryClient();

  const intentsQuery = useQuery({ queryKey: ['mc-intents'], queryFn: missionControlApi.intents });
  const driftsQuery = useQuery({
    queryKey: ['mc-drifts', intentId],
    queryFn: () => missionControlApi.drifts(intentId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['mc-intents'] });
    queryClient.invalidateQueries({ queryKey: ['mc-kill-switch'] });
  };
  const pauseMutation = useMutation({
    mutationFn: () =>
      missionControlApi.activateKillSwitch('intent', intentId, 'Paused from intent detail'),
    onSuccess: invalidate,
  });
  const resumeMutation = useMutation({
    mutationFn: () => missionControlApi.resumeIntent(intentId),
    onSuccess: invalidate,
  });

  if (intentsQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading intent…</p>;
  }

  const intent = (intentsQuery.data ?? []).find((i) => i.id === intentId);
  if (!intent) {
    return (
      <div className="rounded-lg border bg-background p-6 text-center">
        <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
        <p className="text-sm font-medium">Intent not found in this site.</p>
        <Link to={`${base}/intents` as never} className="mt-2 inline-block text-xs text-primary hover:underline">
          ← Back to intents
        </Link>
      </div>
    );
  }

  const drifts = driftsQuery.data ?? [];
  const budget = intent as unknown as { budget?: Record<string, unknown> };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background p-4">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            {intent.name} <IntentStatusBadge status={intent.status} />
          </h2>
          <p className="text-xs text-muted-foreground">
            <code className="rounded bg-muted px-1">{intent.collection}</code>
            {' · '}schedule <code className="rounded bg-muted px-1">{intent.schedule}</code>
            {' · '}autonomy cap{' '}
            <span className="font-medium">
              {LEVEL_LABELS[intent.autonomyCap] ?? `L${intent.autonomyCap}`}
            </span>
          </p>
          {intent.statusReason && (
            <p className="text-xs text-destructive">{intent.statusReason}</p>
          )}
        </div>
        {intent.status === 'active' ? (
          <button
            type="button"
            onClick={() => pauseMutation.mutate()}
            disabled={pauseMutation.isPending}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            <Pause className="h-4 w-4" /> {pauseMutation.isPending ? 'Pausing…' : 'Pause'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => resumeMutation.mutate()}
            disabled={resumeMutation.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-400 px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
          >
            <Play className="h-4 w-4" /> {resumeMutation.isPending ? 'Resuming…' : 'Resume'}
          </button>
        )}
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-lg border bg-background p-4">
          <h3 className="mb-2 text-sm font-semibold">Rules</h3>
          {intent.rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">This intent declares no rules.</p>
          ) : (
            <ul className="space-y-2">
              {intent.rules.map((rule, i) => (
                <RuleCard key={i} rule={rule} />
              ))}
            </ul>
          )}
          {budget.budget && Object.keys(budget.budget).length > 0 && (
            <>
              <h3 className="mb-2 mt-4 text-sm font-semibold">Budget</h3>
              <dl className="space-y-0.5 text-xs">
                {Object.entries(budget.budget).map(([key, value]) => (
                  <div key={key} className="flex gap-2">
                    <dt className="text-muted-foreground">{key}</dt>
                    <dd className="font-mono">{JSON.stringify(value)}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </section>

        <section className="rounded-lg border bg-background p-4">
          <h3 className="mb-2 text-sm font-semibold">Drifts</h3>
          {driftsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading drifts…</p>
          ) : drifts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No drift detected — content meets the SLO.</p>
          ) : (
            <ul className="space-y-1">
              {drifts.map((drift) => (
                <li
                  key={drift.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs"
                >
                  <span className="inline-flex items-center gap-2">
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5',
                        drift.status === 'resolved'
                          ? 'bg-emerald-100 text-emerald-800'
                          : drift.status === 'stale'
                            ? 'bg-muted text-muted-foreground'
                            : 'bg-amber-100 text-amber-800',
                      )}
                    >
                      {drift.status}
                    </span>
                    <code className="rounded bg-muted px-1">{drift.ruleType}</code>
                    {drift.ruleKey && drift.ruleKey !== drift.ruleType && (
                      <span className="text-muted-foreground">{drift.ruleKey}</span>
                    )}
                  </span>
                  <Link
                    to={`${adminBase}/content/${intent.collection}/${drift.itemId}` as never}
                    className="text-primary hover:underline"
                  >
                    Open item →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export function IntentDetailPage() {
  const params = useParams({ strict: false }) as { intentId?: string };
  return (
    <MissionControlLayout>
      <IntentDetailBody intentId={params.intentId ?? ''} />
    </MissionControlLayout>
  );
}
