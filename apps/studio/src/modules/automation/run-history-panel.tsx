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
                className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent ${
                  selectedRunId === run.id ? 'border-primary bg-accent' : ''
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
