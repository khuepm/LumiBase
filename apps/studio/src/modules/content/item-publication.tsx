import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CopyPlus } from 'lucide-react';
import { useState } from 'react';
import type { ItemRow } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Editorial conveniences for the item editor (epic #668):
 *
 * - {@link PublicationInfo}: first/last publish and the "modified since
 *   publish" badge (#687).
 * - {@link DuplicateItemButton}: save-as-copy (#689) — a draft copy whose
 *   unique fields get a `-copy` suffix; opens the copy on success.
 */

type PublicationFields = Pick<ItemRow, 'firstPublishedAt' | 'publishedAt' | 'hasUnpublishedChanges'>;

function formatWhen(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}

/** Badge text for an item's publication state, or null when there is nothing to say. */
export function publicationBadge(item: PublicationFields & Pick<ItemRow, 'status'>): string | null {
  if (item.hasUnpublishedChanges) return item.status === 'published' ? 'Modified since publish' : 'Unpublished changes';
  if (!item.firstPublishedAt) return item.status === 'published' ? null : 'Never published';
  return null;
}

export function PublicationInfo({ item }: { item: PublicationFields & Pick<ItemRow, 'status'> }) {
  const first = formatWhen(item.firstPublishedAt);
  const last = formatWhen(item.publishedAt);
  const badge = publicationBadge(item);
  return (
    <div className="space-y-1" data-testid="publication-info">
      {badge && (
        <p
          className={cn(
            'inline-block rounded px-1.5 py-0.5 text-[11px] font-medium',
            item.hasUnpublishedChanges
              ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {badge}
        </p>
      )}
      {first && (
        <div className="flex justify-between gap-2">
          <dt>First published</dt>
          <dd className="text-foreground/80">{first}</dd>
        </div>
      )}
      {last && last !== first && (
        <div className="flex justify-between gap-2">
          <dt>Last published</dt>
          <dd className="text-foreground/80">{last}</dd>
        </div>
      )}
    </div>
  );
}

type RelationsMode = 'reference' | 'deep' | 'none';

const MODES: Array<{ value: RelationsMode; label: string; hint: string }> = [
  { value: 'reference', label: 'Copy with links', hint: 'Many-to-many links point at the same items.' },
  { value: 'deep', label: 'Copy with children', hint: 'Also copies one level of child records.' },
  { value: 'none', label: 'Copy item only', hint: 'No related records.' },
];

function errorMessage(err: unknown): string {
  const e = err as { body?: { errors?: Array<{ message?: string }> }; message?: string };
  return e?.body?.errors?.[0]?.message ?? e?.message ?? 'Duplicate failed.';
}

export function DuplicateItemButton({
  collection,
  id,
  canCreate,
}: {
  collection: string;
  id: string;
  canCreate: boolean;
}) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const duplicate = useMutation({
    mutationFn: async (relations: RelationsMode) => {
      const res = await client.items(collection as never).duplicate(id, { relations });
      return res.data as ItemRow;
    },
    onSuccess: (copy) => {
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ['items', collection] });
      navigate({ to: '/content/$collection/$id', params: { collection, id: copy.id } });
    },
  });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!canCreate || duplicate.isPending}
        title={canCreate ? 'Save as copy' : 'You do not have create permission on this collection.'}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        <CopyPlus className="h-3.5 w-3.5" />
        {duplicate.isPending ? 'Copying…' : 'Duplicate'}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute end-0 top-full z-20 mt-1 w-60 rounded-md border border-border bg-background py-1 text-xs shadow-md"
          onMouseLeave={() => setOpen(false)}
        >
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="menuitem"
              onClick={() => duplicate.mutate(m.value)}
              className="block w-full px-3 py-1.5 text-start hover:bg-muted"
            >
              <span className="block font-medium">{m.label}</span>
              <span className="block text-muted-foreground">{m.hint}</span>
            </button>
          ))}
        </div>
      )}
      {duplicate.error && (
        <p role="alert" className="absolute end-0 top-full mt-1 w-60 text-xs text-destructive">
          {errorMessage(duplicate.error)}
        </p>
      )}
    </div>
  );
}

/** Result of duplicating several items one after another (#689). */
export interface BulkDuplicateResult {
  created: string[];
  failed: Array<{ id: string; message: string }>;
}

/**
 * Duplicate `ids` sequentially (each through `POST …/duplicate`, so every copy
 * gets its own permission check, validation, revision and audit entry). One
 * failure does not stop the rest.
 */
export async function duplicateMany(
  duplicate: (id: string) => Promise<{ data: { id: string } }>,
  ids: string[],
): Promise<BulkDuplicateResult> {
  const out: BulkDuplicateResult = { created: [], failed: [] };
  for (const id of ids) {
    try {
      out.created.push((await duplicate(id)).data.id);
    } catch (err) {
      out.failed.push({ id, message: errorMessage(err) });
    }
  }
  return out;
}

export function BulkDuplicateButton({
  collection,
  ids,
  canCreate,
  onDone,
}: {
  collection: string;
  ids: string[];
  canCreate: boolean;
  onDone?: (result: BulkDuplicateResult) => void;
}) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [result, setResult] = useState<BulkDuplicateResult | null>(null);
  const run = useMutation({
    mutationFn: () =>
      duplicateMany(
        (id) => client.items(collection as never).duplicate(id, { relations: 'reference' }) as Promise<{ data: { id: string } }>,
        ids,
      ),
    onSuccess: (r) => {
      setResult(r);
      queryClient.invalidateQueries({ queryKey: ['items', collection] });
      onDone?.(r);
    },
  });
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => run.mutate()}
        disabled={!canCreate || run.isPending || ids.length === 0}
        title={canCreate ? 'Save each selected item as a draft copy' : 'You do not have create permission on this collection.'}
        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        <CopyPlus className="h-3.5 w-3.5" />
        {run.isPending ? 'Duplicating…' : `Duplicate (${ids.length})`}
      </button>
      {result && (
        <span role="status" className={cn('text-xs', result.failed.length ? 'text-destructive' : 'text-muted-foreground')}>
          {result.created.length} copied
          {result.failed.length > 0 ? `, ${result.failed.length} failed: ${result.failed[0]!.message}` : ''}
        </span>
      )}
    </span>
  );
}
