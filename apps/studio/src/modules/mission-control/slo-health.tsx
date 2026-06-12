import { useQueries, useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { missionControlApi } from './api';

/**
 * SLO health per collection (content-os task 17.2; Req 16.3).
 * Health = share of an intent's detected drifts that are resolved. A
 * collection with open drifts is out of SLO; no drifts means healthy.
 */
export function SloHealth() {
  const intentsQuery = useQuery({ queryKey: ['mc-intents'], queryFn: missionControlApi.intents });
  const intents = intentsQuery.data ?? [];

  const driftQueries = useQueries({
    queries: intents.map((intent) => ({
      queryKey: ['mc-drifts', intent.id],
      queryFn: () => missionControlApi.drifts(intent.id),
      enabled: intents.length > 0,
    })),
  });

  if (intentsQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading SLO health…</p>;
  }
  if (intents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No content intents yet — compose one to start measuring SLO health.
      </p>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-xs uppercase text-muted-foreground">
          <th className="py-2">Intent</th>
          <th>Collection</th>
          <th>Status</th>
          <th>Open drifts</th>
          <th>Health</th>
        </tr>
      </thead>
      <tbody>
        {intents.map((intent, i) => {
          const drifts = driftQueries[i]?.data ?? [];
          const open = drifts.filter((d) => d.status === 'open' || d.status === 'assigned').length;
          const total = drifts.length;
          const health = total === 0 ? 100 : Math.round(((total - open) / total) * 100);
          return (
            <tr key={intent.id} className="border-b last:border-0">
              <td className="py-2 font-medium">{intent.name}</td>
              <td>
                <code className="rounded bg-muted px-1 text-xs">{intent.collection}</code>
              </td>
              <td>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs',
                    intent.status === 'active' && 'bg-emerald-100 text-emerald-800',
                    intent.status === 'paused' && 'bg-muted text-muted-foreground',
                    intent.status === 'error' && 'bg-destructive/10 text-destructive',
                  )}
                >
                  {intent.status}
                </span>
              </td>
              <td>{open}</td>
              <td>
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                    <span
                      className={cn(
                        'block h-full rounded-full',
                        health >= 90 ? 'bg-emerald-500' : health >= 60 ? 'bg-amber-500' : 'bg-destructive',
                      )}
                      style={{ width: `${health}%` }}
                    />
                  </span>
                  <span className="text-xs">{health}%</span>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
