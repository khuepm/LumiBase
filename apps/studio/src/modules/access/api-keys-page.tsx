import type {
  AccessConflict,
  AccessConflictReport,
  ApiKeyResource,
  ApiKeySecretResult,
  PermissionAction,
  PermissionRow,
  PolicyDetail,
} from '@lumibase/sdk';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, RefreshCcw, ShieldAlert, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

const ACTIONS: PermissionAction[] = ['create', 'read', 'update', 'delete', 'share'];

export function ApiKeysPage() {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [secret, setSecret] = useState<ApiKeySecretResult | null>(null);
  const [conflictReport, setConflictReport] = useState<AccessConflictReport | null>(null);

  const apiKeysQuery = useQuery({
    queryKey: ['access', 'api-keys'],
    queryFn: async () => (await client.apiKeys.list()).data,
  });
  const rolesQuery = useQuery({
    queryKey: ['access', 'roles'],
    queryFn: async () => (await client.roles.list()).data,
  });
  const policiesQuery = useQuery({
    queryKey: ['access', 'policies'],
    queryFn: async () => (await client.policies.list()).data,
  });

  const keys = apiKeysQuery.data ?? [];
  const selectedKey = keys.find((key) => key.id === selectedId) ?? keys[0] ?? null;
  const roleNames = new Map((rolesQuery.data ?? []).map((role) => [role.id, role.name]));
  const policyNames = new Map((policiesQuery.data ?? []).map((policy) => [policy.id, policy.name]));

  const roleDetailQueries = useQueries({
    queries: (selectedKey?.roles ?? []).map((attachment) => ({
      queryKey: ['access', 'role', attachment.roleId],
      queryFn: async () => (await client.roles.detail(attachment.roleId)).data,
      enabled: !!selectedKey,
    })),
  });
  const rolePolicyIds = roleDetailQueries
    .flatMap((query) => query.data?.policies ?? [])
    .map((attachment) => attachment.policyId);
  const effectivePolicyIds = Array.from(
    new Set([...(selectedKey?.policies ?? []).map((p) => p.policyId), ...rolePolicyIds]),
  );
  const policyDetailQueries = useQueries({
    queries: effectivePolicyIds.map((policyId) => ({
      queryKey: ['access', 'policy', policyId],
      queryFn: async () => (await client.policies.detail(policyId)).data,
      enabled: !!selectedKey,
    })),
  });
  const policyDetails = policyDetailQueries
    .map((query) => query.data)
    .filter((policy): policy is PolicyDetail => !!policy);
  const previewRows = useMemo(() => buildPreviewRows(policyDetails), [policyDetails]);

  const createKey = useMutation({
    mutationFn: async (input: { name: string; description?: string; expiresAt?: string | null }) =>
      (await client.apiKeys.create(input)).data,
    onSuccess: (data) => {
      setSecret(data);
      setSelectedId(data.id);
      queryClient.invalidateQueries({ queryKey: ['access', 'api-keys'] });
    },
  });

  const rotateKey = useMutation({
    mutationFn: async (id: string) => (await client.apiKeys.rotate(id)).data,
    onSuccess: (data) => {
      setSecret(data);
      queryClient.invalidateQueries({ queryKey: ['access', 'api-keys'] });
    },
  });

  const revokeKey = useMutation({
    mutationFn: (id: string) => client.apiKeys.revoke(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'api-keys'] }),
  });

  const attachRole = useMutation({
    mutationFn: async (roleId: string) => {
      if (!selectedKey) throw new Error('Select an API key first.');
      const role = (await client.roles.detail(roleId)).data;
      const addPolicies = role.policies.map((policy) => policy.policyId);
      const report = (await client.apiKeys.previewConflicts(selectedKey.id, { addPolicies })).data;
      setConflictReport(report);
      if (report.conflicts.length > 0) throw new Error('Policy conflicts must be resolved before attaching.');
      const overrideWarnings = report.warnings.length > 0;
      if (overrideWarnings && !confirm(`Attach role with ${report.warnings.length} permission warning(s)?`)) {
        throw new Error('Attach cancelled.');
      }
      return client.apiKeys.attachRole(selectedKey.id, { roleId, overrideWarnings });
    },
    onSuccess: () => {
      setConflictReport(null);
      queryClient.invalidateQueries({ queryKey: ['access', 'api-keys'] });
    },
  });

  const detachRole = useMutation({
    mutationFn: async (roleId: string) => {
      if (!selectedKey) throw new Error('Select an API key first.');
      return client.apiKeys.detachRole(selectedKey.id, roleId);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'api-keys'] }),
  });

  const attachPolicy = useMutation({
    mutationFn: async (policyId: string) => {
      if (!selectedKey) throw new Error('Select an API key first.');
      const report = (await client.apiKeys.previewConflicts(selectedKey.id, { addPolicies: [policyId] })).data;
      setConflictReport(report);
      if (report.conflicts.length > 0) throw new Error('Policy conflicts must be resolved before attaching.');
      const overrideWarnings = report.warnings.length > 0;
      if (overrideWarnings && !confirm(`Attach policy with ${report.warnings.length} permission warning(s)?`)) {
        throw new Error('Attach cancelled.');
      }
      return client.apiKeys.attachPolicy(selectedKey.id, { policyId, overrideWarnings });
    },
    onSuccess: () => {
      setConflictReport(null);
      queryClient.invalidateQueries({ queryKey: ['access', 'api-keys'] });
    },
  });

  const detachPolicy = useMutation({
    mutationFn: async (policyId: string) => {
      if (!selectedKey) throw new Error('Select an API key first.');
      return client.apiKeys.detachPolicy(selectedKey.id, policyId);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'api-keys'] }),
  });

  const attachedRoleIds = new Set((selectedKey?.roles ?? []).map((role) => role.roleId));
  const attachedPolicyIds = new Set((selectedKey?.policies ?? []).map((policy) => policy.policyId));
  const availableRoles = (rolesQuery.data ?? []).filter((role) => !attachedRoleIds.has(role.id));
  const availablePolicies = (policiesQuery.data ?? []).filter((policy) => !attachedPolicyIds.has(policy.id));

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">API keys</h2>
          <p className="text-xs text-muted-foreground">
            Issue scoped bearer tokens and attach roles or policies to shape data access.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> New API key
        </button>
      </header>

      {apiKeysQuery.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load API keys.
        </div>
      )}

      {apiKeysQuery.isLoading && <p className="text-sm text-muted-foreground">Loading API keys…</p>}

      {apiKeysQuery.data && apiKeysQuery.data.length === 0 && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <KeyRound className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <h3 className="text-base font-medium">No API keys yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">Create a key to grant machine access.</p>
        </div>
      )}

      {keys.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Prefix</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Last used</th>
                  <th className="w-24" />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr
                    key={key.id}
                    className={cn('border-t hover:bg-muted/20', selectedKey?.id === key.id && 'bg-muted/30')}
                  >
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() => setSelectedId(key.id)}
                        className="text-left font-medium text-primary hover:underline"
                      >
                        {key.name}
                      </button>
                      <p className="text-xs text-muted-foreground">{key.description ?? '—'}</p>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{key.prefix}</td>
                    <td className="px-4 py-2 text-xs">
                      <StatusBadge apiKey={key} />
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(key.lastUsedAt)}</td>
                    <td className="px-2 py-2">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          aria-label={`Rotate API key ${key.name}`}
                          onClick={() => {
                            if (confirm(`Rotate API key "${key.name}"?`)) rotateKey.mutate(key.id);
                          }}
                          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <RefreshCcw className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Revoke API key ${key.name}`}
                          disabled={!!key.revokedAt}
                          onClick={() => {
                            if (confirm(`Revoke API key "${key.name}"?`)) revokeKey.mutate(key.id);
                          }}
                          className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedKey && (
            <aside className="space-y-4 rounded-lg border p-4">
              <div>
                <h3 className="text-sm font-semibold">{selectedKey.name}</h3>
                <p className="font-mono text-xs text-muted-foreground">{selectedKey.id}</p>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <Info label="Created" value={formatDate(selectedKey.createdAt)} />
                <Info label="Expires" value={formatDate(selectedKey.expiresAt)} />
                <Info label="Rotated" value={formatDate(selectedKey.rotatedAt)} />
                <Info label="Last IP" value={selectedKey.lastUsedIp ?? '—'} />
              </dl>

              <AttachmentSection
                title="Roles"
                empty="No roles attached."
                attachments={selectedKey.roles.map((role) => ({
                  id: role.roleId,
                  label: roleNames.get(role.roleId) ?? role.roleId,
                  priority: role.priority,
                }))}
                available={availableRoles.map((role) => ({ id: role.id, label: role.name }))}
                attachLabel="Attach role…"
                isPending={attachRole.isPending || detachRole.isPending}
                onAttach={(id) => attachRole.mutate(id)}
                onDetach={(id) => detachRole.mutate(id)}
              />

              <AttachmentSection
                title="Direct policies"
                empty="No direct policies attached."
                attachments={selectedKey.policies.map((policy) => ({
                  id: policy.policyId,
                  label: policyNames.get(policy.policyId) ?? policy.policyId,
                  priority: policy.priority,
                }))}
                available={availablePolicies.map((policy) => ({ id: policy.id, label: policy.name }))}
                attachLabel="Attach policy…"
                isPending={attachPolicy.isPending || detachPolicy.isPending}
                onAttach={(id) => attachPolicy.mutate(id)}
                onDetach={(id) => detachPolicy.mutate(id)}
              />

              {conflictReport && (
                <ConflictReportPanel
                  conflicts={conflictReport.conflicts}
                  warnings={conflictReport.warnings}
                />
              )}
              <MutationError error={attachRole.error ?? attachPolicy.error ?? rotateKey.error ?? revokeKey.error} />
            </aside>
          )}
        </div>
      )}

      {selectedKey && (
        <EffectivePermissionsPreview
          rows={previewRows}
          isLoading={roleDetailQueries.some((query) => query.isLoading) || policyDetailQueries.some((query) => query.isLoading)}
        />
      )}

      {creating && (
        <CreateApiKeyDialog
          isPending={createKey.isPending}
          error={createKey.error}
          onClose={() => setCreating(false)}
          onCreate={(input) => createKey.mutate(input, { onSuccess: () => setCreating(false) })}
        />
      )}
      {secret && <SecretDialog result={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function StatusBadge({ apiKey }: { apiKey: ApiKeyResource }) {
  const expired = apiKey.expiresAt ? new Date(apiKey.expiresAt).getTime() < Date.now() : false;
  const revoked = !!apiKey.revokedAt;
  const label = revoked ? 'revoked' : expired ? 'expired' : 'active';
  return (
    <span
      className={cn(
        'inline-flex rounded-md px-2 py-0.5 text-[11px] font-medium',
        label === 'active' && 'bg-emerald-50 text-emerald-700',
        label === 'expired' && 'bg-amber-50 text-amber-700',
        label === 'revoked' && 'bg-rose-50 text-rose-700',
      )}
    >
      {label}
    </span>
  );
}

function AttachmentSection({
  title,
  empty,
  attachments,
  available,
  attachLabel,
  isPending,
  onAttach,
  onDetach,
}: {
  title: string;
  empty: string;
  attachments: Array<{ id: string; label: string; priority: number }>;
  available: Array<{ id: string; label: string }>;
  attachLabel: string;
  isPending: boolean;
  onAttach: (id: string) => void;
  onDetach: (id: string) => void;
}) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-semibold uppercase text-muted-foreground">{title}</h4>
      {attachments.length === 0 && <p className="text-xs text-muted-foreground">{empty}</p>}
      {attachments.length > 0 && (
        <ul className="space-y-1">
          {attachments.map((item) => (
            <li key={item.id} className="flex items-center justify-between rounded-md border bg-muted/20 px-2 py-1.5 text-xs">
              <span>{item.label}</span>
              <span className="flex items-center gap-2 text-muted-foreground">
                {item.priority}
                <button
                  type="button"
                  aria-label={`Detach ${item.label}`}
                  disabled={isPending}
                  onClick={() => onDetach(item.id)}
                  className="rounded-md p-0.5 hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && (
        <select
          defaultValue=""
          disabled={isPending}
          onChange={(event) => {
            const value = event.target.value;
            if (value) onAttach(value);
            event.target.value = '';
          }}
          className="w-full rounded-md border bg-background px-2 py-1 text-xs"
        >
          <option value="" disabled>
            {attachLabel}
          </option>
          {available.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      )}
    </section>
  );
}

function EffectivePermissionsPreview({
  rows,
  isLoading,
}: {
  rows: EffectiveRow[];
  isLoading: boolean;
}) {
  return (
    <section className="rounded-lg border p-4">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Effective permission preview</h3>
          <p className="text-xs text-muted-foreground">Policy rows reachable through direct policies and attached roles.</p>
        </div>
        <span className="text-xs text-muted-foreground">{rows.length} row{rows.length === 1 ? '' : 's'}</span>
      </header>
      {isLoading && <p className="text-sm text-muted-foreground">Loading preview…</p>}
      {!isLoading && rows.length === 0 && <p className="text-sm text-muted-foreground">No permission rows attached.</p>}
      {!isLoading && rows.length > 0 && (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-left uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Collection</th>
                {ACTIONS.map((action) => (
                  <th key={action} className="px-2 py-2 text-center font-medium">
                    {action}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groupPreviewRows(rows).map((collection) => (
                <tr key={collection.collection} className="border-t">
                  <td className="px-3 py-2 font-medium">{collection.collection}</td>
                  {ACTIONS.map((action) => {
                    const cell = collection.byAction[action] ?? [];
                    return (
                      <td key={action} className="px-2 py-2 align-top">
                        {cell.length === 0 ? (
                          <span className="block text-center text-muted-foreground">—</span>
                        ) : (
                          <ul className="space-y-1">
                            {cell.map((row) => (
                              <li key={`${row.policyId}:${row.permission.id}`} className="rounded bg-muted px-1.5 py-1">
                                <span className="font-medium">{row.policyName}</span>
                                <span className="ml-1 text-muted-foreground">{row.permission.fields.join(', ')}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface EffectiveRow {
  policyId: string;
  policyName: string;
  permission: PermissionRow;
}

function buildPreviewRows(policies: PolicyDetail[]): EffectiveRow[] {
  return policies.flatMap((policy) =>
    policy.permissions.map((permission) => ({
      policyId: policy.id,
      policyName: policy.name,
      permission,
    })),
  );
}

function groupPreviewRows(rows: EffectiveRow[]): Array<{
  collection: string;
  byAction: Partial<Record<PermissionAction, EffectiveRow[]>>;
}> {
  const grouped = new Map<string, Partial<Record<PermissionAction, EffectiveRow[]>>>();
  for (const row of rows) {
    const bucket = grouped.get(row.permission.collection) ?? {};
    const actionRows = bucket[row.permission.action] ?? [];
    bucket[row.permission.action] = [...actionRows, row];
    grouped.set(row.permission.collection, bucket);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([collection, byAction]) => ({ collection, byAction }));
}

function CreateApiKeyDialog({
  isPending,
  error,
  onClose,
  onCreate,
}: {
  isPending: boolean;
  error: unknown;
  onClose: () => void;
  onCreate: (input: { name: string; description?: string; expiresAt?: string | null }) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg border bg-background p-5 shadow-lg">
        <h3 className="mb-3 text-base font-semibold">New API key</h3>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              placeholder="production-sync"
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Expires</span>
            <input
              type="date"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </label>
          <MutationError error={error} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs">
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim() || isPending}
            onClick={() =>
              onCreate({
                name: name.trim(),
                description: description.trim() || undefined,
                expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59.999Z`).toISOString() : null,
              })
            }
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SecretDialog({ result, onClose }: { result: ApiKeySecretResult; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-lg rounded-lg border bg-background p-5 shadow-lg">
        <h3 className="text-base font-semibold">API key token</h3>
        <pre className="mt-3 max-h-32 overflow-auto rounded-md bg-muted p-3 text-xs">{result.token}</pre>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(result.token);
              setCopied(true);
            }}
            className="rounded-md border px-3 py-1.5 text-xs"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function ConflictReportPanel({
  conflicts,
  warnings,
}: {
  conflicts: AccessConflict[];
  warnings: AccessConflict[];
}) {
  if (!conflicts.length && !warnings.length) return null;
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
      <div className="mb-1 flex items-center gap-1 font-semibold">
        <ShieldAlert className="h-3.5 w-3.5" /> Access review
      </div>
      {[...conflicts, ...warnings].map((item, index) => (
        <p key={`${item.reason}-${index}`}>
          {item.severity}: {item.reason} ({item.existingPolicy} / {item.incomingPolicy})
        </p>
      ))}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function MutationError({ error }: { error: unknown }) {
  if (!error) return null;
  return <p role="alert" className="text-xs text-destructive">{(error as Error).message}</p>;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString();
}
