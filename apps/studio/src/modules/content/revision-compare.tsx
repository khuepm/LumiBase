import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { RevisionRow } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { RevisionsDiff } from './revisions-diff';

/**
 * Compare any two snapshots of an item (#686): a revision, the empty state
 * or the live item. The server decrypts and field-masks both sides. When the
 * left side is a revision, each changed field can be restored from it — the
 * restore is a normal PATCH, so it writes a new revision with provenance.
 */

export const EMPTY = 'empty';
export const CURRENT = 'current';

function label(rev: RevisionRow): string {
  return `${new Date(rev.createdAt).toLocaleString()} · ${rev.id.slice(0, 8)}`;
}

function errorMessage(err: unknown): string {
  const e = err as { body?: { errors?: Array<{ message?: string }> }; message?: string };
  return e?.body?.errors?.[0]?.message ?? e?.message ?? 'Request failed.';
}

export function RevisionCompare({
  collection,
  itemId,
  revisions,
  canUpdate,
  onRestored,
  initialFrom,
}: {
  collection: string;
  itemId: string;
  /** Newest first, as the revisions list returns them. */
  revisions: RevisionRow[];
  canUpdate: boolean;
  onRestored?: () => void;
  initialFrom?: string;
}) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState<string>(initialFrom ?? revisions[1]?.id ?? revisions[0]?.id ?? EMPTY);
  const [to, setTo] = useState<string>(CURRENT);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  const compare = useQuery({
    queryKey: ['revision-compare', collection, itemId, from, to],
    queryFn: async () => (await client.items(collection as never).compareRevisions(itemId, { from, to })).data,
  });

  const restore = useMutation({
    mutationFn: async (field: string) => {
      setRestoring(field);
      return client.items(collection as never).restoreRevisionFields(itemId, from, [field]);
    },
    onSettled: () => setRestoring(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['item', collection, itemId] });
      queryClient.invalidateQueries({ queryKey: ['revisions', collection, itemId] });
      queryClient.invalidateQueries({ queryKey: ['revision-compare', collection, itemId] });
      onRestored?.();
    },
  });

  const canRestore = canUpdate && from !== EMPTY && from !== to;

  return (
    <div className="space-y-3" data-testid="revision-compare">
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">From</span>
          <select
            aria-label="Compare from"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border bg-background px-2 py-1"
          >
            <option value={EMPTY}>(empty — before creation)</option>
            {revisions.map((r) => (
              <option key={r.id} value={r.id}>
                {label(r)}
              </option>
            ))}
          </select>
        </label>
        <span className="pb-1.5 text-muted-foreground">→</span>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">To</span>
          <select
            aria-label="Compare to"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border bg-background px-2 py-1"
          >
            <option value={CURRENT}>Current item</option>
            {revisions.map((r) => (
              <option key={r.id} value={r.id}>
                {label(r)}
              </option>
            ))}
          </select>
        </label>
        <label className="ms-auto inline-flex items-center gap-1 pb-1.5 text-muted-foreground">
          <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} />
          Show unchanged fields
        </label>
      </div>

      {compare.isLoading && <p className="text-sm text-muted-foreground">Comparing…</p>}
      {compare.error && <p className="text-sm text-destructive">{errorMessage(compare.error)}</p>}
      {restore.error && (
        <p role="alert" className="text-sm text-destructive">
          Restore failed: {errorMessage(restore.error)}
        </p>
      )}
      {compare.data && (
        <div className="max-h-[60vh] overflow-y-auto pe-1">
          <RevisionsDiff
            before={compare.data.before}
            after={compare.data.after}
            showUnchanged={showUnchanged}
            beforeLabel={from === EMPTY ? 'Empty' : 'From'}
            afterLabel={to === CURRENT ? 'Current' : 'To'}
            onRestore={canRestore ? (field) => restore.mutate(field) : undefined}
            restoring={restoring}
          />
        </div>
      )}
    </div>
  );
}
