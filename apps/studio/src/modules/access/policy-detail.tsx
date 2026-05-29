import Editor from '@monaco-editor/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PermissionAction } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { PermissionRowEditor } from './permission-row-editor';

const ACTION_OPTIONS: PermissionAction[] = ['create', 'read', 'update', 'delete', 'share'];

/**
 * Policy detail page. Renders identity + guards + the list of permission rows
 * attached to this policy. Each row can be expanded to edit `fields`,
 * `permissions` (the row-level rule DSL), `validation`, and `presets`.
 */
export function PolicyDetailPage() {
  const { id } = useParams({ from: '/admin-layout/access/policies/$id' });
  const client = getApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);

  const policyQuery = useQuery({
    queryKey: ['access', 'policy', id],
    queryFn: async () => (await client.policies.detail(id)).data,
  });

  const collectionsQuery = useQuery({
    queryKey: ['collections'],
    queryFn: async () => (await client.schema.listCollections()).data,
  });

  const updatePolicy = useMutation({
    mutationFn: (patch: Parameters<typeof client.policies.update>[1]) =>
      client.policies.update(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'policy', id] }),
  });

  const removePolicy = useMutation({
    mutationFn: () => client.policies.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['access', 'policies'] });
      navigate({ to: '/access/policies' });
    },
  });

  const addPermission = useMutation({
    mutationFn: (input: { collection: string; action: PermissionAction }) =>
      client.policies.addPermission(id, { ...input, fields: ['*'] }),
    onSuccess: () => {
      setAdding(false);
      queryClient.invalidateQueries({ queryKey: ['access', 'policy', id] });
    },
  });

  if (policyQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading policy…</p>;
  }
  if (policyQuery.error || !policyQuery.data) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Policy not found.
      </div>
    );
  }

  const policy = policyQuery.data;

  return (
    <div className="space-y-5">
      <Link
        to="/access/policies"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" /> Back to policies
      </Link>

      <header className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-2">
          <input
            value={policy.name}
            onChange={(e) => updatePolicy.mutate({ name: e.target.value })}
            className="w-full rounded-md border bg-background px-3 py-1.5 text-lg font-semibold"
          />
          <textarea
            value={policy.description ?? ''}
            placeholder="Add description…"
            onChange={(e) => updatePolicy.mutate({ description: e.target.value })}
            rows={2}
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm text-muted-foreground"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete policy "${policy.name}"?`)) removePolicy.mutate();
          }}
          className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
      </header>

      <GuardsSection
        rules={policy.rules ?? {}}
        onChange={(rules) => updatePolicy.mutate({ rules })}
      />

      <section className="rounded-lg border p-4">
        <header className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Permission rows</h3>
            <p className="text-xs text-muted-foreground">
              Each row grants `(collection, action)` with optional row-level rules,
              field whitelist, validation, and presets.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground"
          >
            <Plus className="h-3 w-3" /> Add permission
          </button>
        </header>

        {policy.permissions.length === 0 && (
          <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            No permissions yet. Add one to grant access.
          </p>
        )}

        <ul className="space-y-3">
          {policy.permissions.map((row) => (
            <li key={row.id}>
              <PermissionRowEditor
                policyId={id}
                row={row}
                onChange={() =>
                  queryClient.invalidateQueries({ queryKey: ['access', 'policy', id] })
                }
              />
            </li>
          ))}
        </ul>
      </section>

      {adding && (
        <AddPermissionDialog
          collections={(collectionsQuery.data ?? []).map((c) => c.name)}
          onClose={() => setAdding(false)}
          onSubmit={(collection, action) => addPermission.mutate({ collection, action })}
          submitting={addPermission.isPending}
          error={addPermission.error as Error | null}
        />
      )}
    </div>
  );
}

interface PolicyGuardRules {
  validFrom?: string | null;
  validUntil?: string | null;
  ipAllow?: string[];
  ipDeny?: string[];
}

/**
 * GUI + Monaco for the policy `rules` blob. The BE evaluator reads
 * `validFrom`, `validUntil`, `ipAllow`, `ipDeny`; everything else is preserved
 * verbatim so future fields (custom flags) survive a round-trip edit.
 */
function GuardsSection({
  rules,
  onChange,
}: {
  rules: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const guards = rules as PolicyGuardRules;
  const [mode, setMode] = useState<'gui' | 'json'>('gui');
  const text = useMemo(() => JSON.stringify(rules ?? {}, null, 2), [rules]);

  const update = (patch: Partial<PolicyGuardRules>) => {
    onChange({ ...rules, ...patch });
  };

  return (
    <section className="rounded-lg border p-4">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Guardrails</h3>
          <p className="text-xs text-muted-foreground">
            Time-bound + IP allow/deny evaluated before any permission row.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-md border bg-muted/30 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setMode('gui')}
            className={cn('rounded px-2 py-0.5', mode === 'gui' && 'bg-background shadow-sm')}
          >
            GUI
          </button>
          <button
            type="button"
            onClick={() => setMode('json')}
            className={cn('rounded px-2 py-0.5', mode === 'json' && 'bg-background shadow-sm')}
          >
            JSON
          </button>
        </div>
      </header>

      {mode === 'gui' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Valid from</span>
            <input
              type="datetime-local"
              value={toLocalDateInput(guards.validFrom)}
              onChange={(e) =>
                update({ validFrom: e.target.value ? new Date(e.target.value).toISOString() : null })
              }
              className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Valid until</span>
            <input
              type="datetime-local"
              value={toLocalDateInput(guards.validUntil)}
              onChange={(e) =>
                update({ validUntil: e.target.value ? new Date(e.target.value).toISOString() : null })
              }
              className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              IP allow (comma separated)
            </span>
            <input
              value={(guards.ipAllow ?? []).join(', ')}
              onChange={(e) =>
                update({ ipAllow: splitCsv(e.target.value) })
              }
              className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              IP deny (comma separated)
            </span>
            <input
              value={(guards.ipDeny ?? []).join(', ')}
              onChange={(e) =>
                update({ ipDeny: splitCsv(e.target.value) })
              }
              className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            />
          </label>
        </div>
      )}

      {mode === 'json' && (
        <div className="overflow-hidden rounded-md border">
          <Editor
            height="180px"
            defaultLanguage="json"
            value={text}
            onChange={(v) => {
              try {
                const parsed = JSON.parse(v ?? '{}');
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  onChange(parsed);
                }
              } catch {
                /* ignore until JSON is valid */
              }
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      )}
    </section>
  );
}

function toLocalDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function AddPermissionDialog({
  collections,
  onClose,
  onSubmit,
  submitting,
  error,
}: {
  collections: string[];
  onClose: () => void;
  onSubmit: (collection: string, action: PermissionAction) => void;
  submitting: boolean;
  error: Error | null;
}) {
  const [collection, setCollection] = useState(collections[0] ?? '');
  const [action, setAction] = useState<PermissionAction>('read');

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg border bg-background p-5 shadow-lg">
        <h3 className="mb-3 text-base font-semibold">Add permission</h3>
        <div className="space-y-3 text-sm">
          <label className="block">
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
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Action</span>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as PermissionAction)}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            >
              {ACTION_OPTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="text-xs text-destructive">{error.message}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs">
            Cancel
          </button>
          <button
            type="button"
            disabled={!collection.trim() || submitting}
            onClick={() => onSubmit(collection.trim(), action)}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {submitting ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
