import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Rocket,
  Plus,
  Trash2,
  RefreshCw,
  ScrollText,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Ban,
  ArrowUpRight,
  ShieldCheck,
  Settings2,
} from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import type {
  DeploymentAccessResource,
  DeploymentApprovalResource,
  DeploymentEnvironmentResource,
  DeploymentRequestOutcome,
  DeploymentResource,
  DeploymentTargetResource,
} from '@lumibase/sdk';

const STATUS_STYLE: Record<string, { cls: string; Icon: typeof CheckCircle2 }> = {
  ready: { cls: 'bg-emerald-100 text-emerald-800', Icon: CheckCircle2 },
  building: { cls: 'bg-amber-100 text-amber-800', Icon: Loader2 },
  queued: { cls: 'bg-sky-100 text-sky-800', Icon: Clock },
  error: { cls: 'bg-rose-100 text-rose-800', Icon: XCircle },
  canceled: { cls: 'bg-muted text-muted-foreground', Icon: Ban },
};

const FALLBACK_STYLE = { cls: 'bg-muted text-muted-foreground', Icon: Clock };

function StatusBadge({ status }: { status: string }) {
  const { Icon, cls } = STATUS_STYLE[status] ?? FALLBACK_STYLE;
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      <Icon className={`h-3 w-3 ${status === 'building' ? 'animate-spin' : ''}`} />
      {status}
    </span>
  );
}

export function DeploymentsPage() {
  const { t } = useTranslation();
  const client = getApiClient();
  const qc = useQueryClient();

  const targetsQuery = useQuery({
    queryKey: ['deployment-targets'],
    queryFn: async () => (await client.deployments.targets.list()).data ?? [],
  });

  const deploymentsQuery = useQuery({
    queryKey: ['deployments'],
    queryFn: async () => (await client.deployments.list()).data ?? [],
    // Poll while any deployment is in flight so the UI tracks status (Req 8.5).
    refetchInterval: (query) => {
      const data = query.state.data as DeploymentResource[] | undefined;
      return data?.some((d) => d.status === 'queued' || d.status === 'building') ? 5000 : false;
    },
  });

  // Environments, promotion and approvals (#743). Each query degrades on its
  // own: a failure hides that panel, never the targets/deployments list.
  const accessQuery = useQuery({
    queryKey: ['deployment-access'],
    queryFn: async () => (await client.deployments.access()).data ?? null,
  });
  const environmentsQuery = useQuery({
    queryKey: ['deployment-environments'],
    queryFn: async () => (await client.deployments.environments.list()).data ?? [],
  });
  const approvalsQuery = useQuery({
    queryKey: ['deployment-approvals'],
    queryFn: async () => (await client.deployments.approvals.list('pending')).data ?? [],
  });

  const [creating, setCreating] = useState(false);
  const [editingEnvs, setEditingEnvs] = useState(false);
  const [logsFor, setLogsFor] = useState<DeploymentResource | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const targets = targetsQuery.data ?? [];
  const deployments = deploymentsQuery.data ?? [];
  const access: DeploymentAccessResource | null = accessQuery.data ?? null;
  const environments: DeploymentEnvironmentResource[] = environmentsQuery.data ?? [];
  const approvals: DeploymentApprovalResource[] = approvalsQuery.data ?? [];
  // Before /access answers, assume the pre-#743 admin-only page.
  const isAdmin = access?.admin ?? true;
  const envAccess = (key: string) => access?.environments.find((e) => e.key === key);

  const afterRequest = (outcome: DeploymentRequestOutcome | DeploymentResource | null | undefined) => {
    qc.invalidateQueries({ queryKey: ['deployments'] });
    qc.invalidateQueries({ queryKey: ['deployment-approvals'] });
    if (outcome && 'status' in outcome && outcome.status === 'pending_approval') {
      setNotice({
        tone: 'info',
        text: `Approval requested for ${outcome.environment}. Nothing is deployed until another person with deploy:approve:${outcome.environment} accepts it.`,
      });
    } else {
      setNotice(null);
    }
  };
  const onRequestError = (err: unknown) =>
    setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Request failed' });

  const deployMutation = useMutation({
    mutationFn: (targetId: string) => client.deployments.targets.deploy(targetId, { reason: 'manual deploy from Studio' }),
    onSuccess: (res) => afterRequest(res.data),
    onError: onRequestError,
  });

  const envDeployMutation = useMutation({
    mutationFn: (key: string) => client.deployments.environments.deploy(key, { reason: 'environment deploy from Studio' }),
    onSuccess: (res) => afterRequest(res.data),
    onError: onRequestError,
  });

  const promoteMutation = useMutation({
    mutationFn: (key: string) => client.deployments.environments.promote(key, { reason: 'promotion from Studio' }),
    onSuccess: (res) => afterRequest(res.data),
    onError: onRequestError,
  });

  const decideMutation = useMutation({
    mutationFn: (input: { id: string; decision: 'approved' | 'rejected' }) =>
      client.deployments.approvals.decide(input.id, { decision: input.decision }),
    onSuccess: () => {
      setNotice(null);
      qc.invalidateQueries({ queryKey: ['deployment-approvals'] });
      qc.invalidateQueries({ queryKey: ['deployments'] });
    },
    onError: onRequestError,
  });

  const refreshMutation = useMutation({
    mutationFn: (id: string) => client.deployments.refresh(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deployments'] }),
  });

  const deleteTargetMutation = useMutation({
    mutationFn: (id: string) => client.deployments.targets.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deployment-targets'] }),
  });

  const targetName = (id: string) => targets.find((target) => target.id === id)?.name ?? id;

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t('deployments', 'Deployments')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Trigger, monitor and debug Vercel &amp; Netlify deployments without leaving LumiBase.
          </p>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            <Plus className="h-4 w-4" /> Connect target
          </button>
        )}
      </header>

      {notice && (
        <div
          role="status"
          className={`rounded-md p-3 text-sm ${notice.tone === 'error' ? 'bg-rose-50 text-rose-800' : 'bg-sky-50 text-sky-900'}`}
        >
          {notice.text}
        </div>
      )}

      {/* Environments (#743) ---------------------------------------------- */}
      {environments.length > 0 && (
        <section className="space-y-3" aria-labelledby="deploy-envs-heading">
          <div className="flex items-center justify-between">
            <h2 id="deploy-envs-heading" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Environments
            </h2>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setEditingEnvs(true)}
                className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium"
              >
                <Settings2 className="h-3.5 w-3.5" /> Edit environments
              </button>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {environments.map((env) => {
              const rights = envAccess(env.key);
              const dest = env.promotesTo ? environments.find((e) => e.key === env.promotesTo) : undefined;
              const destRights = dest ? envAccess(dest.key) : undefined;
              return (
                <div key={env.key} className="flex flex-col gap-2 rounded-lg border bg-background p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">{env.name}</h3>
                    {env.requiresApproval && (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        <ShieldCheck className="h-3 w-3" /> Approval required
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {env.targetIds.length === 0
                      ? 'No targets mapped'
                      : env.targetIds.map((id) => targetName(id)).join(', ')}
                  </p>
                  <div className="mt-auto flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => envDeployMutation.mutate(env.key)}
                      disabled={!rights?.canTrigger || env.targetIds.length === 0 || envDeployMutation.isPending}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                    >
                      <Rocket className="h-3.5 w-3.5" />
                      {env.requiresApproval ? `Request ${env.name} deploy` : `Deploy ${env.name}`}
                    </button>
                    {dest && (
                      <button
                        type="button"
                        onClick={() => promoteMutation.mutate(env.key)}
                        disabled={!destRights?.canTrigger || dest.targetIds.length === 0 || promoteMutation.isPending}
                        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
                      >
                        <ArrowUpRight className="h-3.5 w-3.5" /> Promote to {dest.name}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Pending approvals (#743) ----------------------------------------- */}
      {approvals.length > 0 && (
        <section className="space-y-3" aria-labelledby="deploy-approvals-heading">
          <h2 id="deploy-approvals-heading" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Pending approvals
          </h2>
          <div className="grid gap-2">
            {approvals.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-lg border bg-background p-3 text-sm">
                <div>
                  <div className="font-medium">
                    {a.kind === 'promote'
                      ? `Promote ${a.sourceEnvironment ?? ''} → ${a.environment}`
                      : `Deploy ${a.environment}`}
                    {a.branch ? <span className="text-muted-foreground"> · {a.branch}</span> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Requested by {a.requestedBy?.id ?? 'unknown'} · {a.targetIds.map((id) => targetName(id)).join(', ')}
                    {a.reason ? ` · “${a.reason}”` : ''}
                  </div>
                </div>
                {a.canDecide ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => decideMutation.mutate({ id: a.id, decision: 'approved' })}
                      disabled={decideMutation.isPending}
                      className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => decideMutation.mutate({ id: a.id, decision: 'rejected' })}
                      disabled={decideMutation.isPending}
                      className="rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">Waiting for an approver</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Targets ------------------------------------------------------------ */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Targets</h2>
        {targetsQuery.isLoading && <div className="text-muted-foreground">Loading…</div>}
        {targets.length === 0 && !targetsQuery.isLoading && (
          <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
            No deployment targets. Connect a Vercel or Netlify project to get started.
          </div>
        )}
        <div className="grid gap-3">
          {targets.map((target) => (
            <div key={target.id} className="flex items-center justify-between rounded-lg border bg-background p-4 shadow-sm">
              <div className="flex items-start gap-4">
                <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600">
                  <Rocket className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold">
                    {target.name} <span className="text-xs font-normal text-muted-foreground">({target.provider})</span>
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {target.projectId}
                    {target.defaultBranch ? ` · ${target.defaultBranch}` : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => deployMutation.mutate(target.id)}
                  disabled={deployMutation.isPending || target.status !== 'active'}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  <Rocket className="h-3.5 w-3.5" /> Deploy now
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm('Delete this deployment target?')) deleteTargetMutation.mutate(target.id);
                    }}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Deployments -------------------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Recent deployments</h2>
        {deployments.length === 0 && !deploymentsQuery.isLoading && (
          <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
            No deployments yet.
          </div>
        )}
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Target</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Branch / commit</th>
                <th className="px-4 py-2">URL</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={d.id} className="border-t">
                  <td className="px-4 py-2 font-medium">{targetName(d.targetId)}</td>
                  <td className="px-4 py-2"><StatusBadge status={d.status} /></td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {d.branch ?? '—'}
                    {d.commitSha ? ` · ${d.commitSha.slice(0, 7)}` : ''}
                  </td>
                  <td className="px-4 py-2">
                    {d.url ? (
                      <a href={d.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        Open
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        title="Refresh status"
                        onClick={() => refreshMutation.mutate(d.id)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                      {isAdmin && (
                        <button
                          type="button"
                          title="View logs"
                          onClick={() => setLogsFor(d)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ScrollText className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {creating && (
        <CreateTargetDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['deployment-targets'] });
          }}
        />
      )}

      {logsFor && <LogsDialog deployment={logsFor} onClose={() => setLogsFor(null)} />}

      {editingEnvs && (
        <EnvironmentsDialog
          environments={environments}
          targets={targets}
          onClose={() => setEditingEnvs(false)}
          onSaved={() => {
            setEditingEnvs(false);
            qc.invalidateQueries({ queryKey: ['deployment-environments'] });
            qc.invalidateQueries({ queryKey: ['deployment-access'] });
          }}
        />
      )}
    </div>
  );
}

/** Admin editor for the environment map (#743): targets, approval gate, promotion. */
function EnvironmentsDialog({
  environments,
  targets,
  onClose,
  onSaved,
}: {
  environments: DeploymentEnvironmentResource[];
  targets: DeploymentTargetResource[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = getApiClient();
  const [draft, setDraft] = useState<DeploymentEnvironmentResource[]>(() =>
    environments.map((env) => ({ ...env, targetIds: [...env.targetIds] })),
  );
  const [error, setError] = useState<string | null>(null);

  const patch = (key: string, change: Partial<DeploymentEnvironmentResource>) =>
    setDraft((envs) => envs.map((env) => (env.key === key ? { ...env, ...change } : env)));

  const save = useMutation({
    mutationFn: () => client.deployments.environments.update(draft),
    onSuccess: onSaved,
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Failed to save environments'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-xl border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold">Deployment environments</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Map targets to environments. An environment that requires approval never deploys on request: a different
          person holding <code>deploy:approve:&lt;env&gt;</code> must accept it first.
        </p>
        <div className="mt-4 space-y-4">
          {draft.map((env) => (
            <fieldset key={env.key} className="rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">
                {env.name} <span className="text-xs text-muted-foreground">({env.key})</span>
              </legend>
              <div className="flex flex-wrap gap-3 text-sm">
                {targets.length === 0 && <span className="text-muted-foreground">Connect a target first.</span>}
                {targets.map((t) => (
                  <label key={t.id} className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={env.targetIds.includes(t.id)}
                      onChange={(e) =>
                        patch(env.key, {
                          targetIds: e.target.checked
                            ? [...env.targetIds, t.id]
                            : env.targetIds.filter((id) => id !== t.id),
                        })
                      }
                    />
                    {t.name}
                  </label>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={env.requiresApproval}
                    onChange={(e) => patch(env.key, { requiresApproval: e.target.checked })}
                  />
                  Requires approval
                </label>
                <label className="inline-flex items-center gap-1.5">
                  Promotes to
                  <select
                    value={env.promotesTo ?? ''}
                    onChange={(e) => patch(env.key, { promotesTo: e.target.value || null })}
                    className="rounded-md border bg-background px-2 py-1"
                  >
                    <option value="">—</option>
                    {draft
                      .filter((other) => other.key !== env.key)
                      .map((other) => (
                        <option key={other.key} value={other.key}>
                          {other.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            </fieldset>
          ))}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateTargetDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const client = getApiClient();
  const [form, setForm] = useState({
    provider: 'vercel' as DeploymentTargetResource['provider'],
    name: '',
    projectId: '',
    token: '',
    defaultBranch: '',
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      client.deployments.targets.create({
        provider: form.provider,
        name: form.name,
        projectId: form.projectId,
        token: form.token,
        defaultBranch: form.defaultBranch || undefined,
      }),
    onSuccess: onSaved,
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Failed to save target'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold">Connect deployment target</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The token is encrypted at rest and never shown again.
        </p>
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Provider</span>
            <select
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value as DeploymentTargetResource['provider'] })}
              className="w-full rounded-md border bg-background px-3 py-1.5"
            >
              <option value="vercel">Vercel</option>
              <option value="netlify">Netlify</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Name</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-md border bg-background px-3 py-1.5"
              placeholder="Marketing site"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">
              {form.provider === 'vercel' ? 'Vercel project id' : 'Netlify site id'}
            </span>
            <input
              value={form.projectId}
              onChange={(e) => setForm({ ...form, projectId: e.target.value })}
              className="w-full rounded-md border bg-background px-3 py-1.5"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Access token</span>
            <input
              type="password"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              className="w-full rounded-md border bg-background px-3 py-1.5"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Default branch (optional)</span>
            <input
              value={form.defaultBranch}
              onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })}
              className="w-full rounded-md border bg-background px-3 py-1.5"
              placeholder="main"
            />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || !form.name || !form.projectId || !form.token}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {save.isPending ? 'Verifying…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}

function LogsDialog({ deployment, onClose }: { deployment: DeploymentResource; onClose: () => void }) {
  const client = getApiClient();
  const logsQuery = useQuery({
    queryKey: ['deployment-logs', deployment.id],
    queryFn: async () => (await client.deployments.logs(deployment.id)).data?.log ?? '',
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex h-[70vh] w-full max-w-3xl flex-col rounded-xl border bg-background p-6 shadow-lg">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Build log</h2>
          <StatusBadge status={deployment.status} />
        </div>
        {deployment.errorMessage && (
          <p className="mt-2 rounded-md bg-rose-50 p-2 text-sm text-rose-800">{deployment.errorMessage}</p>
        )}
        <pre className="mt-3 flex-1 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
          {logsQuery.isLoading ? 'Loading…' : logsQuery.data || deployment.logExcerpt || 'No log available.'}
        </pre>
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
