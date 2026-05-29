import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, Bookmark, ChevronLeft, ChevronRight, Code2, Filter, Lock, RefreshCw, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { FieldResource, PresetResource } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/lib/use-permissions';
import { useRealtimeSubscription } from '@/hooks/use-realtime';
import { BulkRawEditor } from './bulk-raw-editor';
import { resolveDisplay } from './displays/registry';
import { FilterBuilder, compileFilter, type FilterCondition } from './filter-builder';

const PAGE_SIZE = 25;

interface SortState {
  field: string;
  dir: 'asc' | 'desc';
}

/**
 * Content module: tabular items list for a single collection.
 * Wires filter builder + column-header sort + offset paginate against the
 * Phase B `/api/v1/items/:collection` endpoints via the typed SDK.
 */
export function ItemsListPage() {
  const { collection } = useParams({ from: '/admin-layout/content/$collection' });
  const client = getApiClient();
  const perms = usePermissions();

  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState<SortState>({ field: 'updated_at', dir: 'desc' });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulk, setShowBulk] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const queryClient = useQueryClient();

  useRealtimeSubscription(collection, () => {
    if (liveMode) {
      queryClient.invalidateQueries({ queryKey: ['items', collection] });
    }
  });

  const fieldsQuery = useQuery({
    queryKey: ['fields', collection],
    queryFn: async () => (await client.schema.listFields(collection)).data,
  });

  const presetsQuery = useQuery({
    queryKey: ['presets', collection],
    queryFn: async () => (await client.presets.list(collection)).data,
  });

  const filterPayload = useMemo(() => compileFilter(filters), [filters]);

  const canRead = perms.can(collection, 'read');
  const canUpdate = perms.can(collection, 'update');

  const itemsQuery = useQuery({
    queryKey: ['items', collection, filterPayload, sort, page],
    queryFn: () =>
      client.items(collection as never).list({
        filter: filterPayload,
        sort: [`${sort.dir === 'desc' ? '-' : ''}${sort.field}`],
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    enabled: !perms.isLoading && canRead,
  });

  const fields = fieldsQuery.data ?? [];
  // Pick at most 5 visible non-hidden fields for the table preview AND drop
  // fields the principal cannot read (server already strips them, but we hide
  // the columns proactively so headers/sorts don't promise data we can't show).
  const visibleFields: FieldResource[] = useMemo(
    () =>
      fields
        .filter((f) => !f.hidden)
        .filter((f) => perms.fieldAllowed(collection, 'read', f.name))
        .slice(0, 5),
    [fields, perms, collection],
  );

  // Filter builder should only offer fields the user can read.
  const filterableFields = useMemo(
    () => fields.filter((f) => perms.fieldAllowed(collection, 'read', f.name)),
    [fields, perms, collection],
  );

  const total = itemsQuery.data?.meta?.total ?? 0;
  const rows = itemsQuery.data?.data ?? [];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSort = (field: string) => {
    setPage(0);
    setSort((prev) =>
      prev.field === field
        ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { field, dir: 'asc' },
    );
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase text-muted-foreground">
            <Link to="/" className="hover:underline">Content</Link>
            <span className="mx-1">/</span>
            <span>{collection}</span>
          </p>
          <h1 className="text-2xl font-semibold">{collection}</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Live Mode Toggle */}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground mr-2 cursor-pointer">
            <input
              type="checkbox"
              checked={liveMode}
              onChange={(e) => setLiveMode(e.target.checked)}
              className="accent-primary"
            />
            Live Mode
          </label>

          {/* Preset Switcher */}
          <div className="flex items-center rounded-md border text-xs">
            <select
              className="bg-transparent px-2 py-1 outline-none font-medium"
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                const preset = presetsQuery.data?.find((p) => p.id === id);
                if (preset) {
                  // Apply preset
                  if (preset.filter && Object.keys(preset.filter).length > 0) {
                    // Hacky for now: we can't easily reverse-compile filter JSON to FilterBuilder UI state,
                    // but in a real app we'd save the UI state in `layoutOptions` or similar.
                  }
                }
              }}
            >
              <option value="">Default View</option>
              {(presetsQuery.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.bookmark || 'Saved View'}</option>
              ))}
            </select>
            <button
              type="button"
              title="Save current view as Preset"
              onClick={() => {
                const name = prompt('Name for this preset?');
                if (name) {
                  client.presets.create({
                    collection,
                    bookmark: name,
                    filter: filterPayload,
                    layoutQuery: { sort: sort },
                  }).then(() => presetsQuery.refetch());
                }
              }}
              className="border-l px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Bookmark className="h-3.5 w-3.5" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
              showFilters && 'bg-accent',
            )}
          >
            <Filter className="h-3.5 w-3.5" />
            Filters {filters.length > 0 && <span className="text-primary">({filters.length})</span>}
          </button>
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => canUpdate && setShowBulk(true)}
              disabled={!canUpdate}
              title={canUpdate ? undefined : 'You do not have update permission on this collection.'}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
                canUpdate
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'cursor-not-allowed border-muted-foreground/20 text-muted-foreground',
              )}
            >
              {canUpdate ? <Code2 className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
              Edit raw ({selected.size})
            </button>
          )}
          <button
            type="button"
            onClick={() => itemsQuery.refetch()}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', itemsQuery.isFetching && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </header>

      {showFilters && (
        <div className="rounded-lg border bg-muted/20 p-3">
          <FilterBuilder
            fields={filterableFields}
            value={filters}
            onChange={(next) => {
              setFilters(next);
              setPage(0);
            }}
          />
        </div>
      )}

      {!perms.isLoading && !canRead && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <Lock className="h-4 w-4" />
          You do not have <code className="mx-1 rounded bg-background px-1 text-xs">read</code>
          permission on this collection.
        </div>
      )}

      {itemsQuery.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load items.
        </div>
      )}

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) rows.forEach((r) => next.add(r.id));
                    else rows.forEach((r) => next.delete(r.id));
                    setSelected(next);
                  }}
                />
              </th>
              <SortableTh label="id" field="id" sort={sort} onClick={toggleSort} />
              <SortableTh label="status" field="status" sort={sort} onClick={toggleSort} />
              {visibleFields.map((f) => (
                <SortableTh
                  key={f.id}
                  label={f.name}
                  field={f.name}
                  sort={sort}
                  onClick={toggleSort}
                />
              ))}
              <SortableTh label="updated" field="updated_at" sort={sort} onClick={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {itemsQuery.isLoading && (
              <tr><td colSpan={visibleFields.length + 4} className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!itemsQuery.isLoading && rows.length === 0 && (
              <tr><td colSpan={visibleFields.length + 4} className="px-4 py-6 text-center text-muted-foreground">No items match.</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t hover:bg-muted/20">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(row.id);
                      else next.delete(row.id);
                      setSelected(next);
                    }}
                  />
                </td>
                <td className="px-4 py-2 font-mono text-xs">
                  <Link
                    to="/content/$collection/$id"
                    params={{ collection, id: row.id }}
                    className="text-primary hover:underline"
                  >
                    {row.id.slice(0, 8)}…
                  </Link>
                </td>
                <td className="px-4 py-2"><StatusBadge status={row.status} /></td>
                {visibleFields.map((f) => {
                  const Display = resolveDisplay(f);
                  return (
                    <td key={f.id} className="px-4 py-2 text-muted-foreground">
                      <Display
                        field={f}
                        value={row.data?.[f.name]}
                        row={row.data as Record<string, unknown> | undefined}
                      />
                    </td>
                  );
                })}
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {new Date(row.updatedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {rows.length > 0
            ? `Showing ${page * PAGE_SIZE + 1}-${page * PAGE_SIZE + rows.length} of ${total}`
            : `0 of ${total}`}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="rounded-md border px-2 py-1 disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span>{page + 1} / {totalPages}</span>
          <button
            type="button"
            onClick={() => setPage((p) => p + 1)}
            disabled={page + 1 >= totalPages}
            className="rounded-md border px-2 py-1 disabled:opacity-40"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </footer>

      {showBulk && (
        <BulkRawEditor
          collection={collection}
          ids={Array.from(selected)}
          onClose={() => setShowBulk(false)}
          onSaved={() => {
            setShowBulk(false);
            setSelected(new Set());
            itemsQuery.refetch();
          }}
        />
      )}
    </div>
  );
}

function SortableTh({
  label,
  field,
  sort,
  onClick,
}: {
  label: string;
  field: string;
  sort: SortState;
  onClick: (field: string) => void;
}) {
  const active = sort.field === field;
  return (
    <th className="px-4 py-2 font-medium">
      <button
        type="button"
        onClick={() => onClick(field)}
        className={cn(
          'inline-flex items-center gap-1 hover:text-foreground',
          active && 'text-foreground',
        )}
      >
        {label}
        {active && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'published'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'archived'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-muted text-muted-foreground';
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] uppercase', tone)}>
      {status}
    </span>
  );
}

