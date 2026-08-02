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
  const [creatingAccess, setCreatingAccess] = useState<'role' | 'policy' | null>(null);
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
    mutationFn: async (input: {
      name: string;
      description?: string;
      expiresAt?: string | null;
      publishable?: boolean;
      allowedOrigins?: string[];
    }) => (await client.apiKeys.create(input)).data,
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

  /**
   * The whole point of the origin allowlist is that it is adjustable on a live
   * key — a mistyped origin, or a new frontend domain, must not force a token
   * rotation and a redeploy of whatever ships the key.
   */
  const setAllowedOrigins = useMutation({
    mutationFn: async (input: { id: string; allowedOrigins: string[] }) =>
      (await client.apiKeys.setAllowedOrigins(input.id, input.allowedOrigins)).data,
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

  // Inline "create new" for the attach pickers. A freshly created role/policy
  // has no permission rows yet, so attaching it can never raise a conflict —
  // we reuse the existing attach mutations so the conflict-preview + cache
  // invalidation paths stay identical to picking an existing one.
  const createRole = useMutation({
    mutationFn: async (input: { name: string; adminAccess: boolean; appAccess: boolean }) =>
      (await client.roles.create(input)).data,
    onSuccess: (role) => {
      setCreatingAccess(null);
      queryClient.invalidateQueries({ queryKey: ['access', 'roles'] });
      if (selectedKey) attachRole.mutate(role.id);
    },
  });

  const createPolicy = useMutation({
    mutationFn: async (input: { name: string; adminAccess: boolean }) =>
      (await client.policies.create(input)).data,
    onSuccess: (policy) => {
      setCreatingAccess(null);
      queryClient.invalidateQueries({ queryKey: ['access', 'policies'] });
      if (selectedKey) attachPolicy.mutate(policy.id);
    },
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
                      {key.publishable && (
                        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-400">
                            Publishable
                          </span>
                          <span className="text-muted-foreground">
                            {key.allowedOrigins.length > 0
                              ? key.allowedOrigins.join(', ')
                              : 'any origin'}
                          </span>
                        </p>
                      )}
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

              {selectedKey.publishable && (
                <AllowedOriginsSection
                  // Remount on key change so the textarea shows the selected
                  // key's origins rather than carrying over unsaved edits.
                  key={selectedKey.id}
                  origins={selectedKey.allowedOrigins}
                  isPending={setAllowedOrigins.isPending}
                  onSave={(allowedOrigins) =>
                    setAllowedOrigins.mutate({ id: selectedKey.id, allowedOrigins })
                  }
                />
              )}

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
                createLabel="New role"
                isPending={attachRole.isPending || detachRole.isPending || createRole.isPending}
                onAttach={(id) => attachRole.mutate(id)}
                onDetach={(id) => detachRole.mutate(id)}
                onCreateNew={() => setCreatingAccess('role')}
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
                createLabel="New policy"
                isPending={attachPolicy.isPending || detachPolicy.isPending || createPolicy.isPending}
                onAttach={(id) => attachPolicy.mutate(id)}
                onDetach={(id) => detachPolicy.mutate(id)}
                onCreateNew={() => setCreatingAccess('policy')}
              />

              {conflictReport && (
                <ConflictReportPanel
                  conflicts={conflictReport.conflicts}
                  warnings={conflictReport.warnings}
                />
              )}
              <MutationError
                error={
                  attachRole.error ??
                  attachPolicy.error ??
                  rotateKey.error ??
                  revokeKey.error ??
                  setAllowedOrigins.error
                }
              />
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
      {creatingAccess && (
        <CreateAccessDialog
          kind={creatingAccess}
          isPending={creatingAccess === 'role' ? createRole.isPending : createPolicy.isPending}
          error={creatingAccess === 'role' ? createRole.error : createPolicy.error}
          onClose={() => setCreatingAccess(null)}
          onCreate={(input) => {
            if (creatingAccess === 'role') {
              createRole.mutate({
                name: input.name,
                adminAccess: input.adminAccess,
                appAccess: input.appAccess ?? true,
              });
            } else {
              createPolicy.mutate({ name: input.name, adminAccess: input.adminAccess });
            }
          }}
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

/**
 * Edit a publishable key's browser-origin allowlist in place.
 *
 * Previously the allowlist could only be set at create time, so tightening it —
 * or fixing a typo — meant rotating the token and redeploying whatever ships it.
 * That defeats the purpose of the control, which exists precisely because the
 * key is already out in clients.
 *
 * Saving an empty box removes the constraint. That widens access, so it is
 * confirmed rather than silently accepted.
 */
function AllowedOriginsSection({
  origins,
  isPending,
  onSave,
}: {
  origins: string[];
  isPending: boolean;
  onSave: (allowedOrigins: string[]) => void;
}) {
  const saved = origins.join('\n');
  const [draft, setDraft] = useState(saved);
  const parsed = parseOriginList(draft);
  const dirty = parsed.join('\n') !== origins.join('\n');

  return (
    <section className="space-y-2">
      <h4 className="text-xs font-semibold uppercase text-muted-foreground">Allowed origins</h4>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={2}
        placeholder="https://app.example.com"
        aria-label="Allowed origins, one per line"
        className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
      />
      <p className="text-xs text-muted-foreground">
        One per line. Empty means <strong>any origin</strong>. Requests without an
        origin — native or server-side callers — are always allowed, so this is
        not a defence against <code>curl</code>.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!dirty || isPending}
          onClick={() => {
            if (
              parsed.length === 0 &&
              origins.length > 0 &&
              !confirm('Remove the origin allowlist? This key will then work from any website.')
            ) {
              return;
            }
            onSave(parsed);
          }}
          className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
        >
          {isPending ? 'Saving…' : 'Save origins'}
        </button>
        {dirty && !isPending && (
          <button
            type="button"
            onClick={() => setDraft(saved)}
            className="text-xs text-muted-foreground hover:underline"
          >
            Reset
          </button>
        )}
      </div>
    </section>
  );
}

function AttachmentSection({
  title,
  empty,
  attachments,
  available,
  attachLabel,
  createLabel,
  isPending,
  onAttach,
  onDetach,
  onCreateNew,
}: {
  title: string;
  empty: string;
  attachments: Array<{ id: string; label: string; priority: number }>;
  available: Array<{ id: string; label: string }>;
  attachLabel: string;
  createLabel?: string;
  isPending: boolean;
  onAttach: (id: string) => void;
  onDetach: (id: string) => void;
  onCreateNew?: () => void;
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
      <div className="flex items-center gap-2">
        {available.length > 0 && (
          <select
            defaultValue=""
            disabled={isPending}
            onChange={(event) => {
              const value = event.target.value;
              if (value) onAttach(value);
              event.target.value = '';
            }}
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
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
        {onCreateNew && (
          <button
            type="button"
            disabled={isPending}
            onClick={onCreateNew}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
            {createLabel ?? 'New'}
          </button>
        )}
      </div>
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

/** Split a textarea of origins into a clean list; blank lines are dropped. */
export function parseOriginList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
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
  onCreate: (input: {
    name: string;
    description?: string;
    expiresAt?: string | null;
    publishable?: boolean;
    allowedOrigins?: string[];
  }) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [publishable, setPublishable] = useState(false);
  const [allowedOrigins, setAllowedOrigins] = useState('');

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
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={publishable}
              onChange={(event) => setPublishable(event.target.checked)}
              className="mt-0.5 size-4"
            />
            <span>
              <span className="block text-xs font-medium">
                Publishable (safe to embed in a browser or app)
              </span>
              <span className="block text-xs text-muted-foreground">
                Issues an <code>lbk_pub_…</code> token. It is <strong>not</strong> a
                secret — anyone who loads your app can read it, so scope it as if
                it were already public. Buys per-key quota, rotation and audit,
                not confidentiality.
              </span>
            </span>
          </label>
          {publishable && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                Allowed origins (one per line, optional)
              </span>
              <textarea
                value={allowedOrigins}
                onChange={(event) => setAllowedOrigins(event.target.value)}
                rows={2}
                placeholder={'https://app.example.com'}
                className="w-full rounded-md border bg-background px-3 py-1.5 font-mono text-xs"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Blocks other websites from using this key in a browser. Leave
                empty for no constraint. Requests without an origin — native or
                server-side callers — are always allowed, so this is not a
                defence against <code>curl</code>.
              </span>
            </label>
          )}
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
                publishable: publishable || undefined,
                allowedOrigins: publishable ? parseOriginList(allowedOrigins) : undefined,
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

/**
 * Inline dialog to create a role or policy without leaving the API-keys
 * screen. On success the parent auto-attaches the new entity to the selected
 * key. Permission rows are configured later on the dedicated Roles/Policies
 * pages — here we only expose name + the bypass/access flags.
 */
function CreateAccessDialog({
  kind,
  isPending,
  error,
  onClose,
  onCreate,
}: {
  kind: 'role' | 'policy';
  isPending: boolean;
  error: unknown;
  onClose: () => void;
  onCreate: (input: { name: string; adminAccess: boolean; appAccess?: boolean }) => void;
}) {
  const [name, setName] = useState('');
  const [adminAccess, setAdminAccess] = useState(false);
  const [appAccess, setAppAccess] = useState(true);

  const isRole = kind === 'role';

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg border bg-background p-5 shadow-lg">
        <h3 className="mb-3 text-base font-semibold">{isRole ? 'New role' : 'New policy'}</h3>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              placeholder={isRole ? 'editor' : 'read-only'}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={adminAccess}
              onChange={(event) => setAdminAccess(event.target.checked)}
              className="h-4 w-4 rounded border"
            />
            <span className="text-xs">
              Admin access
              <span className="ml-1 text-muted-foreground">(bypass all permission checks)</span>
            </span>
          </label>
          {isRole && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={appAccess}
                onChange={(event) => setAppAccess(event.target.checked)}
                className="h-4 w-4 rounded border"
              />
              <span className="text-xs">
                App access
                <span className="ml-1 text-muted-foreground">(can sign in to Studio)</span>
              </span>
            </label>
          )}
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
              onCreate(
                isRole
                  ? { name: name.trim(), adminAccess, appAccess }
                  : { name: name.trim(), adminAccess },
              )
            }
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {isPending ? 'Creating…' : 'Create & attach'}
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
