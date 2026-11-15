import Editor from '@/components/lazy-monaco-editor';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Save, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ItemRow } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';

interface BulkRawEditorProps {
  collection: string;
  ids: string[];
  onClose: () => void;
  onSaved: () => void;
}

interface BulkRow {
  id: string;
  data: Record<string, unknown>;
}

/**
 * Modal Monaco editor for editing the `data` payload of multiple items at once.
 *
 * The editor surfaces an array `[{ id, data }, …]`. Saving issues a `PATCH`
 * per row whose `data` differs from the server original (skips no-ops). For
 * larger volumes the SDK's `bulk()` endpoint can be wired here later.
 */
export function BulkRawEditor({ collection, ids, onClose, onSaved }: BulkRawEditorProps) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [text, setText] = useState('[]');
  const [error, setError] = useState<string | null>(null);

  // Parallel fetch of every selected row so we can seed the editor.
  const detailQueries = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['item', collection, id],
      queryFn: async () => (await client.items(collection as never).detail(id)).data as ItemRow,
    })),
  });

  const allLoaded = detailQueries.every((q) => q.data);
  const originals = useMemo<BulkRow[]>(() => {
    if (!allLoaded) return [];
    return detailQueries
      .map((q) => q.data!)
      .map((row) => ({ id: row.id, data: (row.data as Record<string, unknown>) ?? {} }));
  }, [allLoaded, detailQueries]);

  // Seed the editor once when all rows are loaded.
  useEffect(() => {
    if (allLoaded && text === '[]') {
      setText(JSON.stringify(originals, null, 2));
    }
  }, [allLoaded, originals, text]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const parsed = parseRows(text);
      const originalById = new Map(originals.map((r) => [r.id, r]));
      const writes: Promise<unknown>[] = [];
      for (const row of parsed) {
        const orig = originalById.get(row.id);
        if (!orig) continue;
        if (JSON.stringify(orig.data) === JSON.stringify(row.data)) continue;
        writes.push(client.items(collection as never).patch(row.id, { data: row.data }));
      }
      await Promise.all(writes);
      return writes.length;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items', collection] });
      ids.forEach((id) =>
        queryClient.invalidateQueries({ queryKey: ['item', collection, id] }),
      );
      onSaved();
    },
  });

  const handleChange = (next: string | undefined) => {
    setText(next ?? '');
    try {
      parseRows(next ?? '');
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
      <div className="flex h-full max-h-[90vh] w-full max-w-5xl flex-col rounded-lg border bg-background shadow-xl">
        <header className="flex items-center justify-between gap-2 border-b px-4 py-2">
          <div>
            <h2 className="text-sm font-semibold">Bulk raw editor — {collection}</h2>
            <p className="text-xs text-muted-foreground">
              Editing {ids.length} row{ids.length === 1 ? '' : 's'}; only changed entries are PATCHed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={!!error || saveMutation.isPending || !allLoaded}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {saveMutation.isPending ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        <div
          className={`flex items-center gap-2 border-b px-4 py-1 text-xs ${
            error
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700'
          }`}
        >
          {error ? <AlertCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          <span>{error ?? 'Valid array of {id, data} entries.'}</span>
        </div>

        {saveMutation.error && (
          <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-1 text-xs text-destructive">
            Save failed: {(saveMutation.error as Error).message}
          </div>
        )}

        <div className="flex-1 overflow-hidden" dir="ltr">
          {allLoaded ? (
            <Editor
              height="100%"
              defaultLanguage="json"
              theme="vs-light"
              value={text}
              onChange={handleChange}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
                tabSize: 2,
              }}
            />
          ) : (
            <p className="p-6 text-center text-sm text-muted-foreground">Loading rows…</p>
          )}
        </div>
      </div>
    </div>
  );
}

function parseRows(text: string): BulkRow[] {
  const v = JSON.parse(text);
  if (!Array.isArray(v)) throw new Error('Top-level value must be an array.');
  for (const row of v) {
    if (!row || typeof row !== 'object') throw new Error('Each entry must be an object.');
    if (typeof row.id !== 'string') throw new Error('Each entry needs a string `id`.');
    if (row.data !== null && typeof row.data !== 'object')
      throw new Error('`data` must be an object.');
  }
  return v as BulkRow[];
}
