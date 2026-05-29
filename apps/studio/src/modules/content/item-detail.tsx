import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ChevronLeft, Lock, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FieldResource, ItemRow } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePermissions, type PermissionHelpers } from '@/lib/use-permissions';
import { PresenceChip } from '@/components/presence-chip';
import { resolveInterface } from './interfaces/registry';
import { RawToggle } from './interfaces/raw-toggle';
import { RevisionsPanel } from './revisions-panel';
import { RawJsonPanel } from './raw-json-panel';

type Tab = 'fields' | 'revisions' | 'raw';

/**
 * Content module detail editor.
 * Phase B FE slice 2: hosts the side-panel tabs (Fields / Revisions / Raw JSON)
 * around a basic field editor. The full Interface registry lands in slice 3+.
 */
export function ItemDetailPage() {
  const { collection, id } = useParams({ from: '/admin-layout/content/$collection/$id' });
  const client = getApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const perms = usePermissions();

  const [tab, setTab] = useState<Tab>('fields');
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);

  const canRead = perms.can(collection, 'read');
  const canUpdate = perms.can(collection, 'update');
  const canDelete = perms.can(collection, 'delete');

  const fieldsQuery = useQuery({
    queryKey: ['fields', collection],
    queryFn: async () => (await client.schema.listFields(collection)).data,
  });

  const itemQuery = useQuery({
    queryKey: ['item', collection, id],
    queryFn: async () => (await client.items(collection as never).detail(id)).data as ItemRow,
    enabled: !perms.isLoading && canRead,
  });

  // Hydrate draft from server data once.
  useEffect(() => {
    if (itemQuery.data && draft === null) {
      setDraft({ ...(itemQuery.data.data as Record<string, unknown>) });
    }
  }, [itemQuery.data, draft]);

  const fields = fieldsQuery.data ?? [];
  // Fields the user can read at all — anything else is invisible (server
  // strips it from the payload, but we'd render an empty input otherwise).
  const editable: FieldResource[] = useMemo(
    () =>
      fields
        .filter((f) => !f.hidden)
        .filter((f) => perms.fieldAllowed(collection, 'read', f.name)),
    [fields, perms, collection],
  );

  const isDirty = useMemo(() => {
    if (!itemQuery.data || draft === null) return false;
    return JSON.stringify(draft) !== JSON.stringify(itemQuery.data.data ?? {});
  }, [draft, itemQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) return null;
      const res = await client.items(collection as never).patch(id, { data: draft });
      return res.data as ItemRow;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['item', collection, id] });
      queryClient.invalidateQueries({ queryKey: ['items', collection] });
      queryClient.invalidateQueries({ queryKey: ['revisions', collection, id] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await client.items(collection as never).delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items', collection] });
      navigate({ to: '/content/$collection', params: { collection } });
    },
  });

  if (!perms.isLoading && !canRead) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
        <Lock className="h-4 w-4" />
        You do not have <code className="mx-1 rounded bg-background px-1 text-xs">read</code>
        permission on this collection.
      </div>
    );
  }

  if (itemQuery.error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load item.
      </div>
    );
  }

  if (!itemQuery.data || draft === null) {
    return <p className="text-sm text-muted-foreground">Loading item…</p>;
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase text-muted-foreground">
            <Link to="/" className="hover:underline">Content</Link>
            <span className="mx-1">/</span>
            <Link
              to="/content/$collection"
              params={{ collection }}
              className="hover:underline"
            >
              {collection}
            </Link>
            <span className="mx-1">/</span>
            <span className="font-mono">{id.slice(0, 8)}…</span>
          </p>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Link
              to="/content/$collection"
              params={{ collection }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Back to list"
            >
              <ChevronLeft className="h-5 w-5" />
            </Link>
            Edit item
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Presence chip — shows other users currently editing this item */}
          <PresenceChip collection={collection} itemId={id} />
          <button
            type="button"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending || !canDelete}
            title={canDelete ? undefined : 'You do not have delete permission on this collection.'}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-50',
              canDelete
                ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
                : 'cursor-not-allowed border-muted-foreground/20 text-muted-foreground',
            )}
          >
            {canDelete ? <Trash2 className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            Delete
          </button>
          <button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={!isDirty || saveMutation.isPending || !canUpdate}
            title={canUpdate ? undefined : 'You do not have update permission on this collection.'}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium',
              isDirty && canUpdate
                ? 'bg-primary text-primary-foreground hover:opacity-90'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {canUpdate ? <Save className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            {saveMutation.isPending ? 'Saving…' : isDirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </header>

      {saveMutation.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          Save failed.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_22rem]">
        <section className="rounded-lg border bg-background p-4">
          {tab === 'fields' && (
            <FieldsTab
              fields={editable}
              value={draft}
              onChange={setDraft}
              collection={collection}
              perms={perms}
            />
          )}
          {tab === 'revisions' && (
            <RevisionsPanel
              collection={collection}
              itemId={id}
              onRevert={() => {
                queryClient.invalidateQueries({ queryKey: ['item', collection, id] });
                setDraft(null);
              }}
            />
          )}
          {tab === 'raw' && (
            <RawJsonPanel
              value={draft}
              onChange={setDraft}
            />
          )}
        </section>

        <aside className="rounded-lg border bg-muted/20 p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Tabs</h2>
          <ul className="space-y-1 text-sm">
            <TabButton current={tab} value="fields" onClick={setTab}>Fields</TabButton>
            <TabButton current={tab} value="revisions" onClick={setTab}>Revisions</TabButton>
            <TabButton current={tab} value="raw" onClick={setTab}>Raw JSON</TabButton>
          </ul>
          <dl className="mt-4 space-y-1 border-t pt-3 text-xs text-muted-foreground">
            <Meta label="Status" value={itemQuery.data.status} />
            <Meta label="Sort" value={String(itemQuery.data.sort ?? 0)} />
            <Meta label="Updated" value={new Date(itemQuery.data.updatedAt).toLocaleString()} />
            <Meta label="Created" value={new Date(itemQuery.data.createdAt).toLocaleString()} />
          </dl>
        </aside>
      </div>
    </div>
  );
}

function TabButton({
  current,
  value,
  onClick,
  children,
}: {
  current: Tab;
  value: Tab;
  onClick: (tab: Tab) => void;
  children: React.ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onClick(value)}
        className={cn(
          'w-full rounded-md px-2 py-1 text-left',
          current === value ? 'bg-background font-medium shadow-sm' : 'hover:bg-background/60',
        )}
      >
        {children}
      </button>
    </li>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{label}</dt>
      <dd className="text-foreground/80">{value}</dd>
    </div>
  );
}

/**
 * Renders one editor per field by dispatching to the Interface registry
 * (`resolveInterface`). Each interface owns its own value transform; here we
 * just track the current cell value and patch the parent draft on change.
 *
 * Phase C: fields without `update` permission render disabled (read-only) so
 * the user sees them but cannot mutate them. Fields without `read` are
 * filtered upstream in `editable`, so they never reach here.
 */
function FieldsTab({
  fields,
  value,
  onChange,
  collection,
  perms,
}: {
  fields: FieldResource[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  collection: string;
  perms: PermissionHelpers;
}) {
  if (fields.length === 0) {
    return <p className="text-sm text-muted-foreground">No editable fields.</p>;
  }
  return (
    <div className="space-y-4">
      {fields.map((f) => {
        const Interface = resolveInterface(f);
        const cellValue = value?.[f.name];
        const writable = perms.fieldAllowed(collection, 'update', f.name);
        const setCell = (next: unknown) => {
          if (!writable) return;
          onChange({ ...value, [f.name]: next });
        };
        return (
          <div key={f.id}>
            <label className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <span>{f.name}</span>
              {f.required && <span className="text-destructive">*</span>}
              <span className="text-[10px] uppercase">{f.interface || f.type}</span>
              {!writable && (
                <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-amber-700">
                  <Lock className="h-3 w-3" /> read-only
                </span>
              )}
            </label>
            <div className={cn(!writable && 'pointer-events-none opacity-70')}>
              <RawToggle value={cellValue} onChange={setCell}>
                <Interface field={f} value={cellValue} onChange={setCell} />
              </RawToggle>
            </div>
          </div>
        );
      })}
    </div>
  );
}
