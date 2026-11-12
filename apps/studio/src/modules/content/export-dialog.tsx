import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { FieldResource, ItemFilter } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { useSiteLocales } from './use-site-locales';
import { TRANSLATABLE_INTERFACE } from './translatable-fields';

/**
 * Export dialog (#727): pick format, fields, locales and relation mode, then
 * download `GET /items/:collection/export`. The server applies the caller's
 * read permission; the current list filter is passed through when ticked.
 */

export type ExportFormat = 'csv' | 'json';
export type RelationMode = 'id' | 'slug' | 'embed';

export interface ExportDialogProps {
  collection: string;
  fields: FieldResource[];
  /** Current list filter; offered as "Only rows matching the current filters". */
  filter?: ItemFilter;
  onClose: () => void;
}

/** Fields that hold a value of their own (alias/presentation fields do not). */
export function exportableFields(fields: FieldResource[]): FieldResource[] {
  return fields.filter((f) => f.type !== 'alias');
}

/** Build the SDK export options from the dialog state. */
export function buildExportParams(input: {
  format: ExportFormat;
  allFields: string[];
  selectedFields: string[];
  locales: string[];
  allLocales: string[];
  relations: RelationMode;
  filter?: ItemFilter;
  useFilter: boolean;
}) {
  const everyField = input.selectedFields.length === input.allFields.length;
  const everyLocale = input.locales.length === input.allLocales.length;
  return {
    format: input.format,
    // Omit when everything is selected so new fields are not silently dropped.
    ...(everyField ? {} : { fields: input.selectedFields }),
    ...(everyLocale && input.format === 'json' ? {} : { locales: input.locales }),
    relations: input.relations,
    ...(input.useFilter && input.filter ? { filter: input.filter } : {}),
  };
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** `attachment; filename="products-2026-11-12.csv"` → `products-2026-11-12.csv`. */
export function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition?.match(/filename="([^"]+)"/);
  return match?.[1] ?? fallback;
}

export function ExportDialog({ collection, fields, filter, onClose }: ExportDialogProps) {
  const client = getApiClient();
  const siteLocales = useSiteLocales();
  const candidates = useMemo(() => exportableFields(fields), [fields]);
  const hasTranslatable = candidates.some((f) => f.interface === TRANSLATABLE_INTERFACE);

  const [format, setFormat] = useState<ExportFormat>('csv');
  const [selected, setSelected] = useState<string[]>(() => candidates.map((f) => f.name));
  // `null` = every site locale; the setting loads async, so do not snapshot it.
  const [localeSel, setLocaleSel] = useState<string[] | null>(null);
  const locales = localeSel ?? siteLocales;
  const [relations, setRelations] = useState<RelationMode>('id');
  const [useFilter, setUseFilter] = useState(Boolean(filter));

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const mutation = useMutation({
    mutationFn: async () => {
      const params = buildExportParams({
        format,
        allFields: candidates.map((f) => f.name),
        selectedFields: candidates.map((f) => f.name).filter((n) => selected.includes(n)),
        locales: siteLocales.filter((l) => locales.includes(l)),
        allLocales: siteLocales,
        relations,
        filter,
        useFilter,
      });
      const res = await client.items(collection as never).export(params);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(await res.blob(), filenameFrom(res.headers.get('content-disposition'), `${collection}-${stamp}.${format}`));
    },
    onSuccess: onClose,
  });

  const nothingSelected = selected.length === 0 || (hasTranslatable && locales.length === 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-labelledby="export-title">
      <div className="max-h-[90vh] w-full max-w-md space-y-4 overflow-y-auto rounded-lg border bg-background p-5 shadow-lg">
        <h2 id="export-title" className="text-base font-semibold">
          Export {collection}
        </h2>

        <fieldset className="space-y-1">
          <legend className="text-sm text-muted-foreground">Format</legend>
          <div className="flex gap-4 text-sm">
            {(['csv', 'json'] as const).map((f) => (
              <label key={f} className="flex items-center gap-1.5">
                <input type="radio" name="export-format" checked={format === f} onChange={() => setFormat(f)} />
                {f.toUpperCase()}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-1">
          <legend className="flex w-full items-center justify-between text-sm text-muted-foreground">
            Fields
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => setSelected(selected.length === candidates.length ? [] : candidates.map((f) => f.name))}
            >
              {selected.length === candidates.length ? 'Select none' : 'Select all'}
            </button>
          </legend>
          <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto rounded-md border p-2 text-sm">
            {candidates.map((f) => (
              <label key={f.name} className="flex items-center gap-1.5 truncate">
                <input type="checkbox" checked={selected.includes(f.name)} onChange={() => setSelected(toggle(selected, f.name))} />
                <span className="truncate">{f.name}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">id, status, sort and timestamps are always included.</p>
        </fieldset>

        {hasTranslatable && (
          <fieldset className="space-y-1">
            <legend className="text-sm text-muted-foreground">Locales</legend>
            <div className="flex flex-wrap gap-3 text-sm">
              {siteLocales.map((l) => (
                <label key={l} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={locales.includes(l)} onChange={() => setLocaleSel(toggle(locales, l))} />
                  {l}
                </label>
              ))}
            </div>
            {format === 'csv' && <p className="text-xs text-muted-foreground">CSV writes one column per locale, e.g. title.vi.</p>}
          </fieldset>
        )}

        <label className="block space-y-1">
          <span className="text-sm text-muted-foreground">Relations</span>
          <select
            className="w-full rounded-md border px-3 py-1.5 text-sm"
            value={relations}
            onChange={(e) => setRelations(e.target.value as RelationMode)}
          >
            <option value="id">IDs (re-importable)</option>
            <option value="slug">Slugs of related items</option>
            <option value="embed">Embed related items</option>
          </select>
        </label>

        {filter && (
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={useFilter} onChange={(e) => setUseFilter(e.target.checked)} />
            Only rows matching the current filters
          </label>
        )}

        {mutation.isError && <p className="text-sm text-destructive">{(mutation.error as Error).message}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-md px-3 py-1.5 text-sm hover:bg-muted" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={nothingSelected || mutation.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
