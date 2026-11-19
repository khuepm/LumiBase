import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { experimentsApi, type Experiment, type ExperimentReportResponse } from './api';

/**
 * Insights → Experiments (#763): the A/B experiment report. Per arm:
 * exposures, conversions, rate, uplift and significance against control, plus
 * the recommended winner. Promotion is only ever *requested* here — it parks
 * an approval that a reviewer decides in the approvals inbox.
 */

function useInsightsBase(): string {
  const params = useParams({ strict: false }) as { adminPath?: string };
  return params.adminPath ? `/${params.adminPath}/insights` : '/insights';
}

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);

const STATUS_CLASS: Record<Experiment['status'], string> = {
  draft: 'bg-muted text-muted-foreground',
  running: 'bg-primary/10 text-primary',
  stopped: 'bg-muted text-foreground',
  completed: 'bg-muted text-muted-foreground',
};

function ReportView({ data, onChanged }: { data: ExperimentReportResponse; onChanged: () => void }) {
  const { experiment, report } = data;
  const [requested, setRequested] = useState<string | null>(null);
  const promote = useMutation({
    mutationFn: (arm: string) => experimentsApi.requestPromotion(experiment.id, arm, report.recommendation?.reason),
    onSuccess: (res) => {
      setRequested(res.approvalId ?? res.status);
      onChanged();
    },
  });
  const toggle = useMutation({
    mutationFn: () => (experiment.status === 'running' ? experimentsApi.stop(experiment.id) : experimentsApi.start(experiment.id)),
    onSuccess: onChanged,
  });
  const canPromote = experiment.status === 'running' || experiment.status === 'stopped';

  return (
    <section className="space-y-4 rounded-lg border bg-background p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-medium">{experiment.name}</h2>
          <p className="text-xs text-muted-foreground">
            {experiment.subjectType} · goal <code>{experiment.goal}</code> · min. {experiment.minSampleSize} exposures per arm
          </p>
          {experiment.hypothesis && <p className="mt-1 text-sm">{experiment.hypothesis}</p>}
        </div>
        {(experiment.status === 'running' || experiment.status === 'draft' || experiment.status === 'stopped') && (
          <button
            type="button"
            onClick={() => toggle.mutate()}
            disabled={toggle.isPending}
            className="rounded-md border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
          >
            {experiment.status === 'running' ? 'Stop' : 'Start'}
          </button>
        )}
      </header>
      {toggle.isError && <p className="text-xs text-destructive">{(toggle.error as Error).message}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-start text-xs text-muted-foreground">
              <th className="py-1 pe-3 text-start font-normal">Arm</th>
              <th className="py-1 pe-3 text-end font-normal">Exposures</th>
              <th className="py-1 pe-3 text-end font-normal">Conversions</th>
              <th className="py-1 pe-3 text-end font-normal">Rate</th>
              <th className="py-1 pe-3 text-end font-normal">Uplift</th>
              <th className="py-1 pe-3 text-end font-normal">p-value</th>
              <th className="py-1 text-end font-normal" />
            </tr>
          </thead>
          <tbody>
            {report.arms.map((arm) => (
              <tr key={arm.key} className="border-b last:border-b-0">
                <td className="py-1.5 pe-3">
                  <span className="font-medium">{arm.key}</span>
                  {experiment.winnerArm === arm.key && <span className="ms-2 rounded bg-primary/10 px-1.5 text-xs text-primary">winner</span>}
                  {arm.significant && <span className="ms-2 text-xs text-primary">significant</span>}
                </td>
                <td className="py-1.5 pe-3 text-end tabular-nums">{arm.exposures}</td>
                <td className="py-1.5 pe-3 text-end tabular-nums">{arm.conversions}</td>
                <td className="py-1.5 pe-3 text-end tabular-nums">{pct(arm.rate)}</td>
                <td className="py-1.5 pe-3 text-end tabular-nums">{pct(arm.uplift)}</td>
                <td className="py-1.5 pe-3 text-end tabular-nums">{arm.pValue === null ? '—' : arm.pValue}</td>
                <td className="py-1.5 text-end">
                  {canPromote && (
                    <button
                      type="button"
                      onClick={() => promote.mutate(arm.key)}
                      disabled={promote.isPending}
                      className="text-xs text-primary hover:underline disabled:opacity-50"
                    >
                      Request promotion
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-md bg-muted/50 p-3 text-sm">
        {report.recommendation ? (
          <p>
            <span className="font-medium">Recommended: {report.recommendation.arm}.</span> {report.recommendation.reason}
          </p>
        ) : (
          <p className="text-muted-foreground">
            {report.sampleReached
              ? 'No arm differs significantly from control yet.'
              : 'Not enough data yet: every arm needs the minimum number of exposures.'}
          </p>
        )}
      </div>
      {requested && <p className="text-sm">Promotion requested — it waits for approval in the approvals inbox.</p>}
      {promote.isError && <p className="text-xs text-destructive">{(promote.error as Error).message}</p>}
    </section>
  );
}

export function ExperimentsPage() {
  const base = useInsightsBase();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['insights-experiments'], queryFn: experimentsApi.list });
  const current = selected ?? list.data?.[0]?.id ?? null;
  const report = useQuery({
    queryKey: ['insights-experiment-report', current],
    queryFn: () => experimentsApi.report(current!),
    enabled: Boolean(current),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['insights-experiments'] });
    void queryClient.invalidateQueries({ queryKey: ['insights-experiment-report', current] });
  };

  return (
    <div className="space-y-4 p-6">
      <header>
        <Link to={base as never} className="text-xs text-muted-foreground hover:underline">
          ← Insights
        </Link>
        <h1 className="text-xl font-semibold">Experiments</h1>
        <p className="text-sm text-muted-foreground">A/B tests on pages and items. A winner is promoted only after approval.</p>
      </header>

      {list.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading experiments…</p>
      ) : (list.data ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No experiments yet. Create one with <code>POST /api/v1/experiments</code> or ask the agent.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <ul className="space-y-1">
            {(list.data ?? []).map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => setSelected(e.id)}
                  className={`w-full rounded-md border px-3 py-2 text-start text-sm hover:border-primary ${e.id === current ? 'border-primary' : ''}`}
                >
                  <span className="block font-medium">{e.name}</span>
                  <span className={`mt-1 inline-block rounded px-1.5 text-xs ${STATUS_CLASS[e.status]}`}>{e.status}</span>
                </button>
              </li>
            ))}
          </ul>
          {report.data ? (
            <ReportView data={report.data} onChanged={refresh} />
          ) : report.isError ? (
            <p className="text-sm text-destructive">{(report.error as Error).message}</p>
          ) : (
            <p className="text-sm text-muted-foreground">Loading report…</p>
          )}
        </div>
      )}
    </div>
  );
}
