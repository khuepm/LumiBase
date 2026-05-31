import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Database, Plus, RefreshCw } from 'lucide-react';
import { listPipelines } from './api';
import { CONNECTOR_LABELS, STATUS_BADGE_CLASSES, formatTimestamp } from './presentation';

/**
 * CDC pipeline list — table view of every registered pipeline for the active
 * site (ClickHouse CDC — task 13.3; design "Studio CDC Panel" §6).
 *
 * Satisfies:
 *   - Req 6.1 — shows each pipeline's status, connector type, and last-sync
 *     timestamp;
 *   - Req 6.8 — when the registry can't be reached, shows an explicit
 *     "data unavailable" indication with a manual Retry button
 *     (`refetch()` from TanStack Query).
 *
 * Follows the existing studio list conventions (see `data-model/list.tsx` and
 * `settings/webhooks-page.tsx`): TanStack Query for fetching, Tailwind table
 * markup, and lucide-react icons.
 */
export function CdcPipelineListPage() {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['cdc', 'pipelines'],
    queryFn: listPipelines,
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">CDC pipelines</h1>
          <p className="text-sm text-muted-foreground">
            Replicate PostgreSQL changes into ClickHouse for analytics.
          </p>
        </div>
        <Link
          to="/cdc/new"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New pipeline
        </Link>
      </header>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading pipelines…</p>
      )}

      {/* Req 6.8 — registry unreachable: explicit indication + manual retry. */}
      {isError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-4 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <span>
            Pipeline data is unavailable. The pipeline registry could not be
            reached.
          </span>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-1.5 font-medium hover:bg-destructive/10 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            Retry
          </button>
        </div>
      )}

      {data && data.length === 0 && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <Database className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <h2 className="text-base font-medium">No pipelines yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first CDC pipeline to start replicating data.
          </p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Connector</th>
                <th className="px-4 py-2 font-medium">Last sync</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} className="border-t hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <Link
                      to="/cdc/$id"
                      params={{ id: p.id }}
                      className="font-medium text-primary hover:underline"
                    >
                      {p.pipelineName}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[p.status]}`}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {CONNECTOR_LABELS[p.connectorType]}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatTimestamp(p.lastSyncAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
