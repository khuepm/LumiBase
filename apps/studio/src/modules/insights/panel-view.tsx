import { useQuery } from '@tanstack/react-query';
import type { PanelResult, PanelType } from '@lumibase/shared';
import { cn } from '@/lib/cn';
import { insightsApi, type Panel } from './api';

/**
 * Renders a single panel: runs its query, shows loading/empty/error, then
 * draws the result per type. Charts use inline SVG/CSS bars (no chart library
 * dependency). Errors are isolated — a failing panel never blanks the board.
 * See `.kiro/specs/insights-dashboard` Req 8.
 */

export function PanelView({ panel, refetchMs }: { panel: Panel; refetchMs?: number }) {
  const query = useQuery({
    queryKey: ['panel-data', panel.id, refetchMs],
    queryFn: () => insightsApi.runPanel(panel.dashboardId, panel.id),
    refetchInterval: refetchMs && refetchMs > 0 ? refetchMs : false,
  });

  return (
    <div className="flex h-full flex-col rounded-lg border bg-background p-3">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium">{panel.name}</h3>
        {query.data && <Freshness executedAt={query.data.meta.executedAt} />}
      </header>
      <div className="flex-1">
        {query.isLoading ? (
          <PanelSkeleton />
        ) : query.isError ? (
          <PanelError message={(query.error as Error).message} />
        ) : (
          <PanelBody type={panel.type} result={query.data!} />
        )}
      </div>
    </div>
  );
}

function PanelBody({ type, result }: { type: PanelType; result: PanelResult }) {
  const { data } = result;
  if (type === 'metric') {
    if (data.value === undefined) return <Empty />;
    return <div className="flex h-full items-center justify-center text-4xl font-semibold tabular-nums">{formatNumber(data.value)}</div>;
  }
  const series = data.series ?? [];
  if ((type === 'bar' || type === 'timeSeries' || type === 'pie') && series.length === 0) return <Empty />;
  if (type === 'bar' || type === 'timeSeries') return <BarChart series={series} />;
  if (type === 'pie') return <PieList series={series} />;
  // list / table
  const rows = data.rows ?? series.map((s) => ({ label: s.label, value: s.value }));
  if (rows.length === 0) return <Empty />;
  return <TableView rows={rows} />;
}

function BarChart({ series }: { series: { label: string; value: number }[] }) {
  const max = Math.max(...series.map((s) => s.value), 1);
  return (
    <div className="space-y-1.5">
      {series.map((s) => (
        <div key={s.label} className="flex items-center gap-2 text-xs">
          <span className="w-24 truncate text-muted-foreground" title={s.label}>{s.label}</span>
          <span className="h-3 flex-1 overflow-hidden rounded bg-muted">
            <span className="block h-full rounded bg-primary" style={{ width: `${(s.value / max) * 100}%` }} />
          </span>
          <span className="w-12 text-right tabular-nums">{formatNumber(s.value)}</span>
        </div>
      ))}
    </div>
  );
}

function PieList({ series }: { series: { label: string; value: number }[] }) {
  const total = series.reduce((a, b) => a + b.value, 0) || 1;
  const palette = ['bg-emerald-500', 'bg-blue-500', 'bg-amber-500', 'bg-violet-500', 'bg-rose-500', 'bg-cyan-500'];
  return (
    <ul className="space-y-1 text-xs">
      {series.map((s, i) => (
        <li key={s.label} className="flex items-center gap-2">
          <span className={cn('h-3 w-3 rounded-sm', palette[i % palette.length])} />
          <span className="flex-1 truncate" title={s.label}>{s.label}</span>
          <span className="tabular-nums text-muted-foreground">{Math.round((s.value / total) * 100)}%</span>
          <span className="w-12 text-right tabular-nums">{formatNumber(s.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function TableView({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b text-left uppercase text-muted-foreground">
          {cols.map((col) => (
            <th key={col} className="py-1">{col}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b last:border-0">
            {cols.map((col) => (
              <td key={col} className="py-1">{String(row[col] ?? '')}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PanelSkeleton() {
  return <div className="h-full min-h-16 animate-pulse rounded bg-muted/50" />;
}

function PanelError({ message }: { message: string }) {
  return <p className="text-xs text-destructive">⚠ {message}</p>;
}

function Empty() {
  return <p className="flex h-full items-center justify-center text-xs text-muted-foreground">No data</p>;
}

function Freshness({ executedAt }: { executedAt: string }) {
  const secs = Math.max(0, Math.round((Date.now() - new Date(executedAt).getTime()) / 1000));
  return <span className="text-[10px] text-muted-foreground">updated {secs}s ago</span>;
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
