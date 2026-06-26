import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { insightsApi } from './api';

/**
 * Insights dashboard list (Req 5). Card grid + create form + empty state.
 * See `.kiro/specs/insights-dashboard`.
 */

/** Admin-base aware link prefix (mirrors mission-control's pattern). */
function useInsightsBase(): string {
  const params = useParams({ strict: false }) as { adminPath?: string };
  return params.adminPath ? `/${params.adminPath}/insights` : '/insights';
}

export function InsightsListPage() {
  const base = useInsightsBase();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const dashboardsQuery = useQuery({ queryKey: ['insights-dashboards'], queryFn: insightsApi.listDashboards });

  const createMutation = useMutation({
    mutationFn: () => insightsApi.createDashboard({ name: name.trim() }),
    onSuccess: () => {
      setName('');
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ['insights-dashboards'] });
    },
  });

  const dashboards = dashboardsQuery.data ?? [];

  return (
    <div className="space-y-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Insights</h1>
          <p className="text-sm text-muted-foreground">Dashboards built from your content.</p>
        </div>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
        >
          New dashboard
        </button>
      </header>

      {creating && (
        <form
          className="flex items-center gap-2 rounded-lg border bg-background p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) createMutation.mutate();
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Dashboard name"
            className="flex-1 rounded border px-2 py-1 text-sm"
          />
          <button type="submit" disabled={!name.trim() || createMutation.isPending} className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50">
            Create
          </button>
          {createMutation.isError && (
            <span className="text-xs text-destructive">{(createMutation.error as Error).message}</span>
          )}
        </form>
      )}

      {dashboardsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading dashboards…</p>
      ) : dashboards.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">No dashboards yet.</p>
          <button type="button" onClick={() => setCreating(true)} className="mt-2 text-sm text-primary hover:underline">
            Create your first dashboard
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {dashboards.map((d) => (
            <Link
              key={d.id}
              to={`${base}/${d.id}` as never}
              className="rounded-lg border bg-background p-4 transition hover:border-primary"
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">{d.icon ?? '📊'}</span>
                <span className="font-medium">{d.name}</span>
              </div>
              {d.note && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{d.note}</p>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
