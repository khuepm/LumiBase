import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AlertCircle, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { getActiveSite, getActiveToken } from '@/lib/api';

/**
 * Flow run history (visual-flow-builder Req 6.1, 6.2). Lists a flow's recent
 * runs (status / startedAt / duration); selecting one loads its detail
 * (`GET /:id/runs/:runId`) and shows the input plus per-node step outputs.
 */

interface RunRow {
  id: string;
  status: 'pending' | 'running' | 'success' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

interface RunDetail extends RunRow {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
}

async function runsApi<T>(path: string): Promise<T> {
  const res = await fetch(`/api/v1/flows${path}`, {
    headers: {
      ...(getActiveToken() ? { Authorization: `Bearer ${getActiveToken()}` } : {}),
      ...(getActiveSite() ? { 'X-Lumi-Site': getActiveSite() } : {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T };
  return body.data as T;
}

function StatusIcon({ status }: { status: RunRow['status'] }) {
  if (status === 'success') return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === 'error') return <AlertCircle className="h-4 w-4 text-destructive" />;
  if (status === 'running' || status === 'pending') return <Loader2 className="h-4 w-4 animate-spin text-amber-500" />;
  return <Clock className="h-4 w-4 text-muted-foreground" />;
}

function duration(run: RunRow): string {
  if (!run.finishedAt) return '—';
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function RunHistoryPanel({ flowId }: { flowId: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ['flow-runs', flowId],
    queryFn: () => runsApi<RunRow[]>(`/${flowId}/runs`),
    refetchInterval: 5000,
  });

  const detailQuery = useQuery({
    queryKey: ['flow-run', flowId, selectedId],
    queryFn: () => runsApi<RunDetail>(`/${flowId}/runs/${selectedId}`),
    enabled: !!selectedId,
  });

  const runs = runsQuery.data ?? [];

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-[16rem_1fr]">
      <ul className="max-h-96 divide-y overflow-auto rounded-md border">
        {runs.length === 0 && <li className="p-3 text-sm text-muted-foreground">No runs yet.</li>}
        {runs.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => setSelectedId(run.id)}
              className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted ${
                run.id === selectedId ? 'bg-muted' : ''
              }`}
            >
              <span className="flex items-center gap-2">
                <StatusIcon status={run.status} />
                <span className="font-mono text-xs">{run.id.slice(0, 8)}</span>
              </span>
              <span className="text-xs text-muted-foreground">{duration(run)}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="rounded-md border p-3">
        {!selectedId && <p className="text-sm text-muted-foreground">Select a run to see its steps.</p>}
        {selectedId && detailQuery.isLoading && <p className="text-sm text-muted-foreground">Loading run…</p>}
        {detailQuery.data && (
          <div className="space-y-3 text-sm">
            <div>
              <h4 className="mb-1 font-medium">Input</h4>
              <pre className="overflow-auto rounded bg-muted/40 p-2 text-xs">
                {JSON.stringify(detailQuery.data.input, null, 2)}
              </pre>
            </div>
            {detailQuery.data.error && (
              <p className="rounded bg-destructive/10 p-2 text-xs text-destructive">{detailQuery.data.error}</p>
            )}
            <div>
              <h4 className="mb-1 font-medium">Steps</h4>
              <div className="space-y-1">
                {Object.entries(detailQuery.data.steps ?? {})
                  .filter(([nodeId]) => nodeId !== 'previous')
                  .map(([nodeId, out]) => (
                    <div key={nodeId} className="rounded border p-2">
                      <span className="font-mono text-xs text-muted-foreground">{nodeId}</span>
                      <pre className="mt-1 overflow-auto text-xs">{JSON.stringify(out, null, 2)}</pre>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
