import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { ItemRow } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { readOptions, type InterfaceComponent } from './types';

interface TreeViewOptions {
  /** Self-referencing collection to render as a tree. */
  collection?: string;
  /** Label field on each row. */
  displayField?: string;
  /** Field on each row pointing at its parent's id (default `parent`). */
  parentField?: string;
}

interface TreeRow {
  id: string;
  label: string;
  children: TreeRow[];
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

/** Build a parent→children forest from a flat row list. */
function buildForest(rows: ItemRow[], displayField: string, parentField: string): TreeRow[] {
  const nodes = new Map<string, TreeRow>();
  for (const row of rows) {
    const data = row.data as Record<string, unknown> | undefined;
    nodes.set(row.id, { id: row.id, label: String(data?.[displayField] ?? row.id), children: [] });
  }
  const roots: TreeRow[] = [];
  for (const row of rows) {
    const data = row.data as Record<string, unknown> | undefined;
    const parentId = data?.[parentField];
    const node = nodes.get(row.id)!;
    if (typeof parentId === 'string' && nodes.has(parentId)) {
      nodes.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/**
 * `relation-o2m-tree-view` — renders a self-referencing collection as an
 * expandable tree and lets the user check which rows belong to this item.
 * Stores the selected ids as `string[]` (same contract as o2m).
 */
export const RelationTreeViewInterface: InterfaceComponent<string[]> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<TreeViewOptions>(field);
  const client = getApiClient();
  const collection = opts.collection;
  const displayField = opts.displayField ?? 'title';
  const parentField = opts.parentField ?? 'parent';
  const selected = asArray(value);

  const query = useQuery({
    enabled: !!collection,
    queryKey: ['tree-view', collection, displayField, parentField],
    queryFn: async () => client.items(collection as never).list({ limit: 200 }),
  });

  if (!collection) {
    return <p className="text-xs text-destructive">Missing `meta.options.collection` for tree field.</p>;
  }

  const forest = buildForest(query.data?.data ?? [], displayField, parentField);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  return (
    <div className="rounded-md border bg-background p-2 text-sm">
      {query.isLoading && <p className="px-1 text-xs text-muted-foreground">Loading…</p>}
      {!query.isLoading && forest.length === 0 && (
        <p className="px-1 text-xs text-muted-foreground">No rows.</p>
      )}
      {forest.map((node) => (
        <TreeNode key={node.id} node={node} depth={0} selected={selected} disabled={disabled} onToggle={toggle} />
      ))}
    </div>
  );
};

function TreeNode({
  node,
  depth,
  selected,
  disabled,
  onToggle,
}: {
  node: TreeRow;
  depth: number;
  selected: string[];
  disabled?: boolean;
  onToggle: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const active = selected.includes(node.id);

  return (
    <div>
      <div className="flex items-center gap-1 py-0.5" style={{ paddingLeft: depth * 16 }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-muted-foreground hover:text-foreground"
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="w-3.5" />
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onToggle(node.id)}
          className="flex items-center gap-2 text-left disabled:opacity-50"
        >
          <span
            className={cn(
              'flex h-3.5 w-3.5 items-center justify-center rounded border',
              active ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
            )}
          >
            {active && <Check className="h-2.5 w-2.5" />}
          </span>
          {node.label}
        </button>
      </div>
      {hasChildren &&
        expanded &&
        node.children.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            selected={selected}
            disabled={disabled}
            onToggle={onToggle}
          />
        ))}
    </div>
  );
}
