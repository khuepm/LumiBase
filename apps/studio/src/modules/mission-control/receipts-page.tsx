import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { cn } from '@/lib/cn';
import {
  missionControlApi,
  type AgentReceipts,
  type AgentReceiptsAlertThresholds,
  type AgentReceiptsExportKind,
} from './api';
import { MissionControlLayout } from './layout';

/**
 * Agent receipts (#713): what agents did, what humans had to decide, what it
 * cost and where it drifted — read-only, from the trust ledger and audit
 * tables. Window presets, KPI tiles, threshold alerts, breakdown tables, CSV
 * export and the alert-threshold editor.
 */

const PRESETS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

const EXPORTS: Array<{ kind: AgentReceiptsExportKind; label: string }> = [
  { kind: 'runs', label: 'Runs' },
  { kind: 'tool_calls', label: 'Tool calls' },
  { kind: 'approvals', label: 'Approvals' },
];

const THRESHOLD_FIELDS: Array<{ key: keyof AgentReceiptsAlertThresholds; label: string; hint: string; step: string }> = [
  { key: 'maxRunFailureRate', label: 'Run failure rate', hint: '0–1', step: '0.01' },
  { key: 'maxVetoRate', label: 'Veto rate', hint: '0–1', step: '0.01' },
  { key: 'maxOverrideRate', label: 'Human override rate', hint: '0–1', step: '0.01' },
  { key: 'maxApprovalLatencyP90Minutes', label: 'Approval latency p90', hint: 'minutes', step: '1' },
  { key: 'maxCostUsd', label: 'Cost', hint: 'USD', step: '0.01' },
  { key: 'maxTokens', label: 'Tokens', hint: 'count', step: '1' },
  { key: 'maxOpenDrift', label: 'Open drift', hint: 'count', step: '1' },
  { key: 'maxIncidents', label: 'Incidents', hint: 'count', step: '1' },
];

const INTEGER_THRESHOLDS = new Set<keyof AgentReceiptsAlertThresholds>(['maxTokens', 'maxOpenDrift', 'maxIncidents']);

function windowFor(days: number, now = new Date()): { since: string; until: string } {
  return { since: new Date(now.getTime() - days * 86_400_000).toISOString(), until: now.toISOString() };
}

const pct = (value: number | null) => (value === null ? '—' : `${Math.round(value * 1000) / 10}%`);
const minutes = (value: number | null) => (value === null ? '—' : value < 120 ? `${Math.round(value)} min` : `${Math.round(value / 6) / 10} h`);
const usd = (value: number) => `$${value.toFixed(value < 1 ? 4 : 2)}`;
const count = (value: number) => value.toLocaleString();

function Tile({ label, value, sub, alert }: { label: string; value: string; sub?: string; alert?: boolean }) {
  return (
    <div className={cn('rounded-lg border bg-background p-3', alert && 'border-destructive/50')}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('text-xl font-semibold tabular-nums', alert && 'text-destructive')}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Breakdown({ title, rows, empty }: { title: string; rows: Array<[string, string]>; empty: string }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <dl className="space-y-1 text-sm">
          {rows.map(([key, value]) => (
            <div key={key} className="flex justify-between gap-2">
              <dt className="truncate text-muted-foreground">{key}</dt>
              <dd className="tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function DailyBars({ daily }: { daily: AgentReceipts['daily'] }) {
  const max = Math.max(1, ...daily.map((day) => day.runs));
  if (daily.length === 0) return <p className="text-sm text-muted-foreground">No agent activity in this window.</p>;
  return (
    <div className="flex h-28 items-end gap-1" role="img" aria-label="Runs per day">
      {daily.map((day) => (
        <div key={day.date} className="flex flex-1 flex-col justify-end" title={`${day.date}: ${day.runs} runs, ${day.failed} failed`}>
          <div className="bg-destructive/70" style={{ height: `${(day.failed / max) * 100}%` }} />
          <div className="bg-primary/70" style={{ height: `${((day.runs - day.failed) / max) * 100}%` }} />
        </div>
      ))}
    </div>
  );
}

function ThresholdEditor({ initial, onSaved }: { initial: AgentReceiptsAlertThresholds; onSaved: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(THRESHOLD_FIELDS.map(({ key }) => [key, initial[key] === undefined ? '' : String(initial[key])])),
  );
  const save = useMutation({
    mutationFn: (thresholds: AgentReceiptsAlertThresholds) => missionControlApi.setReceiptAlerts(thresholds),
    onSuccess: onSaved,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const thresholds: AgentReceiptsAlertThresholds = {};
    for (const { key } of THRESHOLD_FIELDS) {
      const raw = draft[key]?.trim();
      if (!raw) continue;
      const value = Number(raw);
      thresholds[key] = INTEGER_THRESHOLDS.has(key) ? Math.round(value) : value;
    }
    save.mutate(thresholds);
  };
  return (
    <form onSubmit={submit} noValidate className="space-y-3" aria-label="Alert thresholds">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {THRESHOLD_FIELDS.map(({ key, label, hint, step }) => (
          <label key={key} className="space-y-1 text-sm">
            <span className="block text-muted-foreground">
              {label} <span className="text-xs">({hint})</span>
            </span>
            <input
              type="number"
              min="0"
              step={step}
              value={draft[key] ?? ''}
              onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
              placeholder="off"
              className="w-full rounded-md border bg-background px-2 py-1"
              aria-label={label}
            />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Save thresholds
        </button>
        {save.isError && <span role="alert" className="text-sm text-destructive">{(save.error as Error).message}</span>}
        {save.isSuccess && <span className="text-sm text-muted-foreground">Saved.</span>}
      </div>
      <p className="text-xs text-muted-foreground">Empty means the metric is not checked. Alerts are evaluated when the report is read.</p>
    </form>
  );
}

export function ReceiptsPage() {
  const queryClient = useQueryClient();
  const [days, setDays] = useState<number>(30);
  // Recomputed only when the preset changes, so the query key is stable.
  const range = useMemo(() => windowFor(days), [days]);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);

  const receipts = useQuery({
    queryKey: ['mc-receipts', range.since, range.until],
    queryFn: () => missionControlApi.receipts(range),
  });
  const thresholds = useQuery({ queryKey: ['mc-receipt-alerts'], queryFn: () => missionControlApi.receiptAlerts() });

  const download = async (kind: AgentReceiptsExportKind) => {
    setExportError(null);
    setExportNote(null);
    try {
      const { blob, truncated } = await missionControlApi.exportReceipts(kind, range);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `agent-receipts-${kind}-${range.since.slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      if (truncated) setExportNote('The export was truncated at 10,000 rows; narrow the window for the rest.');
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    }
  };

  const data = receipts.data;
  const alerting = new Set(data?.alerts.map((alert) => alert.metric) ?? []);

  return (
    <MissionControlLayout>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1" role="group" aria-label="Window">
            {PRESETS.map((preset) => (
              <button
                key={preset.days}
                type="button"
                aria-pressed={days === preset.days}
                onClick={() => setDays(preset.days)}
                className={cn(
                  'rounded-md border px-3 py-1 text-sm',
                  days === preset.days ? 'bg-muted font-medium' : 'text-muted-foreground',
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Export CSV:</span>
            {EXPORTS.map((entry) => (
              <button
                key={entry.kind}
                type="button"
                onClick={() => void download(entry.kind)}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
              >
                <Download className="h-3.5 w-3.5" /> {entry.label}
              </button>
            ))}
          </div>
        </div>
        {exportError && <p role="alert" className="text-sm text-destructive">{exportError}</p>}
        {exportNote && <p className="text-sm text-muted-foreground">{exportNote}</p>}

        {receipts.isLoading && <p className="text-sm text-muted-foreground">Loading receipts…</p>}
        {receipts.isError && (
          <p role="alert" className="text-sm text-destructive">
            {(receipts.error as Error).message}
          </p>
        )}

        {data && (
          <>
            {data.alerts.length > 0 && (
              <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                <h2 className="mb-1 inline-flex items-center gap-2 text-sm font-semibold text-destructive">
                  <AlertTriangle className="h-4 w-4" /> {data.alerts.length} threshold{data.alerts.length === 1 ? '' : 's'} crossed
                </h2>
                <ul className="list-disc pl-5 text-sm">
                  {data.alerts.map((alert) => (
                    <li key={alert.metric}>{alert.message}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Tile label="Runs" value={count(data.runs.total)} sub={`${count(data.toolCalls.total)} tool calls`} />
              <Tile label="Run failure rate" value={pct(data.runs.failureRate)} alert={alerting.has('maxRunFailureRate')} />
              <Tile
                label="Approval latency"
                value={minutes(data.approvals.latency.p50Minutes)}
                sub={`p90 ${minutes(data.approvals.latency.p90Minutes)} · ${data.approvals.latency.count} decided`}
                alert={alerting.has('maxApprovalLatencyP90Minutes')}
              />
              <Tile
                label="Human overrides"
                value={pct(data.overrides.overrideRate)}
                sub={`${data.overrides.rejectedApprovals} rejected · ${data.overrides.vetoed} vetoed`}
                alert={alerting.has('maxOverrideRate')}
              />
              <Tile label="Veto rate" value={pct(data.vetoes.vetoRate)} sub={`${data.vetoes.total} veto windows`} alert={alerting.has('maxVetoRate')} />
              <Tile
                label="Cost"
                value={usd(data.cost.usd)}
                sub={`${count(data.cost.tokens)} tokens`}
                alert={alerting.has('maxCostUsd') || alerting.has('maxTokens')}
              />
              <Tile label="Open drift" value={count(data.drift.openNow)} sub={`${data.drift.opened} opened · ${data.drift.resolved} resolved`} alert={alerting.has('maxOpenDrift')} />
              <Tile label="Incidents" value={count(data.incidents.total)} sub={`${data.autonomy.demotions} with a capability`} alert={alerting.has('maxIncidents')} />
            </div>

            <div className="rounded-lg border bg-background p-3">
              <h3 className="mb-2 text-sm font-medium">Runs per day</h3>
              <DailyBars daily={data.daily} />
            </div>

            <div className="rounded-lg border bg-background p-3">
              <h3 className="mb-2 text-sm font-medium">Tool calls by skill and outcome</h3>
              {data.toolCalls.byTool.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tool calls in this window.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1">Skill</th>
                      <th>Calls</th>
                      <th>Outcomes</th>
                      <th>p50 latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.toolCalls.byTool.map((tool) => (
                      <tr key={tool.tool} className="border-t">
                        <td className="py-1 font-mono text-xs">{tool.tool}</td>
                        <td className="tabular-nums">{tool.total}</td>
                        <td className="text-xs">
                          {Object.entries(tool.byStatus)
                            .map(([status, n]) => `${status} ${n}`)
                            .join(' · ')}
                        </td>
                        <td className="tabular-nums">{tool.p50LatencyMs === null ? '—' : `${tool.p50LatencyMs} ms`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <Breakdown
                title="Runs by agent"
                empty="No runs."
                rows={data.runs.byAgent.map((agent) => [agent.agent, `${agent.total} (${agent.failed} failed)`])}
              />
              <Breakdown
                title="Cost by skill"
                empty="No recorded cost."
                rows={data.cost.byTool.map((tool) => [tool.tool, `${usd(tool.usd)} · ${count(tool.tokens)} tok`])}
              />
              <Breakdown
                title="Questions to humans"
                empty="No questions."
                rows={
                  data.questions.asked === 0
                    ? []
                    : [
                        ['Asked', String(data.questions.asked)],
                        ['Answered', String(data.questions.answered)],
                        ['Expired', String(data.questions.expired)],
                      ]
                }
              />
              <Breakdown title="Incidents by source" empty="No incidents." rows={Object.entries(data.incidents.bySource).map(([k, v]) => [k, String(v)])} />
              <Breakdown title="Drift by rule" empty="No drift opened." rows={data.drift.byRule.map((rule) => [rule.ruleType, String(rule.count)])} />
              <Breakdown
                title="Autonomy"
                empty="No autonomy grants."
                rows={[
                  ...Object.entries(data.autonomy.levelDistribution)
                    .filter(([, n]) => n > 0)
                    .map(([level, n]): [string, string] => [`${level} grants`, String(n)]),
                  ...data.autonomy.promotions.map((promotion): [string, string] => [
                    `${promotion.at.slice(0, 10)} ${promotion.agentRole}/${promotion.capability}`,
                    `→ L${promotion.toLevel ?? '?'}`,
                  ]),
                ]}
              />
            </div>
          </>
        )}

        <details className="rounded-lg border bg-background p-3">
          <summary className="cursor-pointer text-sm font-medium">Alert thresholds</summary>
          <div className="pt-3">
            {thresholds.data ? (
              <ThresholdEditor
                key={JSON.stringify(thresholds.data)}
                initial={thresholds.data}
                onSaved={() => {
                  void queryClient.invalidateQueries({ queryKey: ['mc-receipt-alerts'] });
                  void queryClient.invalidateQueries({ queryKey: ['mc-receipts'] });
                }}
              />
            ) : thresholds.isError ? (
              <p role="alert" className="text-sm text-destructive">{(thresholds.error as Error).message}</p>
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
          </div>
        </details>
      </div>
    </MissionControlLayout>
  );
}
