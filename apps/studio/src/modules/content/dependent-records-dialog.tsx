import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';

/** One group of records that reference the item being deleted. */
export interface DependentGroup {
  relation: string;
  /** `richtext`: rich-text links/embeds (#697) — fixed by editing that content, not via resolve-dependents. */
  kind?: 'relation' | 'richtext';
  collection: string;
  field: string;
  onDelete: string;
  count: number;
  sample: Array<{ id: string }>;
}

type Action = 'set_null' | 'delete' | 'reassign';

/**
 * Shown when deleting an item is blocked because other records reference it
 * (HTTP 409 DEPENDENT_RECORDS_EXIST). For each dependency group the editor
 * picks a resolution; once all groups are cleared the parent retries the delete.
 * Spec: fk-dependent-records Req 11.
 */
export function DependentRecordsDialog(props: {
  collection: string;
  itemId: string;
  groups: DependentGroup[];
  onClose: () => void;
  onAllResolved: () => void;
  /** Open a referencing item (rich-text groups link to the content to edit). */
  onOpenItem?: (collection: string, id: string) => void;
}) {
  const client = getApiClient();
  const [resolved, setResolved] = useState<Record<string, boolean>>({});
  const [choice, setChoice] = useState<Record<string, Action>>({});
  const [reassignTo, setReassignTo] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Rich-text references cannot be batch-resolved: the editor removes the
  // link or embed in the referencing item, then deletes again.
  const resolvable = props.groups.filter((g) => g.kind !== 'richtext');

  const resolveMutation = useMutation({
    mutationFn: async (group: DependentGroup) => {
      const action = choice[group.relation] ?? 'set_null';
      await client.rawRequest(`/api/v1/items/${props.collection}/${props.itemId}/resolve-dependents`, {
        method: 'POST',
        body: JSON.stringify({
          action,
          relation: group.relation,
          newTargetId: action === 'reassign' ? reassignTo[group.relation] : undefined,
        }),
      });
    },
    onSuccess: (_data, group) => {
      const next = { ...resolved, [group.relation]: true };
      setResolved(next);
      setError(null);
      if (resolvable.length === props.groups.length && props.groups.every((g) => next[g.relation])) props.onAllResolved();
    },
    onError: (err: unknown) => {
      setError((err as { body?: { errors?: Array<{ message?: string }> } })?.body?.errors?.[0]?.message ?? 'Failed to resolve.');
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-background p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            Records depend on this item
          </div>
          <button type="button" onClick={props.onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Other records reference this item. Resolve each group before deleting.
        </p>

        <div className="space-y-3">
          {props.groups.map((g) => (
            <div key={g.relation} className="rounded-md border border-border p-3 text-xs">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium">
                  {g.count} × {g.collection}.{g.field}
                </span>
                {resolved[g.relation] ? (
                  <span className="text-green-600">Resolved</span>
                ) : (
                  <span className="text-muted-foreground">onDelete: {g.onDelete}</span>
                )}
              </div>
              {g.kind === 'richtext' && (
                <div className="space-y-1" data-testid={`richtext-dependents-${g.collection}-${g.field}`}>
                  <p className="text-muted-foreground">
                    Rich text in these records links to or embeds this item. Remove the reference there, then delete
                    again.
                  </p>
                  {g.sample.length > 0 && (
                    <ul className="flex flex-wrap gap-2">
                      {g.sample.map((s) => (
                        <li key={s.id}>
                          {props.onOpenItem ? (
                            <button
                              type="button"
                              className="rounded border border-border px-2 py-0.5 font-mono hover:bg-accent"
                              onClick={() => props.onOpenItem?.(g.collection, s.id)}
                            >
                              {s.id}
                            </button>
                          ) : (
                            <span className="font-mono">{s.id}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {g.count > g.sample.length && (
                    <p className="text-muted-foreground">…and {g.count - g.sample.length} more.</p>
                  )}
                </div>
              )}
              {g.kind !== 'richtext' && !resolved[g.relation] && (
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="rounded border border-input bg-background px-2 py-1"
                    value={choice[g.relation] ?? 'set_null'}
                    onChange={(e) => setChoice({ ...choice, [g.relation]: e.target.value as Action })}
                  >
                    <option value="set_null">Clear the reference</option>
                    <option value="reassign">Reassign to another item</option>
                    <option value="delete">Delete these records</option>
                  </select>
                  {(choice[g.relation] ?? 'set_null') === 'reassign' && (
                    <input
                      placeholder="new target id"
                      className="rounded border border-input bg-background px-2 py-1"
                      value={reassignTo[g.relation] ?? ''}
                      onChange={(e) => setReassignTo({ ...reassignTo, [g.relation]: e.target.value })}
                    />
                  )}
                  <button
                    type="button"
                    disabled={resolveMutation.isPending}
                    onClick={() => resolveMutation.mutate(g)}
                    className="rounded bg-primary px-2 py-1 text-primary-foreground hover:opacity-90"
                  >
                    Apply
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {error && <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}
      </div>
    </div>
  );
}
