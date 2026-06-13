import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { getActiveSite, getActiveToken, getApiClient } from '@/lib/api';

/**
 * Materialized views manager (studio-ops-ui task 1; Req 1).
 *
 * Surfaces /api/v1/materialize: denormalized physical tables (mat_*)
 * refreshed from a source collection by trigger (auto), cron, or hand.
 * Deleting DROPS the physical table — that is not revertable, hence the
 * two-step confirm.
 */

const TARGET_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

interface MaterializationRow {
  id: string;
  collection?: string;
  sourceCollection?: string;
  target: string;
  refreshStrategy: string;
  refreshCron?: string | null;
  lastRefreshAt?: string | null;
  [key: string]: unknown;
}

async function materializeFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await fetch(`/api/v1/materialize${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'x-site-id': site } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    errors?: Array<{ code: string; message: string }>;
  };
  if (!res.ok) {
    throw new Error(body.errors?.[0]?.message ?? `Request failed: ${res.status}`);
  }
  return body.data as T;
}

function CreateForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const collectionsQuery = useQuery({
    queryKey: ['mc-collections'],
    queryFn: async () => (await getApiClient().schema.listCollections()).data,
  });
  const [collection, setCollection] = useState('');
  const [target, setTarget] = useState('');
  const [strategy, setStrategy] = useState<'auto' | 'cron' | 'manual'>('manual');
  const [cron, setCron] = useState('0 * * * *');
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      materializeFetch('', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['materialize-list'] });
      onClose();
    },
  });

  const submit = () => {
    if (!TARGET_PATTERN.test(target)) {
      setLocalError('Target must match ^[a-z][a-z0-9_]{0,62}$');
      return;
    }
    setLocalError(null);
    mutation.mutate({
      collection,
      target,
      refreshStrategy: strategy,
      ...(strategy === 'cron' ? { refreshCron: cron } : {}),
      projection: { fields: ['*'] },
    });
  };

  const collections = (collectionsQuery.data ?? []) as Array<{ name: string; label?: string | null }>;

  return (
    <div className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">New materialization</h3>
        <button type="button" onClick={onClose} aria-label="Close create form" className="rounded-md border p-1 hover:bg-muted">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Source collection *</span>
          {collectionsQuery.isError ? (
            <input
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              placeholder="articles"
              aria-label="Source collection"
              className="w-full rounded-md border bg-background px-2 py-1.5 font-mono"
            />
          ) : (
            <select
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              aria-label="Source collection"
              className="w-full rounded-md border bg-background px-2 py-1.5"
            >
              <option value="">choose…</option>
              {collections.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.label ?? c.name}
                </option>
              ))}
            </select>
          )}
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Target table *</span>
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="articles_flat"
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Refresh strategy</span>
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as typeof strategy)}
            aria-label="Refresh strategy"
            className="w-full rounded-md border bg-background px-2 py-1.5"
          >
            <option value="manual">manual</option>
            <option value="cron">cron</option>
            <option value="auto">auto (trigger)</option>
          </select>
        </label>
        {strategy === 'cron' && (
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Cron</span>
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              aria-label="Refresh cron"
              className="w-full rounded-md border bg-background px-2 py-1.5 font-mono"
            />
          </label>
        )}
      </div>
      {(localError || mutation.isError) && (
        <p className="text-xs text-destructive">
          {localError ??
            (mutation.error instanceof Error ? mutation.error.message : 'Create failed.')}
        </p>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={mutation.isPending || !collection || !target}
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {mutation.isPending ? 'Creating…' : 'Create materialization'}
      </button>
    </div>
  );
}

function MaterializationRowView({ row }: { row: MaterializationRow }) {
  const queryClient = useQueryClient();
  const [confirmingDrop, setConfirmingDrop] = useState(false);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['materialize-list'] });

  const refreshMutation = useMutation({
    mutationFn: () => materializeFetch(`/${row.id}/refresh`, { method: 'POST', body: '{}' }),
    onSuccess: invalidate,
  });
  const dropMutation = useMutation({
    mutationFn: () => materializeFetch(`/${row.id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onSettled: () => setConfirmingDrop(false),
  });

  const source = row.collection ?? row.sourceCollection ?? '—';

  return (
    <tr className="border-b align-top last:border-0">
      <td className="py-2">
        <code className="rounded bg-muted px-1 text-xs">{String(source)}</code>
      </td>
      <td className="py-2 font-mono text-xs">mat_{row.target}</td>
      <td className="py-2 text-xs">
        {row.refreshStrategy}
        {row.refreshCron ? <code className="ml-1 rounded bg-muted px-1">{row.refreshCron}</code> : null}
      </td>
      <td className="py-2 text-xs text-muted-foreground">
        {row.lastRefreshAt ? new Date(row.lastRefreshAt).toLocaleString() : 'never'}
      </td>
      <td className="py-2 text-right">
        <span className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            aria-label={`Refresh ${row.target}`}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className="h-3 w-3" />
            {refreshMutation.isPending ? 'Refreshing…' : 'Refresh now'}
          </button>
          {confirmingDrop ? (
            <>
              <button
                type="button"
                onClick={() => setConfirmingDrop(false)}
                className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => dropMutation.mutate()}
                disabled={dropMutation.isPending}
                className="rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
              >
                Confirm drop
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDrop(true)}
              aria-label={`Drop ${row.target}`}
              className="rounded-md border p-1.5 text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
        {(refreshMutation.isError || dropMutation.isError) && (
          <p className="mt-1 text-right text-[10px] text-destructive">
            {((refreshMutation.error ?? dropMutation.error) as Error)?.message ?? 'Action failed.'}
          </p>
        )}
      </td>
    </tr>
  );
}

export function MaterializePage() {
  const [creating, setCreating] = useState(false);
  const listQuery = useQuery({
    queryKey: ['materialize-list'],
    queryFn: () => materializeFetch<MaterializationRow[]>(''),
  });

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Materialized views</h1>
          <p className="text-sm text-muted-foreground">
            Physical tables denormalized from a collection — for read-heavy queries. Dropping a
            view deletes its physical table.
          </p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" /> New materialization
          </button>
        )}
      </div>

      {creating && <CreateForm onClose={() => setCreating(false)} />}

      <div className="rounded-lg border bg-background p-4">
        {listQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading materializations…</p>
        ) : listQuery.isError ? (
          <p className="text-sm text-destructive">
            {listQuery.error instanceof Error ? listQuery.error.message : 'Failed to load.'}
          </p>
        ) : (listQuery.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No materializations yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2">Source</th>
                <th>Table</th>
                <th>Strategy</th>
                <th>Last refresh</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(listQuery.data ?? []).map((row) => (
                <MaterializationRowView key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
