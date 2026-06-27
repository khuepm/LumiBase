import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { readOptions, type InterfaceComponent } from './types';

interface AutocompleteOptions {
  /** URL template; `{{value}}` is replaced with the URL-encoded search term. */
  url?: string;
  /** Dot-path to the results array in the JSON response (e.g. `data.items`). */
  resultsPath?: string;
  /** Dot-path (relative to each result) to the value to store. */
  valuePath?: string;
  /** Dot-path (relative to each result) to the label to display. */
  textPath?: string;
  placeholder?: string;
}

/** Resolve a dot-path against an unknown JSON value. */
function dig(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/**
 * `input-autocomplete-api` — free-text input whose suggestions are fetched from
 * an external API as the user types. Stores the chosen/typed value as a string.
 */
export const InputAutocompleteApiInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<AutocompleteOptions>(field);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  const query = useQuery({
    enabled: open && !!opts.url && search.trim().length > 0,
    queryKey: ['autocomplete-api', opts.url, search],
    queryFn: async () => {
      const url = (opts.url ?? '').replace('{{value}}', encodeURIComponent(search));
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const json: unknown = await res.json();
      const results = dig(json, opts.resultsPath);
      const rows = Array.isArray(results) ? results : [];
      return rows.map((row) => ({
        value: String(dig(row, opts.valuePath) ?? ''),
        text: String(dig(row, opts.textPath) ?? dig(row, opts.valuePath) ?? ''),
      }));
    },
  });

  if (!opts.url) {
    return <p className="text-xs text-destructive">Missing `meta.options.url` for autocomplete field.</p>;
  }

  return (
    <div className="relative">
      <input
        type="text"
        disabled={disabled}
        value={open ? search : typeof value === 'string' ? value : ''}
        placeholder={opts.placeholder ?? 'Type to search…'}
        onFocus={() => {
          setSearch(typeof value === 'string' ? value : '');
          setOpen(true);
        }}
        onChange={(e) => {
          setSearch(e.target.value);
          onChange(e.target.value === '' ? null : e.target.value);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
      />
      {open && search.trim().length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-md border bg-background shadow-lg">
          <ul className="max-h-60 overflow-y-auto py-1">
            {query.isLoading && <li className="px-2 py-1 text-xs text-muted-foreground">Loading…</li>}
            {query.error && <li className="px-2 py-1 text-xs text-destructive">Request failed.</li>}
            {query.data?.length === 0 && (
              <li className="px-2 py-1 text-xs text-muted-foreground">No matches.</li>
            )}
            {query.data?.map((row, i) => (
              <li key={`${row.value}-${i}`}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(row.value);
                    setSearch(row.value);
                    setOpen(false);
                  }}
                  className="w-full px-2 py-1 text-left text-xs hover:bg-accent"
                >
                  {row.text}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
