import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { TmEntry, TmSource } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';

/**
 * Translation memory manager (translation-memory-ui Req 1–2).
 *
 * Surfaces the TM entry store (list / filter / edit / delete with pagination)
 * plus the two pipelines built on it — fuzzy lookup (TM only) and full
 * translate (TM → glossary → MT provider). The try-out panels let an operator
 * see exactly what an agent translating content would get.
 */

const PAGE_SIZE = 25;
const SOURCES: TmSource[] = ['human', 'mt', 'imported'];

function UpsertForm({ onClose }: { onClose: () => void }) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    sourceLang: 'en',
    targetLang: 'vi',
    sourceText: '',
    targetText: '',
  });

  const mutation = useMutation({
    mutationFn: () => client.tm.upsert({ ...form, source: 'human' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tm-entries'] });
      onClose();
    },
  });

  const set =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <div className="space-y-2 rounded-lg border bg-background p-4">
      <h3 className="text-sm font-semibold">Add entry</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Source lang</span>
          <input value={form.sourceLang} onChange={set('sourceLang')} aria-label="Entry source lang" className="w-full rounded-md border bg-background px-2 py-1.5 font-mono" />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Target lang</span>
          <input value={form.targetLang} onChange={set('targetLang')} aria-label="Entry target lang" className="w-full rounded-md border bg-background px-2 py-1.5 font-mono" />
        </label>
        <label className="text-xs col-span-2 sm:col-span-4">
          <span className="mb-1 block text-muted-foreground">Source text *</span>
          <textarea value={form.sourceText} onChange={set('sourceText')} rows={2} aria-label="Entry source text" className="w-full rounded-md border bg-background px-2 py-1.5" />
        </label>
        <label className="text-xs col-span-2 sm:col-span-4">
          <span className="mb-1 block text-muted-foreground">Target text *</span>
          <textarea value={form.targetText} onChange={set('targetText')} rows={2} aria-label="Entry target text" className="w-full rounded-md border bg-background px-2 py-1.5" />
        </label>
      </div>
      {mutation.isError && (
        <p className="text-xs text-destructive">
          {mutation.error instanceof Error ? mutation.error.message : 'Save failed.'}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || !form.sourceText.trim() || !form.targetText.trim()}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {mutation.isPending ? 'Saving…' : 'Save entry'}
        </button>
        <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted">
          Cancel
        </button>
      </div>
    </div>
  );
}

function LookupPanel() {
  const client = getApiClient();
  const [query, setQuery] = useState('');
  const [sourceLang, setSourceLang] = useState('en');
  const [targetLang, setTargetLang] = useState('vi');

  const mutation = useMutation({
    mutationFn: () => client.tm.lookup({ query, sourceLang, targetLang }),
  });

  return (
    <section className="rounded-lg border bg-background p-4">
      <h3 className="mb-2 text-sm font-semibold">Fuzzy lookup</h3>
      <div className="space-y-2">
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          rows={2}
          placeholder="Text to look up…"
          aria-label="Lookup query"
          className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
        />
        <div className="flex items-center gap-2">
          <input value={sourceLang} onChange={(e) => setSourceLang(e.target.value)} aria-label="Lookup source lang" className="w-14 rounded-md border bg-background px-2 py-1 font-mono text-xs" />
          <span className="text-xs text-muted-foreground">→</span>
          <input value={targetLang} onChange={(e) => setTargetLang(e.target.value)} aria-label="Lookup target lang" className="w-14 rounded-md border bg-background px-2 py-1 font-mono text-xs" />
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !query.trim()}
            className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {mutation.isPending ? 'Looking up…' : 'Lookup'}
          </button>
        </div>
        {mutation.isError && (
          <p className="text-xs text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : 'Lookup failed.'}
          </p>
        )}
        {mutation.isSuccess &&
          (mutation.data ? (
            <div className="rounded-md border bg-muted/30 p-2 text-xs">
              <p className="font-medium">{mutation.data.targetText}</p>
              <p className="text-muted-foreground">similarity {mutation.data.similarity}%</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No match above threshold.</p>
          ))}
      </div>
    </section>
  );
}

function TranslatePanel() {
  const client = getApiClient();
  const [text, setText] = useState('');
  const [from, setFrom] = useState('en');
  const [to, setTo] = useState('vi');

  const mutation = useMutation({
    mutationFn: () => client.tm.translate({ text, from, to }),
  });

  return (
    <section className="rounded-lg border bg-background p-4">
      <h3 className="mb-2 text-sm font-semibold">Translate (TM → glossary → provider)</h3>
      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Text to translate…"
          aria-label="Translate text"
          className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
        />
        <div className="flex items-center gap-2">
          <input value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Translate from" className="w-14 rounded-md border bg-background px-2 py-1 font-mono text-xs" />
          <span className="text-xs text-muted-foreground">→</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} aria-label="Translate to" className="w-14 rounded-md border bg-background px-2 py-1 font-mono text-xs" />
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !text.trim()}
            className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {mutation.isPending ? 'Translating…' : 'Translate'}
          </button>
        </div>
        {mutation.isError && (
          <p className="text-xs text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : 'Translate failed.'}
          </p>
        )}
        {mutation.isSuccess && (
          <pre className="overflow-x-auto rounded-md border bg-muted/30 p-2 font-mono text-xs">
            {JSON.stringify(mutation.data.data, null, 2)}
          </pre>
        )}
      </div>
    </section>
  );
}

function SourceBadge({ source }: { source: string }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
      {source}
    </span>
  );
}

function EntryRow({ row }: { row: TmEntry }) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [targetText, setTargetText] = useState(row.targetText);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['tm-entries'] });

  const saveMutation = useMutation({
    mutationFn: () => client.tm.update(row.id, { targetText }),
    onSuccess: () => {
      invalidate();
      setEditing(false);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () => client.tm.delete(row.id),
    onSuccess: invalidate,
  });

  return (
    <tr className="border-b align-top last:border-0">
      <td className="py-2 font-mono text-xs">
        {row.sourceLang}→{row.targetLang}
      </td>
      <td className="max-w-xs truncate py-2 text-xs" title={row.sourceText}>
        {row.sourceText}
      </td>
      <td className="max-w-xs py-2 text-xs">
        {editing ? (
          <textarea
            value={targetText}
            onChange={(e) => setTargetText(e.target.value)}
            rows={2}
            aria-label={`Edit target for ${row.id}`}
            className="w-full rounded-md border bg-background px-2 py-1 text-xs"
          />
        ) : (
          <span className="block truncate" title={row.targetText}>
            {row.targetText}
          </span>
        )}
      </td>
      <td className="py-2 text-xs">{row.quality ?? '—'}</td>
      <td className="py-2 text-xs">
        <SourceBadge source={row.source} />
        {row.provider ? <span className="ml-1 text-muted-foreground">({row.provider})</span> : null}
      </td>
      <td className="py-2 text-right">
        {editing ? (
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !targetText.trim()}
              aria-label={`Save TM entry ${row.id}`}
              className="rounded p-1 text-muted-foreground hover:text-primary disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setTargetText(row.targetText);
                setEditing(false);
              }}
              aria-label={`Cancel editing ${row.id}`}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={`Edit TM entry ${row.id}`}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => deleteMutation.mutate()}
              aria-label={`Delete TM entry ${row.id}`}
              className="rounded p-1 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

export function TranslationMemoryPage() {
  const client = getApiClient();
  const [adding, setAdding] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('');
  const [targetFilter, setTargetFilter] = useState('');
  const [entrySource, setEntrySource] = useState<TmSource | ''>('');
  const [page, setPage] = useState(0);

  const entriesQuery = useQuery({
    queryKey: ['tm-entries', sourceFilter, targetFilter, entrySource, page],
    queryFn: () =>
      client.tm.list({
        source: sourceFilter || undefined,
        target: targetFilter || undefined,
        entrySource: entrySource || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
  });

  const entries = entriesQuery.data?.data ?? [];
  const total = (entriesQuery.data?.meta?.total as number | undefined) ?? entries.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetPage = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setPage(0);
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Translation memory</h1>
          <p className="text-sm text-muted-foreground">
            Reusable translations feeding the MT pipeline — what agents and editors get when
            translating content.
          </p>
        </div>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" /> Add entry
          </button>
        )}
      </div>

      {adding && <UpsertForm onClose={() => setAdding(false)} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <LookupPanel />
        <TranslatePanel />
      </div>

      <div className="rounded-lg border bg-background p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Entries</h3>
          <input
            value={sourceFilter}
            onChange={(e) => resetPage(setSourceFilter)(e.target.value)}
            placeholder="source lang"
            aria-label="Filter source lang"
            className="w-24 rounded-md border bg-background px-2 py-1 font-mono text-xs"
          />
          <input
            value={targetFilter}
            onChange={(e) => resetPage(setTargetFilter)(e.target.value)}
            placeholder="target lang"
            aria-label="Filter target lang"
            className="w-24 rounded-md border bg-background px-2 py-1 font-mono text-xs"
          />
          <select
            value={entrySource}
            onChange={(e) => resetPage(setEntrySource)(e.target.value as TmSource | '')}
            aria-label="Filter origin"
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            <option value="">all origins</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {entriesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading entries…</p>
        ) : entriesQuery.isError ? (
          <p className="text-sm text-destructive">
            {entriesQuery.error instanceof Error ? entriesQuery.error.message : 'Failed to load.'}
          </p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entries for this filter.</p>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2">Pair</th>
                  <th>Source</th>
                  <th>Target</th>
                  <th>Quality</th>
                  <th>Origin</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {entries.map((row) => (
                  <EntryRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {total} entr{total === 1 ? 'y' : 'ies'} · page {page + 1} of {pageCount}
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-40"
                >
                  Prev
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => (p + 1 < pageCount ? p + 1 : p))}
                  disabled={page + 1 >= pageCount}
                  className="rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
