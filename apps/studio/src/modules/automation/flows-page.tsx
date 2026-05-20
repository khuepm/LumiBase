/**
 * Automation → Flows list page (POST-GA3).
 *
 * Minimal scaffolding: shows registered flows, status, trigger type and
 * a "Run" button for manual flows. Editor (graph designer) is left out
 * of this initial scaffold — the API surface and storage exist so a later
 * task can build on top.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Play, Workflow } from 'lucide-react';
import { getActiveSite, getActiveToken } from '@/lib/api';

interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'draft';
  triggerType: 'webhook' | 'event' | 'schedule' | 'manual';
}

function flowsApi(path: string, init?: RequestInit) {
  return fetch(`/api/v1/flows${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getActiveToken()}`,
      'X-Lumi-Site': getActiveSite(),
      ...(init?.headers ?? {}),
    },
  }).then((r) => {
    if (!r.ok) throw new Error(`Flows API error: ${r.status}`);
    return r.json();
  });
}

export function FlowsListPage() {
  const qc = useQueryClient();
  const flowsQuery = useQuery({
    queryKey: ['flows'],
    queryFn: async () => (await flowsApi('')).data as FlowRow[],
  });

  const runMutation = useMutation({
    mutationFn: (id: string) => flowsApi(`/${id}/run`, { method: 'POST', body: '{}' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['flows'] }),
  });

  const flows = flowsQuery.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Flows</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Automate work with multi-step operations triggered by events,
            webhooks, schedules or manual runs.
          </p>
        </div>
      </header>

      <div className="grid gap-3">
        {flowsQuery.isLoading && <div className="text-muted-foreground">Loading flows…</div>}
        {!flowsQuery.isLoading && flows.length === 0 && (
          <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
            No flows yet. Create one with the API: POST /api/v1/flows.
          </div>
        )}
        {flows.map((flow) => (
          <div
            key={flow.id}
            className="flex items-center justify-between rounded-lg border bg-background p-4 shadow-sm"
          >
            <div className="flex items-start gap-4">
              <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-lg bg-violet-100 text-violet-600">
                <Workflow className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold">{flow.name}</h3>
                {flow.description && (
                  <p className="text-sm text-muted-foreground">{flow.description}</p>
                )}
                <div className="mt-2 flex gap-2 text-xs">
                  <span
                    className={`inline-flex rounded px-2 py-0.5 font-medium ${flow.status === 'active'
                        ? 'bg-emerald-100 text-emerald-800'
                        : flow.status === 'draft'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-muted text-muted-foreground'
                      }`}
                  >
                    {flow.status}
                  </span>
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Activity className="h-3 w-3" />
                    trigger: {flow.triggerType}
                  </span>
                </div>
              </div>
            </div>
            {flow.triggerType === 'manual' && flow.status === 'active' && (
              <button
                type="button"
                disabled={runMutation.isPending}
                onClick={() => runMutation.mutate(flow.id)}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                <Play className="h-4 w-4" /> Run
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
