import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ListIndentDecrease, ListIndentIncrease, Plus } from 'lucide-react';
import { useState } from 'react';
import type { ItemRow } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Tree view for hierarchical collections (#749, `meta.tree.enabled`).
 *
 * Each level is loaded lazily with `?tree=children&parent=…`, so the server's
 * row rules decide what appears: an item the caller cannot read is absent, and
 * so is everything under it. Structure edits go through the move endpoint:
 * up/down reorder among siblings, indent nests under the previous sibling,
 * outdent lifts to the grandparent right after the old parent.
 *
 * Folder mode: `canCreate` / `canUpdate` come from the caller's permission
 * bundle. Without create the "Add child" links are not rendered; without
 * update the structure buttons are not rendered. Navigation (expand, open)
 * never depends on either.
 */

const LEVEL_LIMIT = 200;

export interface TreeViewProps {
  collection: string;
  /** Field whose value labels a node; falls back to the id. */
  labelField?: string;
  canCreate: boolean;
  canUpdate: boolean;
}

interface ParentRef {
  id: string;
  parentId: string | null;
  /** Index of the parent among its own siblings (for outdent placement). */
  index: number;
}

export function CollectionTreeView(props: TreeViewProps) {
  return (
    <div className="rounded-lg border" role="tree" aria-label={`${props.collection} tree`} data-testid="collection-tree">
      <TreeLevel {...props} parent={null} depth={0} />
    </div>
  );
}

function treeKey(collection: string, parent: string | null) {
  return ['items', collection, 'tree', parent ?? '__root__'] as const;
}

function TreeLevel({
  collection,
  labelField,
  canCreate,
  canUpdate,
  parent,
  depth,
}: TreeViewProps & { parent: ParentRef | null; depth: number }) {
  const client = getApiClient();
  const query = useQuery({
    queryKey: treeKey(collection, parent?.id ?? null),
    queryFn: async () =>
      (await client.items(collection as never).tree.children(parent?.id ?? null, { limit: LEVEL_LIMIT })).data as ItemRow[],
  });
  const rows = query.data ?? [];

  if (query.isLoading) {
    return <p className="px-4 py-2 text-xs text-muted-foreground" style={{ paddingLeft: 16 + depth * 20 }}>Loading…</p>;
  }
  if (query.error) {
    return <p className="px-4 py-2 text-xs text-destructive" style={{ paddingLeft: 16 + depth * 20 }}>Failed to load.</p>;
  }
  if (rows.length === 0) {
    return depth === 0 ? (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground">No items yet.</p>
    ) : null;
  }
  return (
    <ul role="group">
      {rows.map((row, index) => (
        <TreeNode
          key={row.id}
          collection={collection}
          labelField={labelField}
          canCreate={canCreate}
          canUpdate={canUpdate}
          row={row}
          index={index}
          siblings={rows}
          parent={parent}
          depth={depth}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  collection,
  labelField,
  canCreate,
  canUpdate,
  row,
  index,
  siblings,
  parent,
  depth,
}: TreeViewProps & {
  row: ItemRow;
  index: number;
  siblings: ItemRow[];
  parent: ParentRef | null;
  depth: number;
}) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const raw = labelField ? (row.data as Record<string, unknown> | undefined)?.[labelField] : undefined;
  const label = typeof raw === 'string' && raw ? raw : row.id;

  const move = useMutation({
    mutationFn: (input: { parentId: string | null; position?: number }) =>
      client.items(collection as never).tree.move(row.id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['items', collection] });
    },
  });

  const parentId = parent?.id ?? null;
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const btn =
    'inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30';

  return (
    <li role="treeitem" aria-expanded={open} aria-level={depth + 1} data-testid={`tree-node-${row.id}`}>
      <div
        className="group flex items-center gap-1 border-t px-2 py-1.5 text-sm first:border-t-0 hover:bg-muted/20"
        style={{ paddingLeft: 8 + depth * 20 }}
      >
        <button
          type="button"
          className={btn}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <Link
          to="/content/$collection/$id"
          params={{ collection, id: row.id }}
          className="flex-1 truncate text-primary hover:underline"
        >
          {label}
        </Link>
        {canUpdate && (
          <span className="flex items-center gap-0.5" data-testid={`tree-actions-${row.id}`}>
            <button
              type="button"
              className={btn}
              aria-label={`Move ${label} up`}
              disabled={index === 0 || move.isPending}
              onClick={() => move.mutate({ parentId, position: index - 1 })}
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={btn}
              aria-label={`Move ${label} down`}
              disabled={index === siblings.length - 1 || move.isPending}
              onClick={() => move.mutate({ parentId, position: index + 1 })}
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={btn}
              aria-label={`Indent ${label}`}
              disabled={!previous || move.isPending}
              onClick={() => previous && move.mutate({ parentId: previous.id })}
            >
              <ListIndentIncrease className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={btn}
              aria-label={`Outdent ${label}`}
              disabled={!parent || move.isPending}
              onClick={() => parent && move.mutate({ parentId: parent.parentId, position: parent.index + 1 })}
            >
              <ListIndentDecrease className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
        {canCreate && (
          <Link
            to="/content/$collection/$id"
            params={{ collection, id: 'new' }}
            search={{ parent: row.id } as never}
            aria-label={`Add child to ${label}`}
            className={cn(btn, 'w-auto px-1 text-xs')}
          >
            <Plus className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      {move.error && (
        <p className="px-4 pb-1 text-xs text-destructive" style={{ paddingLeft: 36 + depth * 20 }} role="alert">
          {moveErrorMessage(move.error)}
        </p>
      )}
      {open && (
        <TreeLevel
          collection={collection}
          labelField={labelField}
          canCreate={canCreate}
          canUpdate={canUpdate}
          parent={{ id: row.id, parentId, index }}
          depth={depth + 1}
        />
      )}
    </li>
  );
}

function moveErrorMessage(err: unknown): string {
  const e = err as { body?: { errors?: Array<{ message?: string }> }; message?: string };
  return e?.body?.errors?.[0]?.message ?? e?.message ?? 'Move failed.';
}
