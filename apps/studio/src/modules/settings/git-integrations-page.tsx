import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  GitBranch,
  Plus,
  Trash2,
  Save,
  KeyRound,
  RefreshCw,
  ExternalLink,
  GitPullRequest,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useSaveHandler } from '@/lib/keybindings/use-keybindings';
import type {
  GitIntegrationResource,
  PullRequestResource,
} from '@lumibase/contracts/schemas';
import { gitApi, type CreateIntegrationPayload } from './git-api';

const CI_BADGE: Record<string, string> = {
  success: 'bg-emerald-100 text-emerald-800',
  failure: 'bg-red-100 text-red-800',
  pending: 'bg-amber-100 text-amber-800',
  unknown: 'bg-muted text-muted-foreground',
};

export function GitIntegrationsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['git-integrations'],
    queryFn: () => gitApi.list(),
  });

  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<GitIntegrationResource | null>(null);
  const integrations = query.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => gitApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['git-integrations'] }),
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) => gitApi.rotateSecret(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['git-integrations'] }),
  });

  const authorize = async (id: string) => {
    try {
      const { authorizeUrl } = await gitApi.authorize(id);
      window.open(authorizeUrl, '_blank', 'noopener');
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {t('gitIntegrations', 'Git repositories')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect GitHub or GitLab repositories to track pull requests and CI.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          <Plus className="h-4 w-4" /> Connect repository
        </button>
      </header>

      <div className="grid gap-4">
        {query.isLoading && (
          <div className="text-muted-foreground">Loading…</div>
        )}
        {query.isError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            {(query.error as Error).message}
          </div>
        )}
        {integrations.length === 0 && !query.isLoading && !query.isError && (
          <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
            No repositories connected yet.
          </div>
        )}
        {integrations.map((it) => (
          <div
            key={it.id}
            className="rounded-lg border bg-background p-4 shadow-sm"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-4">
                <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 text-blue-600">
                  <GitBranch className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold">
                    {it.displayName}{' '}
                    <span className="text-xs font-normal text-muted-foreground">
                      ({it.provider})
                    </span>
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {it.repoFullName}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${
                        it.status === 'connected'
                          ? 'bg-emerald-100 text-emerald-800'
                          : it.status === 'error'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {it.status}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {it.authMethod === 'app' ? 'App install' : 'OAuth / PAT'}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  title="View pull requests"
                  onClick={() => setViewing(it)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <GitPullRequest className="h-4 w-4" />
                </button>
                {it.authMethod === 'pat' && (
                  <button
                    title="Authorize via OAuth"
                    onClick={() => authorize(it.id)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </button>
                )}
                <button
                  title="Rotate webhook secret"
                  onClick={() => {
                    if (confirm('Rotate the webhook secret for this repo?'))
                      rotateMutation.mutate(it.id);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <KeyRound className="h-4 w-4" />
                </button>
                <button
                  title="Disconnect"
                  onClick={() => {
                    if (confirm('Disconnect this repository?'))
                      deleteMutation.mutate(it.id);
                  }}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="mt-3 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
              <span className="font-medium">Webhook URL:</span>{' '}
              <code className="break-all">{it.webhookUrl}</code>
            </div>
          </div>
        ))}
      </div>

      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {viewing && (
        <PullRequestsDrawer
          integration={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [provider, setProvider] = useState<'github' | 'gitlab'>('github');
  const [repoFullName, setRepoFullName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [authMethod, setAuthMethod] = useState<'app' | 'pat'>('pat');
  const [token, setToken] = useState('');
  const [installationId, setInstallationId] = useState('');

  const mutation = useMutation({
    mutationFn: () => {
      const payload: CreateIntegrationPayload = {
        provider,
        repoFullName,
        displayName: displayName || repoFullName,
        authMethod,
        ...(authMethod === 'pat' && token ? { token } : {}),
        ...(authMethod === 'app' && installationId ? { installationId } : {}),
      };
      return gitApi.create(payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['git-integrations'] });
      onClose();
    },
  });

  const valid =
    !!repoFullName &&
    (authMethod === 'pat' ? !!token : !!installationId);

  useSaveHandler(() => mutation.mutate(), !mutation.isPending && valid);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border bg-background p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold">Connect repository</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Provider</label>
              <select
                value={provider}
                onChange={(e) =>
                  setProvider(e.target.value as 'github' | 'gitlab')
                }
                className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
              >
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Auth</label>
              <select
                value={authMethod}
                onChange={(e) =>
                  setAuthMethod(e.target.value as 'app' | 'pat')
                }
                className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
              >
                <option value="pat">OAuth / PAT</option>
                <option value="app">App installation</option>
              </select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              Repository (owner/repo)
            </label>
            <input
              type="text"
              value={repoFullName}
              onChange={(e) => setRepoFullName(e.target.value)}
              placeholder="acme/website"
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              Display name (optional)
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </div>
          {authMethod === 'pat' ? (
            <div>
              <label className="mb-1 block text-sm font-medium">
                Access token
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste a PAT, or leave blank and use OAuth after"
                className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Stored encrypted. You can also connect via OAuth from the list.
              </p>
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-sm font-medium">
                Installation ID
              </label>
              <input
                type="text"
                value={installationId}
                onChange={(e) => setInstallationId(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </div>
          )}
          {mutation.isError && (
            <p className="text-sm text-destructive">
              {(mutation.error as Error).message}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!valid || mutation.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              <Save className="mr-2 inline h-4 w-4" />
              {mutation.isPending ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PullRequestsDrawer({
  integration,
  onClose,
}: {
  integration: GitIntegrationResource;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [log, setLog] = useState<{ pr: number; text: string } | null>(null);

  const prsQuery = useQuery({
    queryKey: ['git-prs', integration.id],
    queryFn: () => gitApi.listPullRequests(integration.id),
  });

  const refresh = useMutation({
    mutationFn: () => gitApi.refreshPullRequests(integration.id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['git-prs', integration.id] }),
  });

  const prs = prsQuery.data ?? [];

  const validate = async (prNumber: number) => {
    try {
      const r = await gitApi.validate(integration.id, prNumber);
      alert(
        `Validation ${r.state}: ${r.summary}` +
          (r.statusPosted ? '' : '\n(commit status not posted — missing write scope)'),
      );
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const viewLogs = async (prNumber: number) => {
    try {
      const runs = await gitApi.listCi(integration.id, prNumber);
      if (runs.length === 0) {
        setLog({ pr: prNumber, text: 'No CI runs recorded for this PR yet.' });
        return;
      }
      const { log: text } = await gitApi.fetchLog(
        integration.id,
        runs[0]!.providerRunId,
      );
      setLog({ pr: prNumber, text });
    } catch (e) {
      setLog({ pr: prNumber, text: (e as Error).message });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm">
      <div className="flex h-full w-full max-w-xl flex-col border-l bg-background shadow-xl">
        <div className="flex items-center justify-between border-b p-4">
          <div>
            <h2 className="font-semibold">Pull requests</h2>
            <p className="text-xs text-muted-foreground">
              {integration.repoFullName}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3 w-3 ${refresh.isPending ? 'animate-spin' : ''}`}
              />
              Refresh
            </button>
            <button onClick={onClose} className="hover:text-destructive">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {prsQuery.isLoading && (
            <div className="text-muted-foreground">Loading…</div>
          )}
          {prs.length === 0 && !prsQuery.isLoading && (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No cached pull requests. Click Refresh to pull from the provider.
            </div>
          )}
          {prs.map((pr: PullRequestResource) => (
            <div key={pr.id} className="rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  #{pr.number} {pr.title}
                </span>
                <span
                  className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${
                    CI_BADGE[pr.ciStatus] ?? CI_BADGE.unknown
                  }`}
                >
                  {pr.ciStatus}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {pr.state} · {pr.author ?? 'unknown'}
                </span>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => validate(pr.number)}
                    className="text-primary hover:underline"
                  >
                    Validate
                  </button>
                  <button
                    onClick={() => viewLogs(pr.number)}
                    className="text-primary hover:underline"
                  >
                    View CI log
                  </button>
                  {pr.previewUrl && (
                    <a
                      href={pr.previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      Preview <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {log && (
          <div className="max-h-[40%] overflow-auto border-t bg-black p-3 font-mono text-xs text-green-200">
            <div className="mb-2 flex items-center justify-between text-green-400">
              <span>Log · PR #{log.pr}</span>
              <button onClick={() => setLog(null)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <pre className="whitespace-pre-wrap">{log.text}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
