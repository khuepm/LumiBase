import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Languages, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Add a locale (#714): the one-shot translation generator. Pick a locale,
 * the source locale and the collections; the CMS translates every missing
 * value (translation memory first, then the MT provider) into a REVIEW QUEUE.
 * Nothing reaches content until a reviewer approves it here.
 */

const BASE = '/api/v1/locale-generation';

export interface LocaleJob {
  id: string;
  locale: string;
  sourceLocale: string;
  collections: string[];
  includeUi: boolean;
  provider: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  counters: { items: number; suggestions: number; fromTm: number; fromMt: number; skipped: number; failed: number };
  review?: Record<string, number>;
  message: string | null;
  createdAt: string;
}

export interface TranslationSuggestion {
  id: string;
  kind: 'item' | 'ui';
  collection: string | null;
  itemId: string | null;
  field: string | null;
  uiKey: string | null;
  locale: string;
  sourceText: string;
  suggestedText: string;
  origin: 'tm' | 'mt';
  provider: string | null;
  tmScore: number | null;
  status: 'pending' | 'approved' | 'rejected' | 'stale';
}

const ACTIVE = new Set(['queued', 'running']);

function JobRow({ job, onAction }: { job: LocaleJob; onAction: (id: string, action: 'cancel' | 'resume') => void }) {
  const done = job.counters.suggestions;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-t py-2 text-sm first:border-t-0">
      <div>
        <span className="font-medium">
          {job.sourceLocale} → {job.locale}
        </span>{' '}
        <span className={cn('rounded px-1.5 py-0.5 text-xs', job.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-muted')}>
          {job.status}
        </span>
        <div className="text-xs text-muted-foreground">
          {job.collections.join(', ') || 'no collections'}
          {job.includeUi ? ' · UI strings' : ''} · {job.counters.items} items · {done} suggestions ({job.counters.fromTm} from memory,{' '}
          {job.counters.fromMt} machine) · {job.counters.failed} failed
        </div>
        {job.message && <div className="text-xs text-muted-foreground">{job.message}</div>}
      </div>
      {ACTIVE.has(job.status) ? (
        <button type="button" className="rounded-md border px-2 py-1 text-xs" onClick={() => onAction(job.id, 'cancel')}>
          Cancel
        </button>
      ) : job.status === 'failed' || job.status === 'cancelled' ? (
        <button type="button" className="rounded-md border px-2 py-1 text-xs" onClick={() => onAction(job.id, 'resume')}>
          Resume
        </button>
      ) : null}
    </li>
  );
}

function SuggestionRow({
  suggestion,
  onDecide,
  busy,
}: {
  suggestion: TranslationSuggestion;
  onDecide: (id: string, decision: 'approve' | 'reject', text?: string) => void;
  busy: boolean;
}) {
  const [text, setText] = useState(suggestion.suggestedText);
  const target = suggestion.kind === 'ui' ? `UI · ${suggestion.uiKey}` : `${suggestion.collection} · ${suggestion.itemId} · ${suggestion.field}`;
  return (
    <li className="space-y-1 border-t py-3 text-sm first:border-t-0">
      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{target}</span>
        <span>
          {suggestion.origin === 'tm' ? `translation memory${suggestion.tmScore !== null ? ` ${suggestion.tmScore}%` : ''}` : `machine · ${suggestion.provider ?? 'mt'}`}
        </span>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <p className="rounded bg-muted/50 p-2">{suggestion.sourceText}</p>
        <textarea
          aria-label={`Translation for ${target}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={2}
          className="w-full rounded border bg-background p-2"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide(suggestion.id, 'approve', text !== suggestion.suggestedText ? text : undefined)}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
        >
          <Check className="h-3 w-3" /> Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide(suggestion.id, 'reject')}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-50"
        >
          <X className="h-3 w-3" /> Reject
        </button>
      </div>
    </li>
  );
}

export function LocaleGeneratorPage() {
  const client = getApiClient();
  const qc = useQueryClient();
  const [locale, setLocale] = useState('');
  const [sourceLocale, setSourceLocale] = useState('en');
  const [chosen, setChosen] = useState<string[]>([]);
  const [includeUi, setIncludeUi] = useState(true);
  const [provider, setProvider] = useState('');
  const [reviewLocale, setReviewLocale] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const collectionsQuery = useQuery({
    queryKey: ['locale-generator', 'collections'],
    queryFn: async () => (await client.rawRequest<Array<{ name: string; system?: boolean }>>('/api/v1/collections')).data,
  });
  const jobsQuery = useQuery({
    queryKey: ['locale-generator', 'jobs'],
    queryFn: async () => (await client.rawRequest<LocaleJob[]>(`${BASE}/jobs`)).data,
    refetchInterval: (query) => ((query.state.data ?? []).some((job) => ACTIVE.has(job.status)) ? 3000 : false),
  });
  const activeReview = reviewLocale ?? jobsQuery.data?.[0]?.locale ?? null;
  const suggestionsQuery = useQuery({
    queryKey: ['locale-generator', 'suggestions', activeReview],
    enabled: Boolean(activeReview),
    queryFn: async () =>
      client.rawRequest<TranslationSuggestion[]>(
        `${BASE}/suggestions?${new URLSearchParams({ locale: activeReview!, status: 'pending', limit: '50' }).toString()}`,
      ),
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['locale-generator'] });

  const create = useMutation({
    mutationFn: () =>
      client.rawRequest<LocaleJob>(`${BASE}/jobs`, {
        method: 'POST',
        body: JSON.stringify({ locale: locale.trim(), sourceLocale: sourceLocale.trim(), collections: chosen, includeUi, ...(provider.trim() ? { provider: provider.trim() } : {}) }),
      }),
    onSuccess: (res) => {
      setReviewLocale(res.data.locale);
      setNotice(`Generating ${res.data.locale}. Suggestions appear in the review queue below as they are produced.`);
      refresh();
    },
  });
  const jobAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'cancel' | 'resume' }) =>
      client.rawRequest(`${BASE}/jobs/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' }),
    onSuccess: refresh,
  });
  const decide = useMutation({
    mutationFn: ({ id, decision, text }: { id: string; decision: 'approve' | 'reject'; text?: string }) =>
      client.rawRequest<{ status: string; reason?: string }>(`${BASE}/suggestions/${encodeURIComponent(id)}/decide`, {
        method: 'POST',
        body: JSON.stringify(decision === 'approve' ? { decision, ...(text !== undefined ? { text } : {}) } : { decision }),
      }),
    onSuccess: (res) => {
      if (res.data.status === 'stale') setNotice(`Not applied: ${res.data.reason ?? 'the content changed.'}`);
      refresh();
    },
  });
  const bulk = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      client.rawRequest<{ approved: number; rejected: number; stale: number; failed: number }>(`${BASE}/suggestions/decide-bulk`, {
        method: 'POST',
        body: JSON.stringify({ decision, locale: activeReview }),
      }),
    onSuccess: (res) => {
      const s = res.data;
      setNotice(`Approved ${s.approved}, rejected ${s.rejected}, stale ${s.stale}, failed ${s.failed}.`);
      refresh();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    create.mutate();
  };

  const collectionNames = (collectionsQuery.data ?? []).filter((c) => !c.system && !c.name.startsWith('lumibase_')).map((c) => c.name);
  const locales = [...new Set((jobsQuery.data ?? []).map((job) => job.locale))];
  const suggestions = suggestionsQuery.data?.data ?? [];
  const pendingTotal = (suggestionsQuery.data?.meta as { total?: number } | undefined)?.total ?? suggestions.length;
  const error = (create.error ?? jobAction.error ?? decide.error ?? bulk.error) as Error | null;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="inline-flex items-center gap-2 text-2xl font-semibold">
          <Languages className="h-6 w-6" /> Add a locale
        </h1>
        <p className="text-sm text-muted-foreground">
          Translates every missing value with translation memory, the glossary and your MT provider. Results wait in a review queue; nothing is
          published until a reviewer approves it.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-3 rounded-lg border p-4" aria-label="Locale generator">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="block text-muted-foreground">New locale</span>
            <input value={locale} onChange={(e) => setLocale(e.target.value)} placeholder="ja, pt-BR…" className="w-full rounded-md border bg-background px-2 py-1" aria-label="New locale" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-muted-foreground">Translate from</span>
            <input value={sourceLocale} onChange={(e) => setSourceLocale(e.target.value)} className="w-full rounded-md border bg-background px-2 py-1" aria-label="Source locale" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-muted-foreground">MT provider (optional)</span>
            <input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="default" className="w-full rounded-md border bg-background px-2 py-1" aria-label="MT provider" />
          </label>
        </div>
        <fieldset className="space-y-1 text-sm">
          <legend className="text-muted-foreground">Collections</legend>
          <div className="flex flex-wrap gap-3">
            {collectionNames.map((name) => (
              <label key={name} className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={chosen.includes(name)}
                  onChange={(e) => setChosen((current) => (e.target.checked ? [...current, name] : current.filter((n) => n !== name)))}
                />
                {name}
              </label>
            ))}
            {collectionNames.length === 0 && <span className="text-muted-foreground">No collections.</span>}
          </div>
        </fieldset>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={includeUi} onChange={(e) => setIncludeUi(e.target.checked)} /> Include UI strings
        </label>
        <div>
          <button type="submit" disabled={create.isPending || !locale.trim()} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
            Generate
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      <section className="rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-medium">Jobs</h2>
        {(jobsQuery.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No generation jobs yet.</p>
        ) : (
          <ul>
            {(jobsQuery.data ?? []).map((job) => (
              <JobRow key={job.id} job={job} onAction={(id, action) => jobAction.mutate({ id, action })} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">
            Review queue {activeReview ? `· ${activeReview} · ${pendingTotal} pending` : ''}
          </h2>
          <div className="flex items-center gap-2">
            {locales.length > 1 && (
              <select aria-label="Review locale" value={activeReview ?? ''} onChange={(e) => setReviewLocale(e.target.value)} className="rounded-md border bg-background px-2 py-1 text-sm">
                {locales.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            )}
            <button type="button" disabled={!activeReview || pendingTotal === 0 || bulk.isPending} onClick={() => bulk.mutate('approve')} className="rounded-md border px-2 py-1 text-xs disabled:opacity-50">
              Approve next 200
            </button>
            <button type="button" disabled={!activeReview || pendingTotal === 0 || bulk.isPending} onClick={() => bulk.mutate('reject')} className="rounded-md border px-2 py-1 text-xs disabled:opacity-50">
              Reject next 200
            </button>
          </div>
        </div>
        {suggestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waiting for review.</p>
        ) : (
          <ul>
            {suggestions.map((s) => (
              <SuggestionRow key={s.id} suggestion={s} busy={decide.isPending} onDecide={(id, decision, text) => decide.mutate({ id, decision, text })} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
