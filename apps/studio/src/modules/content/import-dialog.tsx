import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ImportJob } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';

/**
 * Import dialog (#726): upload a CSV or JSON export file, then follow the
 * background job — progress, cancel, and the row-level error report. Closing
 * the dialog does not stop the job; it keeps running on the server.
 */

export type ImportMode = 'create' | 'upsert';

export interface ImportDialogProps {
  collection: string;
  onClose: () => void;
  /** Poll interval while the job runs (ms). */
  pollMs?: number;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export function isTerminal(job: Pick<ImportJob, 'status'> | undefined): boolean {
  return Boolean(job && TERMINAL.has(job.status));
}

/** `.csv` → csv, `.json` → json; anything else lets the server decide from `format`. */
export function formatFromName(name: string): 'csv' | 'json' | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.json')) return 'json';
  return undefined;
}

export function progressPct(job: Pick<ImportJob, 'processedRows' | 'totalRows'>): number {
  if (job.totalRows <= 0) return 0;
  return Math.min(100, Math.round((job.processedRows / job.totalRows) * 100));
}

const STATUS_LABEL: Record<ImportJob['status'], string> = {
  queued: 'Queued',
  running: 'Importing',
  succeeded: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Timed out',
};

async function downloadErrors(jobId: string) {
  const res = await getApiClient().imports.errorsCsv(jobId);
  const url = URL.createObjectURL(await res.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `import-${jobId}-errors.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function ImportDialog({ collection, onClose, pollMs = 1000 }: ImportDialogProps) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<ImportMode>('create');
  const [jobId, setJobId] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a file first.');
      const format = formatFromName(file.name);
      const res = await client.imports.create(collection, file, { mode, ...(format ? { format } : {}), filename: file.name });
      return res.data;
    },
    onSuccess: (job) => setJobId(job.id),
  });

  const jobQuery = useQuery({
    queryKey: ['import-job', jobId],
    enabled: jobId !== null,
    queryFn: async () => (await client.imports.get(jobId!)).data,
    refetchInterval: (query) => (isTerminal(query.state.data) ? false : pollMs),
  });
  const job = jobQuery.data ?? upload.data;
  const done = isTerminal(job);

  // Refresh the list once the job lands.
  useEffect(() => {
    if (done) void queryClient.invalidateQueries({ queryKey: ['items', collection] });
  }, [done, queryClient, collection]);

  const cancel = useMutation({
    mutationFn: async () => (await client.imports.cancel(jobId!)).data,
    onSuccess: (next) => queryClient.setQueryData(['import-job', jobId], next),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <div className="w-full max-w-md space-y-4 rounded-lg border bg-background p-5 shadow-lg">
        <h2 id="import-title" className="text-base font-semibold">
          Import into {collection}
        </h2>

        {!job && (
          <>
            <label className="block space-y-1">
              <span className="text-sm text-muted-foreground">File (CSV or JSON export)</span>
              <input
                type="file"
                accept=".csv,.json,text/csv,application/json"
                className="block w-full text-sm"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-muted-foreground">Mode</span>
              <select
                className="w-full rounded-md border px-3 py-1.5 text-sm"
                value={mode}
                onChange={(e) => setMode(e.target.value as ImportMode)}
              >
                <option value="create">Create new items</option>
                <option value="upsert">Update items with a matching id, create the rest</option>
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              The import runs in the background. You can close this dialog; the job keeps going.
            </p>
          </>
        )}

        {job && (
          <div className="space-y-2" aria-live="polite">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{STATUS_LABEL[job.status]}</span>
              <span className="text-muted-foreground">
                {job.processedRows} / {job.totalRows} rows
              </span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPct(job)}
            >
              <div className="h-full bg-primary transition-all" style={{ width: `${progressPct(job)}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {job.createdRows} created · {job.updatedRows} updated · {job.failedRows} failed
              {job.cancelRequested && !done ? ' · stopping after the current batch…' : ''}
            </p>
            {job.message && <p className="text-sm text-muted-foreground">{job.message}</p>}
            {job.failedRows > 0 && done && (
              <button type="button" className="text-sm text-primary hover:underline" onClick={() => void downloadErrors(job.id)}>
                Download error report
              </button>
            )}
          </div>
        )}

        {(upload.isError || cancel.isError) && (
          <p className="text-sm text-destructive">{((upload.error ?? cancel.error) as Error).message}</p>
        )}

        <div className="flex justify-end gap-2">
          {job && !done && (
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              disabled={cancel.isPending || job.cancelRequested}
              onClick={() => cancel.mutate()}
            >
              Cancel import
            </button>
          )}
          <button type="button" className="rounded-md px-3 py-1.5 text-sm hover:bg-muted" onClick={onClose}>
            {job ? 'Close' : 'Cancel'}
          </button>
          {!job && (
            <button
              type="button"
              disabled={!file || upload.isPending}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
              onClick={() => upload.mutate()}
            >
              {upload.isPending ? 'Uploading…' : 'Import'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
