import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { getActiveSite, getActiveToken } from '@/lib/api';

/**
 * Translation memory manager (studio-ops-ui task 2; Req 2).
 *
 * Surfaces /api/v1/tm: the TM entry store plus the two pipelines built on
 * it — fuzzy lookup (TM only) and full translate (TM → glossary → MT
 * provider). The two try-out panels exist so an operator can see exactly
 * what an agent translating content would get.
 */

interface TmRow {
  id: string;
  sourceLang: string;
  targetLang: string;
  sourceText: string;
  targetText: string;
  quality: number | null;
  source: string;
  provider: string | null;
  context: string | null;
}

async function tmFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await fetch(`/api/v1/tm${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'x-site-id': site } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    errors?: Array<{ code: string; message: string }>;
  };
  if (!res.ok) {
    throw new Error(body.errors?.[0]?.message ?? `Request failed: ${res.status}`);
  }
  return body.data as T;
}

function UpsertForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    sourceLang: 'en',
    targetLang: 'vi',
    sourceText: '',
    targetText: '',
  });

  const mutation = useMutation({
    mutationFn: () => tmFetch('', { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tm-entries'] });
      onClose();
    },
  });

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
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
  const [query, setQuery] = useState('');
  const [sourceLang, setSourceLang] = useState('en');
  const [targetLang, setTargetLang] = useState('vi');

  const mutation = useMutation({
    mutationFn: () =>
      tmFetch<{ match: { targetText: string; score: number } | null }>('/lookup', {
        method: 'POST',
        body: JSON.stringify({ query, sourceLang, targetLang }),
      }),
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
          (mutation.data.match ? (
            <div className="rounded-md border bg-muted/30 p-2 text-xs">
              <p className="font-medium">{mutation.data.match.targetText}</p>
              <p className="text-muted-foreground">score {mutation.data.match.score}</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No match above threshold.</p>
          ))}
      </div>
    </section>
  );
}

function TranslatePanel() {
  const [text, setText] = useState('');
  const [from, setFrom] = useState('en');
  const [to, setTo] = useState('vi');

  const mutation = useMutation({
    mutationFn: () =>
      tmFetch<Record<string, unknown>>('/translate', {
        method: 'POST',
        body: JSON.stringify({ text, from, to }),
      }),
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
            {JSON.stringify(mutation.data, null, 2)}
          </pre>
        )}
      </div>
    </section>
  );
}

const PAGE_SIZE = 50;

/** Fetch entries + pagination meta (the plain `tmFetch` drops `meta`). */
async function fetchTmPage(params: string): Promise<{ data: TmRow[]; meta: { total: number; limit: number; offset: number } }> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await fetch(`/api/v1/tm${params}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'x-site-id': site } : {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: TmRow[];
    meta?: { total: number; limit: number; offset: number };
    errors?: Array<{ message: string }>;
  };
  if (!res.ok) throw new Error(body.errors?.[0]?.message ?? `Request failed: ${res.status}`);
  return { data: body.data ?? [], meta: body.meta ?? { total: 0, limit: PAGE_SIZE, offset: 0 } };
}

export function TranslationMemoryPage() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('');
  const [targetFilter, setTargetFilter] = useState('');
  const [page, setPage] = useState(0);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ targetText: string; quality: string }>({ targetText: '', quality: '' });

  const entriesQuery = useQuery({
    queryKey: ['tm-entries', sourceFilter, targetFilter, page],
    queryFn: () => {
      const params = new URLSearchParams();
      if (sourceFilter) params.set('source', sourceFilter);
      if (targetFilter) params.set('target', targetFilter);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      return fetchTmPage(`?${params.toString()}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => tmFetch(`/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tm-entries'] }),
  });

  const editMutation = useMutation({
    mutationFn: (input: { id: string; targetText: string; quality?: number }) =>
      tmFetch(`/${input.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ targetText: input.targetText, ...(input.quality != null ? { quality: input.quality } : {}) }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tm-entries'] });
      setEditId(null);
    },
  });

  const startEdit = (row: TmRow) => {
    setEditId(row.id);
    setEditForm({ targetText: row.targetText, quality: row.quality != null ? String(row.quality) : '' });
  };

  const entries = entriesQuery.data?.data ?? [];
  const meta = entriesQuery.data?.meta ?? { total: 0, limit: PAGE_SIZE, offset: 0 };
  const totalPages = Math.max(1, Math.ceil(meta.total / PAGE_SIZE));

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
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-semibold">Entries</h3>
          <input
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            placeholder="source lang"
            aria-label="Filter source lang"
            className="w-24 rounded-md border bg-background px-2 py-1 font-mono text-xs"
          />
          <input
            value={targetFilter}
            onChange={(e) => setTargetFilter(e.target.value)}
            placeholder="target lang"
            aria-label="Filter target lang"
            className="w-24 rounded-md border bg-background px-2 py-1 font-mono text-xs"
          />
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
                <tr key={row.id} className="border-b align-top last:border-0">
                  <td className="py-2 font-mono text-xs">
                    {row.sourceLang}→{row.targetLang}
                  </td>
                  <td className="max-w-xs truncate py-2 text-xs" title={row.sourceText}>
                    {row.sourceText}
                  </td>
                  <td className="max-w-xs py-2 text-xs">
                    {editId === row.id ? (
                      <input
                        value={editForm.targetText}
                        onChange={(e) => setEditForm((f) => ({ ...f, targetText: e.target.value }))}
                        aria-label="Edit target text"
                        className="w-full rounded border px-2 py-1 text-xs"
                      />
                    ) : (
                      <span className="block truncate" title={row.targetText}>{row.targetText}</span>
                    )}
                  </td>
                  <td className="py-2 text-xs">
                    {editId === row.id ? (
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={editForm.quality}
                        onChange={(e) => setEditForm((f) => ({ ...f, quality: e.target.value }))}
                        aria-label="Edit quality"
                        className="w-16 rounded border px-1 py-1 text-xs"
                      />
                    ) : (
                      (row.quality ?? '—')
                    )}
                  </td>
                  <td className="py-2 text-xs">
                    {row.source}
                    {row.provider ? ` (${row.provider})` : ''}
                  </td>
                  <td className="py-2 text-right">
                    {editId === row.id ? (
                      <span className="inline-flex gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            editMutation.mutate({
                              id: row.id,
                              targetText: editForm.targetText,
                              quality: editForm.quality ? Number(editForm.quality) : undefined,
                            })
                          }
                          className="rounded bg-primary px-2 py-0.5 text-[11px] text-primary-foreground"
                        >
                          Save
                        </button>
                        <button type="button" onClick={() => setEditId(null)} className="rounded border px-2 py-0.5 text-[11px]">
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <span className="inline-flex gap-1">
                        <button
                          type="button"
                          onClick={() => startEdit(row)}
                          aria-label={`Edit TM entry ${row.id}`}
                          className="rounded p-1 text-muted-foreground hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteMutation.mutate(row.id)}
                          aria-label={`Delete TM entry ${row.id}`}
                          className="rounded p-1 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {meta.total > PAGE_SIZE && (
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {meta.offset + 1}–{Math.min(meta.offset + PAGE_SIZE, meta.total)} of {meta.total}
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded border px-2 py-1 disabled:opacity-40"
              >
                Prev
              </button>
              <span>
                Page {page + 1} / {totalPages}
              </span>
              <button
                type="button"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded border px-2 py-1 disabled:opacity-40"
              >
                Next
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
