import { useQuery } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { getActiveToken, getActiveSite } from '@/lib/api';

/**
 * Run history panel (visual-flow-builder Req 6).
 *
 * Lists a flow's recent runs and, on selection, loads the run detail —
 * input, per-node steps, error — and reports the steps up to the editor so
 * the canvas can highlight the executed path.
 */

export interface FlowRunSummary {
  id: string;
  status: 'pending' | 'running' | 'success' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface FlowRunDetail extends FlowRunSummary {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
  output: Record<string, unknown>;
}

function runsApi<T>(path: string): Promise<T> {
  return fetch(`/api/v1/flows${path}`, {
    headers: {
      Authorization: `Bearer ${getActiveToken()}`,
      'X-Lumi-Site': getActiveSite(),
    },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`Flows API error: ${r.status}`);
    return ((await r.json()) as { data: T }).data;
  });
}

/** What an `ai:decision` node stores in its step (J10, #517). */
export interface DecisionStep {
  branch: string;
  runId: string | null;
  replayed?: boolean;
  decision: {
    profileKey: string;
    profileVersion: number;
    questionKey: string;
    questionType: 'noul' | 'choice';
    value: number | string;
    confidence: number | null;
    threshold: number;
    unknownReason: string | null;
    provider: string | null;
    model: string | null;
    calibrated: boolean | null;
  } | null;
  errorCode?: string;
  message?: string;
}

/** Steps written by `ai:decision` nodes: a branch plus a decision (or an error code). */
export function decisionSteps(steps: Record<string, unknown> | undefined): Array<[string, DecisionStep]> {
  const out: Array<[string, DecisionStep]> = [];
  for (const [nodeId, value] of Object.entries(steps ?? {})) {
    if (nodeId === 'previous' || !value || typeof value !== 'object') continue;
    const step = value as Partial<DecisionStep>;
    if (typeof step.branch === 'string' && 'decision' in step) out.push([nodeId, step as DecisionStep]);
  }
  return out;
}

const UNKNOWN_REASON: Record<string, string> = {
  between_thresholds: 'probability between the thresholds',
  abstained: 'the model abstained',
  low_confidence: 'confidence below the minimum',
  stale: 'the content changed since the stored decision',
};

function DecisionRow({ nodeId, step }: { nodeId: string; step: DecisionStep }) {
  const d = step.decision;
  const tone =
    step.branch === 'error'
      ? 'border-rose-500/30 bg-rose-500/5'
      : step.branch === 'unknown'
        ? 'border-amber-500/40 bg-amber-500/10'
        : 'border-emerald-500/30 bg-emerald-500/5';
  return (
    <li className={`space-y-0.5 rounded-md border p-2 text-[10px] ${tone}`} data-testid={`decision-${nodeId}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono">{nodeId}</span>
        <span className="font-semibold">
          Branch taken: <span className="font-mono">{step.branch}</span>
        </span>
      </div>
      {step.branch === 'unknown' && (
        <p className="font-medium text-amber-700 dark:text-amber-400">
          Unknown — no decision was taken
          {d?.unknownReason ? ` (${UNKNOWN_REASON[d.unknownReason] ?? d.unknownReason})` : ''}.
        </p>
      )}
      {step.branch === 'error' && (
        <p className="font-medium text-rose-600">
          Decision failed{step.errorCode ? `: ${step.errorCode}` : ''}. The error branch ran; nothing was treated as approved.
        </p>
      )}
      {d && (
        <p className="text-muted-foreground">
          {d.profileKey}@v{d.profileVersion} · {d.questionKey} = <span className="font-mono">{String(d.value)}</span>
          {d.confidence !== null ? ` · confidence ${d.confidence.toFixed(2)}` : ''} · threshold {d.threshold}
          {d.model ? ` · ${d.provider ?? ''}/${d.model}` : ''}
          {d.calibrated === false ? ' · uncalibrated' : ''}
        </p>
      )}
      {step.runId && (
        <p className="font-mono text-muted-foreground">
          review run {step.runId}
          {step.replayed ? ' (replayed, no new provider call)' : ''}
        </p>
      )}
    </li>
  );
}

function durationLabel(run: FlowRunSummary): string {
  if (!run.finishedAt) return '—';
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function StatusIcon({ status }: { status: FlowRunSummary['status'] }) {
  if (status === 'success') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
  if (status === 'error') return <XCircle className="h-3.5 w-3.5 text-rose-500" />;
  if (status === 'running' || status === 'pending')
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
  return <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />;
}

export function RunHistoryPanel({
  flowId,
  onRunSelected,
}: {
  flowId: string;
  /** Reports the selected run so the canvas can highlight executed nodes. */
  onRunSelected?: (run: FlowRunDetail | null) => void;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ['flow-runs', flowId],
    queryFn: () => runsApi<FlowRunSummary[]>(`/${flowId}/runs`),
    refetchInterval: (query) => {
      const data = query.state.data;
      const active = data?.some((r) => r.status === 'pending' || r.status === 'running');
      return active ? 2000 : false;
    },
  });

  const detailQuery = useQuery({
    queryKey: ['flow-run-detail', flowId, selectedRunId],
    enabled: selectedRunId !== null,
    queryFn: async () => {
      const run = await runsApi<FlowRunDetail>(`/${flowId}/runs/${selectedRunId}`);
      onRunSelected?.(run);
      return run;
    },
  });

  const runs = runsQuery.data ?? [];
  const detail = detailQuery.data ?? null;

  return (
    <div className="space-y-3" data-testid="run-history">
      <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Run history</h3>
      {runsQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading runs…</p>
      ) : runsQuery.isError ? (
        <p className="text-xs text-destructive">Failed to load runs.</p>
      ) : runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No runs yet — trigger the flow to see history here.</p>
      ) : (
        <ul className="space-y-1">
          {runs.map((run) => (
            <li key={run.id}>
              <button
                type="button"
                onClick={() => {
                  const next = selectedRunId === run.id ? null : run.id;
                  setSelectedRunId(next);
                  if (next === null) onRunSelected?.(null);
                }}
                className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent ${selectedRunId === run.id ? 'border-primary bg-accent' : ''
                  }`}
              >
                <StatusIcon status={run.status} />
                <span className="flex-1 truncate">{new Date(run.startedAt).toLocaleString()}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{durationLabel(run)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {detail && (
        <div className="space-y-2 border-t pt-2" data-testid="run-detail">
          <div className="flex items-center gap-2 text-xs">
            <StatusIcon status={detail.status} />
            <span className="font-medium">{detail.status}</span>
          </div>
          {detail.error && (
            <pre className="overflow-x-auto rounded-md border border-rose-500/30 bg-rose-500/5 p-2 font-mono text-[10px] text-rose-600">
              {detail.error}
            </pre>
          )}
          {decisionSteps(detail.steps).length > 0 && (
            <div>
              <span className="text-[10px] font-medium uppercase text-muted-foreground">Decisions</span>
              <ul className="mt-1 space-y-1">
                {decisionSteps(detail.steps).map(([nodeId, step]) => (
                  <DecisionRow key={nodeId} nodeId={nodeId} step={step} />
                ))}
              </ul>
            </div>
          )}
          <div>
            <span className="text-[10px] font-medium uppercase text-muted-foreground">Input</span>
            <pre className="mt-1 max-h-32 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[10px]">
              {JSON.stringify(detail.input, null, 2)}
            </pre>
          </div>
          <div>
            <span className="text-[10px] font-medium uppercase text-muted-foreground">
              Steps ({Object.keys(detail.steps ?? {}).length})
            </span>
            <pre className="mt-1 max-h-48 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[10px]">
              {JSON.stringify(detail.steps, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
