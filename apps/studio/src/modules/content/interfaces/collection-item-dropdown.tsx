import { useQuery } from '@tanstack/react-query';
import { ChevronDown, X } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { readOptions, type InterfaceComponent } from './types';

interface CollectionItemValue {
  collection: string;
  id: string;
}

interface CollectionItemDropdownOptions {
  /** Collections the user may pick from. */
  collections?: string[];
  /** Per-collection label field; falls back to `title`. */
  displayFields?: Record<string, string>;
}

function asValue(value: unknown): CollectionItemValue | null {
  if (value && typeof value === 'object') {
    const v = value as CollectionItemValue;
    if (typeof v.collection === 'string' && typeof v.id === 'string') return v;
  }
  return null;
}

/**
 * `collection-item-dropdown` — pick a single record from one of several
 * collections. Stores `{ collection, id }`.
 */
export const CollectionItemDropdownInterface: InterfaceComponent<CollectionItemValue> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<CollectionItemDropdownOptions>(field);
  const collections = opts.collections ?? [];
  const current = asValue(value);
  const client = getApiClient();
  const [collection, setCollection] = useState(current?.collection ?? collections[0] ?? '');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const displayField = opts.displayFields?.[collection] ?? 'title';

  const query = useQuery({
    enabled: open && !!collection,
    queryKey: ['collection-item-dropdown', collection, search, displayField],
    queryFn: async () =>
      client.items(collection as never).list({
        limit: 25,
        filter: search ? { [displayField]: { _contains: search } } : undefined,
      }),
  });

  const selectedLabelQuery = useQuery({
    enabled: !!current,
    queryKey: ['collection-item-label', current?.collection, current?.id],
    queryFn: async () => client.items(current!.collection as never).detail(current!.id),
  });

  if (collections.length === 0) {
    return (
      <p className="text-xs text-destructive">
        Missing `meta.options.collections` for collection-item field.
      </p>
    );
  }

  const selectedData = selectedLabelQuery.data?.data as Record<string, unknown> | undefined;
  const currentLabel = current
    ? selectedData
      ? String(selectedData[opts.displayFields?.[current.collection] ?? 'title'] ?? current.id)
      : `${current.id.slice(0, 8)}…`
    : null;

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <select
          value={collection}
          disabled={disabled}
          onChange={(e) => setCollection(e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-xs disabled:opacity-50"
        >
          {collections.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <div className="relative flex-1">
          <button
            type="button"
            disabled={disabled}
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center justify-between rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
          >
            <span className={current ? '' : 'text-muted-foreground'}>
              {current ? `${current.collection}: ${currentLabel}` : `Pick from ${collection}…`}
            </span>
            <span className="flex items-center gap-1">
              {current && (
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
                placeholder={`Search by ${displayField}…`}
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
                        onChange({ collection, id: row.id });
                        setOpen(false);
                      }}
                      className="w-full px-2 py-1 text-left text-xs hover:bg-accent"
                    >
                      <span className="font-mono text-muted-foreground">{row.id.slice(0, 6)}…</span>
                      <span className="ml-2">{String(row.data?.[displayField] ?? '—')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
