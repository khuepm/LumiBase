import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { insightsApi } from './api';
import { PanelEditor } from './panel-editor';
import { PanelView } from './panel-view';

/**
 * Dashboard view (Req 6): renders panels on a simple grid, add-panel editor,
 * optional refetch interval, and delete. A CSS grid keeps this dependency-free;
 * positions are stored so a richer drag-grid can replace the layout later.
 * See `.kiro/specs/insights-dashboard`.
 */

function useInsightsBase(): string {
  const params = useParams({ strict: false }) as { adminPath?: string };
  return params.adminPath ? `/${params.adminPath}/insights` : '/insights';
}

const REFETCH_OPTIONS = [
  { label: 'Off', ms: 0 },
  { label: '30s', ms: 30_000 },
  { label: '60s', ms: 60_000 },
];

export function DashboardViewPage() {
  const base = useInsightsBase();
  const params = useParams({ strict: false }) as { dashboardId?: string };
  const dashboardId = params.dashboardId ?? '';
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [refetchMs, setRefetchMs] = useState(0);

  const dashboardQuery = useQuery({
    queryKey: ['insights-dashboard', dashboardId],
    queryFn: () => insightsApi.getDashboard(dashboardId),
    enabled: !!dashboardId,
  });
  const panelsQuery = useQuery({
    queryKey: ['insights-panels', dashboardId],
    queryFn: () => insightsApi.listPanels(dashboardId),
    enabled: !!dashboardId,
  });

  const deletePanelMutation = useMutation({
    mutationFn: (panelId: string) => insightsApi.deletePanel(dashboardId, panelId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['insights-panels', dashboardId] }),
  });

  if (dashboardQuery.isError) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Dashboard not found.</p>
        <Link to={base as never} className="text-sm text-primary hover:underline">← Back to Insights</Link>
      </div>
    );
  }

  const panels = panelsQuery.data ?? [];

  return (
    <div className="space-y-4 p-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link to={base as never} className="text-sm text-muted-foreground hover:underline">Insights</Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="text-xl font-semibold">{dashboardQuery.data?.name ?? '…'}</h1>
        </div>
        <div className="flex items-center gap-2">
          <select value={refetchMs} onChange={(e) => setRefetchMs(Number(e.target.value))} className="rounded border px-2 py-1 text-xs" title="Auto-refresh">
            {REFETCH_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>↻ {o.label}</option>
            ))}
          </select>
          <button type="button" onClick={() => setAdding((v) => !v)} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90">
            Add panel
          </button>
        </div>
      </header>

      {adding && <PanelEditor dashboardId={dashboardId} onClose={() => setAdding(false)} />}

      {panelsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading panels…</p>
      ) : panels.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No panels yet — add one to start visualizing your content.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {panels.map((panel) => (
            <div key={panel.id} className="group relative min-h-40">
              <button
                type="button"
                onClick={() => deletePanelMutation.mutate(panel.id)}
                className="absolute right-1 top-1 z-10 hidden rounded px-1 text-xs text-muted-foreground hover:text-destructive group-hover:block"
                title="Delete panel"
              >
                ✕
              </button>
              <PanelView panel={panel} refetchMs={refetchMs} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
