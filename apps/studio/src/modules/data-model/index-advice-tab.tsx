import { useMutation } from '@tanstack/react-query';
import { Check, Copy, Gauge } from 'lucide-react';
import { useState } from 'react';
import type { JsonPathCast, JsonPathIndexAdvice } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';

/**
 * JSON path index advisor (#729). Filtering on `data.<path>` with a typed
 * cast (`?filter[specs.weight][_gt]=10`) compiles to an expression the
 * generic GIN index cannot serve; this tab asks the server for the matching
 * expression index. Advice only: the DDL is shown for an operator to review
 * and run (it uses `CONCURRENTLY`), Studio never executes it.
 */

const CASTS: Array<{ value: '' | JsonPathCast; label: string }> = [
  { value: '', label: 'Declared field type' },
  { value: 'numeric', label: 'numeric' },
  { value: 'boolean', label: 'boolean' },
  { value: 'timestamp', label: 'timestamp' },
  { value: 'text', label: 'text' },
];

/**
 * The path as the filter names it: trimmed only. A leading `data.` is NOT
 * stripped — a field may itself be named `data`.
 */
export function normalizeAdvicePath(raw: string): string {
  return raw.trim();
}

export function IndexAdviceTab({ collectionName }: { collectionName: string }) {
  const client = getApiClient();
  const [path, setPath] = useState('');
  const [cast, setCast] = useState<'' | JsonPathCast>('');
  const [copied, setCopied] = useState(false);

  const advice = useMutation({
    mutationFn: async (): Promise<JsonPathIndexAdvice> => {
      const res = await client.schema.indexAdvice(collectionName, normalizeAdvicePath(path), cast || undefined);
      return res.data;
    },
    onMutate: () => setCopied(false),
  });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* clipboard denied: the DDL stays selectable */
    }
  };

  const result = advice.data;

  return (
    <div className="max-w-2xl space-y-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Gauge className="h-4 w-4" aria-hidden="true" />
          JSON path index advice
        </h3>
        <p className="text-sm text-muted-foreground">
          Typed filters on a field or a nested JSON path (for example <code>specs.weight</code> compared as a number)
          need an expression index to stay fast on large collections. Enter the path you filter on to get the DDL. It is
          never run for you.
        </p>
      </div>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (normalizeAdvicePath(path)) advice.mutate();
        }}
      >
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Path</span>
          <input
            className="rounded-md border px-3 py-1.5 text-sm"
            placeholder="price or specs.weight"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Compare as</span>
          <select
            className="rounded-md border px-3 py-1.5 text-sm"
            value={cast}
            onChange={(e) => setCast(e.target.value as '' | JsonPathCast)}
          >
            {CASTS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={!normalizeAdvicePath(path) || advice.isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          Get advice
        </button>
      </form>

      {advice.error && (
        <p role="alert" className="text-sm text-destructive">
          {advice.error.message}
        </p>
      )}

      {result && (
        <div className="space-y-3 rounded-md border p-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Filter expression ({result.cast})</div>
            <code className="break-all">{result.expression}</code>
          </div>
          {result.ddl ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Index DDL</span>
                <button
                  type="button"
                  onClick={() => void copy(result.ddl!)}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? 'Copied' : 'Copy DDL'}
                </button>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{result.ddl}</pre>
            </div>
          ) : (
            <p className="text-muted-foreground">No index can serve this cast; see the notes below.</p>
          )}
          {result.notes.length > 0 && (
            <ul className="list-disc space-y-1 ps-5 text-xs text-muted-foreground">
              {result.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
