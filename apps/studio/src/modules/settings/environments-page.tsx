import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, GitBranch, RotateCcw, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { getApiClient, setActiveSite } from '@/lib/api';
import { cn } from '@/lib/cn';
import {
  ENVIRONMENTS_BASE,
  useEnvironmentMarker,
  useEnvironmentsEnabled,
  type ContentPlan,
  type ContentScope,
  type EnvironmentView,
  type SchemaPlan,
} from './environments-api';

/**
 * Settings → Environments (#853, tasks 5.5 and 7.8).
 *
 * Fork this site into an isolated environment, switch Studio into it, read
 * the dry-run plans of a schema and a content promote, and apply them. A
 * schema promote cannot be undone; a content promote never overwrites an item
 * the origin changed after the fork (those are listed as conflicts).
 */

const ACTIVE = new Set(['forking', 'merging']);
const QUIET = new Set(['unchanged', 'origin-only']);

function errorMessage(err: unknown): string {
  const body = (err as { body?: { errors?: Array<{ code?: string; message?: string }> } })?.body;
  const first = body?.errors?.[0];
  if (first) return `${first.code ?? 'ERROR'}: ${first.message ?? ''}`;
  return err instanceof Error ? err.message : 'Request failed.';
}

function StatusBadge({ status }: { status: EnvironmentView['status'] }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-xs',
        status === 'ready' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        status === 'failed' && 'bg-destructive/10 text-destructive',
        ACTIVE.has(status) && 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
      )}
    >
      {status}
    </span>
  );
}

function SchemaPlanView({ plan }: { plan: SchemaPlan }) {
  const rows = plan.entries.filter((e) => !QUIET.has(e.action));
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">Schema is in sync with the origin.</p>;
  return (
    <table className="w-full text-start text-xs">
      <thead className="text-muted-foreground">
        <tr>
          <th className="py-1">Kind</th>
          <th className="py-1">Key</th>
          <th className="py-1">Action</th>
          <th className="py-1">Notes</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={`${e.kind}:${e.key}`} className="border-t align-top">
            <td className="py-1">{e.kind}</td>
            <td className="py-1 font-mono">{e.key}</td>
            <td className={cn('py-1', (e.action === 'conflict' || e.action === 'blocked') && 'text-destructive')}>
              {e.action}
              {e.renameFrom ? ` (from ${e.renameFrom})` : ''}
            </td>
            <td className="py-1 text-muted-foreground">
              {[e.reason, e.risk !== 'low' ? `${e.risk} risk` : null, e.requires?.join(' + '), e.changes?.length ? `changes: ${e.changes.join(', ')}` : null]
                .filter(Boolean)
                .join(' · ')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ContentPlanView({ plan }: { plan: ContentPlan }) {
  const groups = new Map<string, ContentPlan['items']>();
  for (const i of plan.items) {
    if (QUIET.has(i.action)) continue;
    groups.set(i.action, [...(groups.get(i.action) ?? []), i]);
  }
  if (groups.size === 0) return <p className="text-xs text-muted-foreground">No content changes to promote.</p>;
  return (
    <div className="space-y-3">
      {plan.truncated && <p className="text-xs text-amber-700 dark:text-amber-300">More items changed than one run handles; run again after this one.</p>}
      {[...groups].map(([action, list]) => (
        <section key={action}>
          <h4 className={cn('text-xs font-semibold', (action === 'conflict' || action === 'blocked') && 'text-destructive')}>
            {action} · {list.length}
          </h4>
          <ul className="mt-1 space-y-0.5 text-xs">
            {list.slice(0, 200).map((i) => (
              <li key={`${i.collection}/${i.itemId}`} className="font-mono">
                {i.collection}/{i.itemId}
                {i.reason ? <span className="ms-2 font-sans text-muted-foreground">{i.reason}</span> : null}
                {i.changedFields?.length ? <span className="ms-2 font-sans text-muted-foreground">fields: {i.changedFields.join(', ')}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function EnvironmentCard({ env }: { env: EnvironmentView }) {
  const client = getApiClient();
  const qc = useQueryClient();
  const base = `${ENVIRONMENTS_BASE}/${encodeURIComponent(env.key)}`;
  const [confirmRisky, setConfirmRisky] = useState(false);
  const [migrationPlans, setMigrationPlans] = useState('');

  const schemaPlan = useMutation({
    mutationFn: async () => (await client.rawRequest<{ plan: SchemaPlan }>(`${base}/promote/schema`, { method: 'POST', body: JSON.stringify({ dryRun: true }) })).data.plan,
  });
  const contentPlan = useMutation({
    mutationFn: async () => (await client.rawRequest<{ plan: ContentPlan }>(`${base}/promote/content`, { method: 'POST', body: JSON.stringify({ dryRun: true }) })).data.plan,
  });
  const applySchema = useMutation({
    mutationFn: async () => {
      const plans = migrationPlans.trim() ? (JSON.parse(migrationPlans) as Record<string, Record<string, unknown>>) : undefined;
      return (
        await client.rawRequest<{ applied: Record<string, number> }>(`${base}/promote/schema`, {
          method: 'POST',
          body: JSON.stringify({ dryRun: false, confirmRiskyChange: confirmRisky, migrationPlans: plans }),
        })
      ).data;
    },
    onSuccess: () => {
      schemaPlan.mutate();
      void qc.invalidateQueries({ queryKey: ['environments'] });
    },
  });
  const applyContent = useMutation({
    mutationFn: async () =>
      (await client.rawRequest<{ counts: Record<string, number> }>(`${base}/promote/content`, { method: 'POST', body: JSON.stringify({ dryRun: false }) })).data,
    onSuccess: () => {
      contentPlan.mutate();
      void qc.invalidateQueries({ queryKey: ['environments'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => client.rawRequest(base, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['environments'] }),
  });
  const retry = useMutation({
    mutationFn: () => client.rawRequest(`${base}/retry`, { method: 'POST', body: '{}' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['environments'] }),
  });

  const ready = env.status === 'ready';
  return (
    <li className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium">{env.name}</span>
            <code className="rounded bg-muted px-1 text-xs">{env.key}</code>
            <StatusBadge status={env.status} />
          </div>
          <div className="text-xs text-muted-foreground">
            {env.contentScope.mode === 'collections' ? `content: ${env.contentScope.collections.join(', ')}` : `content: ${env.contentScope.mode}`}
            {env.status === 'forking' ? ` · ${env.progress.phase}, ${env.progress.counts.items ?? 0} items so far` : ''}
            {env.forkedAt ? ` · forked ${new Date(env.forkedAt).toLocaleString()}` : ''}
            {env.mergedAt ? ` · last promoted ${new Date(env.mergedAt).toLocaleString()}` : ''}
          </div>
          {env.statusReason && <div className="text-xs text-destructive">{env.statusReason}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          {ready && (
            <button
              type="button"
              onClick={async () => {
                await qc.cancelQueries();
                qc.clear();
                setActiveSite(env.siteId);
                window.location.reload();
              }}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
            >
              <ArrowRightLeft className="h-3.5 w-3.5" /> Open in Studio
            </button>
          )}
          {env.status === 'failed' && (
            <button type="button" onClick={() => retry.mutate()} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted">
              <RotateCcw className="h-3.5 w-3.5" /> Retry fork
            </button>
          )}
          <button
            type="button"
            aria-label={`Delete environment ${env.key}`}
            disabled={ACTIVE.has(env.status) || remove.isPending}
            onClick={() => {
              if (window.confirm(`Delete environment "${env.key}" and everything in it? The origin is not affected.`)) remove.mutate();
            }}
            className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
      </div>
      {remove.error && <p role="alert" className="text-xs text-destructive">{errorMessage(remove.error)}</p>}

      {ready && (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Schema</h3>
              <button type="button" onClick={() => schemaPlan.mutate()} className="rounded-md border px-2 py-1 text-xs hover:bg-muted">
                {schemaPlan.isPending ? 'Checking…' : 'Preview changes'}
              </button>
            </div>
            {schemaPlan.error && <p role="alert" className="text-xs text-destructive">{errorMessage(schemaPlan.error)}</p>}
            {schemaPlan.data && <SchemaPlanView plan={schemaPlan.data} />}
            {schemaPlan.data && !schemaPlan.data.clean && (
              <div className="space-y-2 rounded border border-amber-500/40 bg-amber-500/5 p-2">
                <p className="text-xs">A schema promote changes the production schema and cannot be undone.</p>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={confirmRisky} onChange={(e) => setConfirmRisky(e.target.checked)} />
                  I confirm risky changes (rename, type change, delete)
                </label>
                {schemaPlan.data.entries.some((e) => e.requires?.includes('migrationPlan')) && (
                  <label className="block text-xs">
                    Migration plans (JSON, by key)
                    <textarea
                      value={migrationPlans}
                      onChange={(e) => setMigrationPlans(e.target.value)}
                      placeholder='{"posts.rating": {"strategy": "cast-integer"}}'
                      className="mt-1 h-16 w-full rounded border bg-background p-1 font-mono text-xs"
                    />
                  </label>
                )}
                <button
                  type="button"
                  disabled={applySchema.isPending}
                  onClick={() => applySchema.mutate()}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  {applySchema.isPending ? 'Promoting…' : 'Promote schema'}
                </button>
                {applySchema.error && <p role="alert" className="text-xs text-destructive">{errorMessage(applySchema.error)}</p>}
              </div>
            )}
          </section>
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Content</h3>
              <button type="button" onClick={() => contentPlan.mutate()} className="rounded-md border px-2 py-1 text-xs hover:bg-muted">
                {contentPlan.isPending ? 'Checking…' : 'Preview changes'}
              </button>
            </div>
            {contentPlan.error && <p role="alert" className="text-xs text-destructive">{errorMessage(contentPlan.error)}</p>}
            {contentPlan.data && <ContentPlanView plan={contentPlan.data} />}
            {contentPlan.data && contentPlan.data.items.some((i) => ['promote', 'create', 'delete'].includes(i.action)) && (
              <button
                type="button"
                disabled={applyContent.isPending}
                onClick={() => {
                  if (window.confirm('Promote these items to the origin? Conflicts are skipped, never overwritten.')) applyContent.mutate();
                }}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {applyContent.isPending ? 'Promoting…' : 'Promote content'}
              </button>
            )}
            {applyContent.data && (
              <p className="text-xs text-muted-foreground">
                {Object.entries(applyContent.data.counts)
                  .map(([k, v]) => `${v} ${k}`)
                  .join(' · ')}
              </p>
            )}
            {applyContent.error && <p role="alert" className="text-xs text-destructive">{errorMessage(applyContent.error)}</p>}
          </section>
        </div>
      )}
    </li>
  );
}

export function EnvironmentsSettingsPage() {
  const client = getApiClient();
  const qc = useQueryClient();
  const enabled = useEnvironmentsEnabled();
  const marker = useEnvironmentMarker();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [scopeMode, setScopeMode] = useState<ContentScope['mode']>('all');
  const [picked, setPicked] = useState<string[]>([]);

  const list = useQuery({
    queryKey: ['environments'],
    enabled: enabled && !marker,
    queryFn: async () => (await client.rawRequest<EnvironmentView[]>(ENVIRONMENTS_BASE)).data,
    refetchInterval: (q) => ((q.state.data ?? []).some((e) => ACTIVE.has(e.status)) ? 3_000 : false),
  });
  const collections = useQuery({
    queryKey: ['collections-for-environments'],
    enabled: enabled && !marker,
    queryFn: async () => (await client.rawRequest<Array<{ name: string; system?: boolean }>>('/api/v1/collections')).data,
  });
  const create = useMutation({
    mutationFn: async () => {
      const contentScope: ContentScope = scopeMode === 'collections' ? { mode: 'collections', collections: picked } : { mode: scopeMode };
      return (await client.rawRequest<EnvironmentView>(ENVIRONMENTS_BASE, { method: 'POST', body: JSON.stringify({ key, name, contentScope }) })).data;
    },
    onSuccess: () => {
      setKey('');
      setName('');
      void qc.invalidateQueries({ queryKey: ['environments'] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight">
          <GitBranch className="h-6 w-6" /> Environments
        </h1>
        <p className="text-sm text-muted-foreground">
          Fork this site into an isolated copy of its schema and content, work there without touching production, then promote the schema and
          the content back. Webhooks, flows and other side effects stay off in an environment.
        </p>
      </header>

      {!enabled ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">Environments are not enabled on this site.</p>
      ) : marker ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">
          You are inside an environment. Manage environments from the origin site (<code>{marker.originSiteId}</code>).
        </p>
      ) : (
        <>
          <form onSubmit={submit} className="space-y-3 rounded-lg border p-4">
            <h2 className="text-sm font-semibold">New environment</h2>
            <div className="flex flex-wrap gap-3">
              <label className="text-xs font-medium text-muted-foreground">
                Key
                <input
                  required
                  value={key}
                  onChange={(e) => setKey(e.target.value.toLowerCase())}
                  pattern="[a-z][a-z0-9\-]{0,38}[a-z0-9]"
                  placeholder="staging"
                  className="mt-1 block w-44 rounded-md border bg-background px-2 py-1.5 font-mono text-sm"
                />
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                Name
                <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Redesign 2027" className="mt-1 block w-64 rounded-md border bg-background px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                Content
                <select value={scopeMode} onChange={(e) => setScopeMode(e.target.value as ContentScope['mode'])} className="mt-1 block rounded-md border bg-background px-2 py-1.5 text-sm">
                  <option value="all">All content</option>
                  <option value="collections">Some collections</option>
                  <option value="none">Schema only</option>
                </select>
              </label>
            </div>
            {scopeMode === 'collections' && (
              <fieldset className="flex flex-wrap gap-3 text-xs">
                <legend className="sr-only">Collections to copy</legend>
                {(collections.data ?? [])
                  .filter((c) => !c.system)
                  .map((c) => (
                    <label key={c.name} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={picked.includes(c.name)}
                        onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.name] : p.filter((x) => x !== c.name)))}
                      />
                      {c.name}
                    </label>
                  ))}
              </fieldset>
            )}
            <button type="submit" disabled={create.isPending} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50">
              {create.isPending ? 'Forking…' : 'Fork'}
            </button>
            {create.error && <p role="alert" className="text-xs text-destructive">{errorMessage(create.error)}</p>}
          </form>

          <ul className="space-y-3">
            {(list.data ?? []).map((env) => (
              <EnvironmentCard key={env.id} env={env} />
            ))}
            {list.data?.length === 0 && <li className="text-sm text-muted-foreground">No environments yet.</li>}
          </ul>
        </>
      )}
    </div>
  );
}
