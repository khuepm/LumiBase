import Editor from '@/components/lazy-monaco-editor';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Play, X } from 'lucide-react';
import { useState } from 'react';
import type { PermissionAction, PermissionCheckResult } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

const ACTIONS: PermissionAction[] = ['create', 'read', 'update', 'delete', 'share'];

/**
 * Test sandbox — pick a `(collection, action)` and an optional item payload,
 * fire `POST /permissions/check`, and render the verdict (allowed, reason,
 * fields, rule, presets) so users can iterate on policies confidently.
 */
export function TestSandboxPage() {
  const client = getApiClient();
  const [collection, setCollection] = useState('');
  const [action, setAction] = useState<PermissionAction>('read');
  const [includeItem, setIncludeItem] = useState(false);
  const [itemText, setItemText] = useState('{\n  "status": "draft"\n}');
  const [result, setResult] = useState<PermissionCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const collectionsQuery = useQuery({
    queryKey: ['collections'],
    queryFn: async () => (await client.schema.listCollections()).data,
  });

  const check = useMutation({
    mutationFn: async () => {
      let item: Record<string, unknown> | undefined;
      if (includeItem) {
        try {
          const parsed = JSON.parse(itemText);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Item payload must be a JSON object.');
          }
          item = parsed as Record<string, unknown>;
        } catch (e) {
          throw new Error('Invalid JSON: ' + (e as Error).message);
        }
      }
      const res = await client.permissions.check({ collection, action, item });
      return res.data;
    },
    onMutate: () => setError(null),
    onSuccess: (data) => setResult(data),
    onError: (e) => {
      setResult(null);
      setError((e as Error).message);
    },
  });

  const collections = collectionsQuery.data ?? [];

  // Default the collection to the first one once loaded.
  if (!collection && collections[0]?.name) {
    setCollection(collections[0].name);
  }

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">Test sandbox</h2>
        <p className="text-xs text-muted-foreground">
          Simulate a verdict for the active principal. Send an optional item
          payload to evaluate row-level rules.
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Collection</span>
          {collections.length === 0 ? (
            <input
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              placeholder="posts"
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          ) : (
            <select
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            >
              {collections.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Action</span>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value as PermissionAction)}
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <button
            type="button"
            onClick={() => check.mutate()}
            disabled={!collection || check.isPending}
            className="inline-flex h-9 items-center gap-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            {check.isPending ? 'Checking…' : 'Run check'}
          </button>
        </div>
      </section>

      <section>
        <label className="mb-1 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeItem}
            onChange={(e) => setIncludeItem(e.target.checked)}
          />
          <span>Include item payload (evaluates row-level rule)</span>
        </label>
        {includeItem && (
          <div className="overflow-hidden rounded-md border">
            <Editor
              height="160px"
              defaultLanguage="json"
              value={itemText}
              onChange={(v) => setItemText(v ?? '')}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
              }}
            />
          </div>
        )}
      </section>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {result && <VerdictCard result={result} />}
    </div>
  );
}

function VerdictCard({ result }: { result: PermissionCheckResult }) {
  return (
    <section
      className={cn(
        'space-y-3 rounded-lg border p-4',
        result.allowed
          ? 'border-emerald-300 bg-emerald-50'
          : 'border-rose-300 bg-rose-50',
      )}
    >
      <header className="flex items-center gap-2 text-sm font-semibold">
        {result.allowed ? (
          <Check className="h-4 w-4 text-emerald-600" />
        ) : (
          <X className="h-4 w-4 text-rose-600" />
        )}
        <span className={result.allowed ? 'text-emerald-800' : 'text-rose-800'}>
          {result.allowed ? 'Allowed' : 'Denied'}
        </span>
        {result.reason && (
          <code className="rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {result.reason}
          </code>
        )}
      </header>
      <div className="grid gap-3 sm:grid-cols-3">
        <Block label="Fields">
          {result.fields.length === 0 ? (
            <span className="text-muted-foreground">none</span>
          ) : (
            <ul className="space-y-0.5">
              {result.fields.map((f) => (
                <li key={f}>
                  <code className="rounded bg-background px-1 text-[11px]">{f}</code>
                </li>
              ))}
            </ul>
          )}
        </Block>
        <Block label="Rule">
          <pre className="max-h-40 overflow-auto rounded bg-background p-2 text-[11px] leading-tight">
{JSON.stringify(result.rule ?? null, null, 2)}
          </pre>
        </Block>
        <Block label="Presets">
          <pre className="max-h-40 overflow-auto rounded bg-background p-2 text-[11px] leading-tight">
{JSON.stringify(result.presets ?? {}, null, 2)}
          </pre>
        </Block>
      </div>
    </section>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">{label}</h4>
      <div className="text-xs">{children}</div>
    </div>
  );
}
