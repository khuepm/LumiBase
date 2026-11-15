import { useQuery } from '@tanstack/react-query';
import { ChevronDown, X } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { readOptions, type InterfaceComponent } from './types';

interface RelationOptions {
  /** Target collection name; mandatory for the picker to render. */
  collection?: string;
  /** Field name to display as label (default: `id`). */
  displayField?: string;
  /** Initial search filter applied when opening the picker. */
  filterStatus?: string;
}

/**
 * `relation-m2o` — single-select picker for many-to-one references.
 * Stores the related item's id as the cell value; the BE relation engine
 * (Phase B) joins on read when callers request `?fields=author.*` style paths.
 */
export const RelationM2OInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<RelationOptions>(field);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const client = getApiClient();
  const collection = opts.collection;

  const query = useQuery({
    enabled: !!collection && open,
    queryKey: ['relation-m2o', collection, opts.displayField, search],
    queryFn: async () =>
      client.items(collection as never).list({
        limit: 25,
        filter: search
          ? { [opts.displayField ?? 'id']: { _contains: search } }
          : undefined,
        status: opts.filterStatus,
      }),
  });

  if (!collection) {
    return (
      <p className="text-xs text-destructive">
        Missing `meta.options.collection` for relation field.
      </p>
    );
  }

  const display = opts.displayField ?? 'id';
  const selected = query.data?.data.find((r) => r.id === value);
  const label = selected ? String(selected.data?.[display] ?? selected.id) : null;

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
      >
        <span className={value ? '' : 'text-muted-foreground'}>
          {value ? label ?? `${value.slice(0, 8)}…` : `Pick a ${collection}…`}
        </span>
        <span className="flex items-center gap-1">
          {value && (
            <X
              className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
            />
          )}
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      </button>

      {open && (
        <div className="absolute z-10 mt-1 w-full rounded-md border bg-background shadow-lg">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search by ${display}…`}
            className="w-full border-b bg-transparent px-2 py-1 text-xs focus:outline-none"
          />
          <ul className="max-h-60 overflow-y-auto py-1">
            {query.isLoading && (
              <li className="px-2 py-1 text-xs text-muted-foreground">Loading…</li>
            )}
            {query.data?.data.length === 0 && (
              <li className="px-2 py-1 text-xs text-muted-foreground">No matches.</li>
            )}
            {query.data?.data.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(row.id);
                    setOpen(false);
                  }}
                  className="w-full px-2 py-1 text-start text-xs hover:bg-accent"
                >
                  <span className="font-mono text-muted-foreground">
                    {row.id.slice(0, 6)}…
                  </span>
                  <span className="ms-2">{String(row.data?.[display] ?? '—')}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
