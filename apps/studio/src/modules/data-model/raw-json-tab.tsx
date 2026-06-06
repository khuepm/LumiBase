import Editor from '@monaco-editor/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, GitCompareArrows, Save } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';

interface RawJsonTabProps {
  collectionName: string;
}

type SchemaDiffRisk = 'low' | 'medium' | 'high';

interface SchemaDiffEntry {
  name?: string;
  field?: string;
  identity?: string;
  type?: string;
  changes?: string[];
  risk?: SchemaDiffRisk;
  runtimeImpact?: string[];
}

interface SchemaDiff {
  risk: SchemaDiffRisk;
  runtimeImpact: string[];
  collection: {
    added: string[];
    removed: string[];
    changed: SchemaDiffEntry[];
  };
  fields: {
    added: SchemaDiffEntry[];
    removed: SchemaDiffEntry[];
    changed: SchemaDiffEntry[];
  };
  relations: {
    added: SchemaDiffEntry[];
    removed: SchemaDiffEntry[];
    changed: SchemaDiffEntry[];
  };
}

/**
 * Live JSON pane (Monaco) for the collection schema. Two-way sync:
 *  - Loads compiled schema on mount.
 *  - Diff preview + apply via PUT /collections/:name/schema.
 */
export function RawJsonTab({ collectionName }: RawJsonTabProps) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string>('');
  const [diff, setDiff] = useState<SchemaDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  const compiledQuery = useQuery({
    queryKey: ['compiled', collectionName],
    queryFn: async () => {
      const res = await client.request<unknown>(
        `/api/v1/collections/${collectionName}/compiled`,
      );
      return res.data;
    },
  });

  // Sync draft when query data changes (replaces removed onSuccess in TanStack Query v5).
  if (compiledQuery.data && !draft) {
    setDraft(JSON.stringify(compiledQuery.data, null, 2));
  }

  const diffMutation = useMutation({
    mutationFn: async () => {
      setError(null);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(draft);
      } catch (e) {
        throw new Error('Invalid JSON: ' + (e as Error).message);
      }
      const res = await client.schema.diff(collectionName, parsed);
      return res.data as SchemaDiff;
    },
    onSuccess: (data) => setDiff(data),
    onError: (e) => setError((e as Error).message),
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      const parsed = JSON.parse(draft);
      const res = await client.schema.apply(collectionName, parsed);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collection', collectionName] });
      queryClient.invalidateQueries({ queryKey: ['fields', collectionName] });
      queryClient.invalidateQueries({ queryKey: ['compiled', collectionName] });
      setDiff(null);
    },
    onError: (e) => setError((e as Error).message),
  });

  const summary = diff ? summarizeDiff(diff) : null;

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-md border">
        <Editor
          height="420px"
          defaultLanguage="json"
          value={draft}
          onChange={(v) => setDraft(v ?? '')}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            scrollBeyondLastLine: false,
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => diffMutation.mutate()}
          disabled={diffMutation.isPending}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs"
        >
          <GitCompareArrows className="h-3.5 w-3.5" />
          {diffMutation.isPending ? 'Computing…' : 'Preview diff'}
        </button>
        <button
          type="button"
          onClick={() => applyMutation.mutate()}
          disabled={applyMutation.isPending || !diff}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <Save className="h-3.5 w-3.5" />
          {applyMutation.isPending ? 'Applying…' : 'Apply changes'}
        </button>
        {diff && (
          <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium ${riskClass(diff.risk)}`}>
            {diff.risk === 'high' ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {diff.risk.toUpperCase()} risk
          </span>
        )}
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      {diff && summary && (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-4">
            <Metric label="Added" value={summary.added} />
            <Metric label="Changed" value={summary.changed} />
            <Metric label="Removed" value={summary.removed} />
            <Metric label="Impacts" value={diff.runtimeImpact.length} />
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <DiffSection title="Collection" entries={diff.collection.changed} empty="No collection metadata changes." />
            <DiffSection title="Fields" entries={[...diff.fields.added, ...diff.fields.changed, ...diff.fields.removed]} empty="No field changes." />
            <DiffSection title="Relations" entries={[...diff.relations.added, ...diff.relations.changed, ...diff.relations.removed]} empty="No relation changes." />
          </div>

          {diff.runtimeImpact.length > 0 && (
            <div className="rounded-md border p-3">
              <h3 className="text-sm font-medium">Runtime impact</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {diff.runtimeImpact.map((impact) => (
                  <span key={impact} className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                    {formatToken(impact)}
                  </span>
                ))}
              </div>
            </div>
          )}

          <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
{JSON.stringify(diff, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}

function DiffSection({ title, entries, empty }: { title: string; entries: SchemaDiffEntry[]; empty: string }) {
  return (
    <div className="rounded-md border p-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {entries.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {entries.map((entry, index) => (
            <li key={`${entry.identity ?? entry.name ?? entry.field ?? title}-${index}`} className="rounded-md bg-muted p-2">
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-xs font-medium">{entry.identity ?? entry.name ?? entry.field ?? 'schema'}</span>
                {entry.risk && (
                  <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${riskClass(entry.risk)}`}>
                    {entry.risk}
                  </span>
                )}
              </div>
              {entry.type && <div className="mt-1 text-[11px] text-muted-foreground">{entry.type}</div>}
              {entry.changes && entry.changes.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {entry.changes.map((change) => (
                    <span key={change} className="rounded-md bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {formatToken(change)}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function summarizeDiff(diff: SchemaDiff) {
  return {
    added: diff.collection.added.length + diff.fields.added.length + diff.relations.added.length,
    changed: diff.collection.changed.length + diff.fields.changed.length + diff.relations.changed.length,
    removed: diff.collection.removed.length + diff.fields.removed.length + diff.relations.removed.length,
  };
}

function riskClass(risk: SchemaDiffRisk) {
  if (risk === 'high') return 'border-destructive/40 bg-destructive/10 text-destructive';
  if (risk === 'medium') return 'border-amber-500/40 bg-amber-500/10 text-amber-700';
  return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700';
}

function formatToken(value: string) {
  return value.replaceAll('_', ' ');
}
