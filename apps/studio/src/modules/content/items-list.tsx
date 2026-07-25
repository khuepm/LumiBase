import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, Bookmark, ChevronLeft, ChevronRight, Code2, Filter, Lock, RefreshCw, Save } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FieldResource } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/lib/use-permissions';
import { useRealtimeSubscription } from '@/hooks/use-realtime';
import { deleteBookmark, getEffectivePreset, saveUserView, viewDiffers, type ScopedViewPreset } from '@/modules/presets/api';
import { BookmarkSwitcher } from '@/modules/presets/bookmark-switcher';
import { SaveBookmarkDialog } from '@/modules/presets/save-bookmark-dialog';
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
  const [activeBookmarkId, setActiveBookmarkId] = useState<string | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
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

  const filterPayload = useMemo(() => compileFilter(filters), [filters]);

  // ── Effective preset (presets-inheritance) ──────────────────────────────────
  // Apply the effective default view (user > role-chain > global) on mount, then
  // debounce-persist the user's default when their view drifts from it.
  const appliedRef = useRef(false);
  const effectiveRef = useRef<{ sort?: SortState; filter?: Record<string, unknown> }>({});
  const effectiveQuery = useQuery({
    queryKey: ['preset-effective', collection],
    queryFn: () => getEffectivePreset(collection),
  });

  useEffect(() => {
    if (appliedRef.current || effectiveQuery.data === undefined) return;
    appliedRef.current = true;
    const p = effectiveQuery.data;
    if (p) {
      const savedSort = (p.layoutQuery as { sort?: SortState })?.sort;
      if (savedSort?.field) setSort(savedSort);
      effectiveRef.current = { sort: savedSort, filter: p.filter };
    }
  }, [effectiveQuery.data]);

  // Debounced save of the user's DEFAULT view when it drifts from effective.
  // Skipped while a named bookmark is active (that's a transient view, not the
  // user's default) so switching to a bookmark never overwrites the default.
  useEffect(() => {
    if (!appliedRef.current || activeBookmarkId !== null) return;
    const current = { layoutQuery: { sort }, filter: filterPayload };
    const baseline = { layoutQuery: { sort: effectiveRef.current.sort }, filter: effectiveRef.current.filter ?? {} };
    if (!viewDiffers(current, baseline)) return;
    const timer = setTimeout(() => {
      void saveUserView({ collection, filter: filterPayload, layoutQuery: { sort } }).catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [sort, filterPayload, collection, activeBookmarkId]);

  // Apply a bookmark/preset's saved view (sort restored from layoutQuery).
  const applyPreset = (p: ScopedViewPreset) => {
    const savedSort = (p.layoutQuery as { sort?: SortState })?.sort;
    if (savedSort?.field) setSort(savedSort);
    setPage(0);
  };
  // Re-apply the effective default view (used by "Default view").
  const applyEffective = () => {
    const savedSort = effectiveRef.current.sort;
    if (savedSort?.field) setSort(savedSort);
    setPage(0);
  };
  // "Reset to default": drop the user's own default preset (if any), then
  // re-resolve the effective view (falls back to role/global).
  const resetToDefault = async () => {
    setActiveBookmarkId(null);
    const own = (effectiveQuery.data?.sourceScope === 'user' && effectiveQuery.data) || null;
    if (own) {
      await deleteBookmark(own.id).catch(() => {});
    }
    appliedRef.current = false;
    await effectiveQuery.refetch();
    void queryClient.invalidateQueries({ queryKey: ['preset-bookmarks', collection] });
  };

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

          {/* Preset / bookmark switcher (presets-inheritance) */}
          <div className="flex items-center gap-1">
            <BookmarkSwitcher
              collection={collection}
              activeBookmarkId={activeBookmarkId}
              onSelectDefault={() => {
                setActiveBookmarkId(null);
                applyEffective();
              }}
              onSelectBookmark={(b) => {
                setActiveBookmarkId(b.id);
                applyPreset(b);
              }}
              onResetToDefault={() => void resetToDefault()}
            />
            <button
              type="button"
              title="Save current view as bookmark"
              onClick={() => setSaveDialogOpen(true)}
              className="rounded-md border px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
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

      {saveDialogOpen && (
        <SaveBookmarkDialog
          collection={collection}
          view={{ filter: filterPayload, layoutQuery: { sort } }}
          canManageShared={perms.isAdmin}
          onClose={() => setSaveDialogOpen(false)}
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

