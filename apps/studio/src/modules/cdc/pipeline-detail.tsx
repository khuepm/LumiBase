import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { deletePipeline, getPipeline, getPipelineMetrics } from './api';
import {
  CONNECTOR_LABELS,
  STATUS_BADGE_CLASSES,
  deletionResources,
  formatTimestamp,
  remediationSteps,
} from './presentation';
import type { PipelineSummary } from './types';

/** Active pipelines refresh metrics at most every 10 seconds (Req 6.6). */
const METRIC_REFRESH_INTERVAL_MS = 10_000;

/**
 * CDC pipeline detail — a metrics dashboard placeholder plus error-state
 * display and a delete flow (ClickHouse CDC — task 13.3; design "Studio CDC
 * Panel" §6).
 *
 * Satisfies:
 *   - Req 6.4 — when the pipeline is in `error`, shows the error timestamp,
 *     source component, description, and at least one remediation step;
 *   - Req 6.5 — deletion goes through a confirmation dialog that lists the
 *     resources to be removed (incl. replication slots for slot-based
 *     approaches);
 *   - Req 6.6 — while the pipeline is `active`, metrics refresh every 10s
 *     (TanStack Query `refetchInterval`);
 *   - Req 6.8 — when pipeline data can't be retrieved, shows an error
 *     indication with a manual Retry button.
 */
export function CdcPipelineDetailPage({ pipelineId }: { pipelineId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const pipelineQuery = useQuery({
    queryKey: ['cdc', 'pipeline', pipelineId],
    queryFn: () => getPipeline(pipelineId),
  });

  const pipeline = pipelineQuery.data;
  const isActive = pipeline?.status === 'active';

  // Metrics poll only while the pipeline is active (Req 6.6). Disabled
  // otherwise so paused/errored pipelines don't poll a dead connector.
  const metricsQuery = useQuery({
    queryKey: ['cdc', 'pipeline', pipelineId, 'metrics'],
    queryFn: () => getPipelineMetrics(pipelineId),
    enabled: isActive,
    refetchInterval: isActive ? METRIC_REFRESH_INTERVAL_MS : false,
  });

  const remove = useMutation({
    mutationFn: () => deletePipeline(pipelineId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cdc', 'pipelines'] });
      navigate({ to: '/cdc' });
    },
  });

  if (pipelineQuery.isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading pipeline…</p>;
  }

  // Req 6.8 — pipeline data unavailable: explicit indication + manual retry.
  if (pipelineQuery.isError || !pipeline) {
    return (
      <div className="mx-auto max-w-3xl p-6">
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
            onClick={() => pipelineQuery.refetch()}
            disabled={pipelineQuery.isFetching}
            className="inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-1.5 font-medium hover:bg-destructive/10 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${pipelineQuery.isFetching ? 'animate-spin' : ''}`}
            />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{pipeline.pipelineName}</h1>
            <span
              className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[pipeline.status]}`}
            >
              {pipeline.status}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {CONNECTOR_LABELS[pipeline.connectorType]} · last sync{' '}
            {formatTimestamp(pipeline.lastSyncAt)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setConfirmingDelete(true)}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </button>
      </header>

      {pipeline.status === 'error' && <ErrorPanel pipeline={pipeline} />}

      <MetricsDashboard
        active={isActive}
        metrics={metricsQuery.data}
        isError={metricsQuery.isError}
        onRetry={() => metricsQuery.refetch()}
      />

      {confirmingDelete && (
        <DeleteConfirmationDialog
          pipeline={pipeline}
          pending={remove.isPending}
          error={remove.error}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => remove.mutate()}
        />
      )}
    </div>
  );
}

// ── error state (Req 6.4) ──────────────────────────────────────────────────

function ErrorPanel({ pipeline }: { pipeline: PipelineSummary }) {
  const steps = remediationSteps(pipeline);
  return (
    <section
      role="alert"
      className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm"
    >
      <div className="flex items-center gap-2 font-medium text-destructive">
        <AlertTriangle className="h-4 w-4" />
        Pipeline error
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
        <dt className="font-medium text-foreground">Time</dt>
        <dd>{formatTimestamp(pipeline.updatedAt)}</dd>
        <dt className="font-medium text-foreground">Source</dt>
        <dd>{CONNECTOR_LABELS[pipeline.connectorType]} connector</dd>
        <dt className="font-medium text-foreground">Description</dt>
        <dd>{pipeline.statusMessage ?? 'Unknown error.'}</dd>
      </dl>
      <div>
        <p className="font-medium text-foreground">Remediation steps</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
          {steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ── metrics dashboard placeholder (Req 6.6) ────────────────────────────────

interface MetricsDashboardProps {
  active: boolean;
  metrics:
  | { replicationLagMs: number; eventsPerSecond: number; errorCount: number; collectedAt: string }
  | undefined;
  isError: boolean;
  onRetry: () => void;
}

function MetricsDashboard({ active, metrics, isError, onRetry }: MetricsDashboardProps) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium">Metrics</h2>
        {active && (
          <span className="text-xs text-muted-foreground">
            Auto-refreshing every 10s
          </span>
        )}
      </div>

      {!active && (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Live metrics are shown while the pipeline is active.
        </p>
      )}

      {active && isError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-4 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <span>Metrics are unavailable right now.</span>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-1.5 font-medium hover:bg-destructive/10"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      )}

      {active && !isError && (
        <div className="grid gap-4 sm:grid-cols-3">
          <MetricCard
            label="Replication lag"
            value={metrics ? `${metrics.replicationLagMs} ms` : '…'}
          />
          <MetricCard
            label="Throughput"
            value={metrics ? `${metrics.eventsPerSecond}/s` : '…'}
          />
          <MetricCard
            label="Errors"
            value={metrics ? String(metrics.errorCount) : '…'}
          />
        </div>
      )}

      {/* Placeholder for the real-time charts (replication lag / throughput /
          error rate) that a later task wires up — task title is "placeholder
          structure". */}
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        Real-time charts coming soon.
      </div>
    </section>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}

// ── delete confirmation dialog (Req 6.5) ───────────────────────────────────

interface DeleteConfirmationDialogProps {
  pipeline: PipelineSummary;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteConfirmationDialog({
  pipeline,
  pending,
  error,
  onCancel,
  onConfirm,
}: DeleteConfirmationDialogProps) {
  const resources = deletionResources(pipeline);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cdc-delete-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg rounded-xl border bg-background p-6 shadow-lg">
        <h2 id="cdc-delete-title" className="text-lg font-semibold">
          Delete pipeline “{pipeline.pipelineName}”?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This will permanently remove the following resources:
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
          {resources.map((resource, i) => (
            <li key={i}>{resource}</li>
          ))}
        </ul>

        {error != null && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error instanceof Error ? error.message : String(error)}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Deleting…' : 'Delete pipeline'}
          </button>
        </div>
      </div>
    </div>
  );
}
