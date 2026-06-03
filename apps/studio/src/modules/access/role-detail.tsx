import type { AccessConflict, AccessConflictReport } from '@lumibase/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, Plus, Trash2, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';

/**
 * Role detail page — flag toggles + attached policies + assigned users.
 * Wires to the Phase C `/api/v1/roles/:id` endpoints exposed in the SDK.
 */
export function RoleDetailPage() {
  const { id } = useParams({ from: '/admin-layout/access/roles/$id' });
  const client = getApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [conflictReport, setConflictReport] = useState<AccessConflictReport | null>(null);

  const roleQuery = useQuery({
    queryKey: ['access', 'role', id],
    queryFn: async () => (await client.roles.detail(id)).data,
  });

  const policiesQuery = useQuery({
    queryKey: ['access', 'policies'],
    queryFn: async () => (await client.policies.list()).data,
  });

  const updateRole = useMutation({
    mutationFn: (patch: Parameters<typeof client.roles.update>[1]) =>
      client.roles.update(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'role', id] }),
  });

  const removeRole = useMutation({
    mutationFn: () => client.roles.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['access', 'roles'] });
      navigate({ to: '/access/roles' });
    },
  });

  const attachPolicy = useMutation({
    mutationFn: async (policyId: string) => {
      const report = (await client.access.checkConflicts({
        target: { type: 'role', id },
        addPolicies: [policyId],
      })).data;

      setConflictReport(report);
      if (report.conflicts.length > 0) {
        throw new Error('Policy conflicts must be resolved before attaching.');
      }
      if (
        report.warnings.length > 0 &&
        !confirm(`Attach policy with ${report.warnings.length} permission warning(s)?`)
      ) {
        throw new Error('Attach cancelled.');
      }

      return client.roles.attachPolicy(id, { policyId });
    },
    onSuccess: () => {
      setConflictReport(null);
      queryClient.invalidateQueries({ queryKey: ['access', 'role', id] });
    },
  });

  const detachPolicy = useMutation({
    mutationFn: (policyId: string) => client.roles.detachPolicy(id, policyId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'role', id] }),
  });

  const assignUser = useMutation({
    mutationFn: (userId: string) => client.roles.assignUser(id, { userId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'role', id] }),
  });

  const removeUser = useMutation({
    mutationFn: (userId: string) => client.roles.removeUser(id, userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'role', id] }),
  });

  if (roleQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading role…</p>;
  }
  if (roleQuery.error || !roleQuery.data) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Role not found.
      </div>
    );
  }

  const role = roleQuery.data;
  const policiesById = new Map((policiesQuery.data ?? []).map((p) => [p.id, p]));
  const attachedIds = new Set(role.policies.map((p) => p.policyId));
  const detachable = role.policies.slice().sort((a, b) => a.priority - b.priority);
  const available = (policiesQuery.data ?? []).filter((p) => !attachedIds.has(p.id));

  return (
    <div className="space-y-5">
      <Link
        to="/access/roles"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" /> Back to roles
      </Link>

      <header className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-2">
          <input
            value={role.name}
            onChange={(e) => updateRole.mutate({ name: e.target.value })}
            className="w-full rounded-md border bg-background px-3 py-1.5 text-lg font-semibold"
          />
          <textarea
            value={role.description ?? ''}
            placeholder="Add description…"
            onChange={(e) => updateRole.mutate({ description: e.target.value })}
            rows={2}
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm text-muted-foreground"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete role "${role.name}"?`)) removeRole.mutate();
          }}
          className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
      </header>

      <section className="grid gap-3 sm:grid-cols-2">
        <FlagToggle
          label="Admin access"
          hint="Bypass all permission checks for members."
          checked={role.adminAccess}
          onChange={(v) => updateRole.mutate({ adminAccess: v })}
        />
        <FlagToggle
          label="App access"
          hint="Members can sign in to Studio."
          checked={role.appAccess}
          onChange={(v) => updateRole.mutate({ appAccess: v })}
        />
      </section>

      <section className="rounded-lg border p-4">
        <header className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Attached policies</h3>
          <span className="text-xs text-muted-foreground">{role.policies.length} attached</span>
        </header>
        {detachable.length === 0 && (
          <p className="text-xs text-muted-foreground">No policies attached yet.</p>
        )}
        {detachable.length > 0 && (
          <ul className="space-y-1">
            {detachable.map((p) => {
              const meta = policiesById.get(p.policyId);
              return (
                <li
                  key={p.policyId}
                  className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2 text-sm"
                >
                  <Link
                    to="/access/policies/$id"
                    params={{ id: p.policyId }}
                    className="text-primary hover:underline"
                  >
                    {meta?.name ?? p.policyId}
                  </Link>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      priority {p.priority}
                    </span>
                    <button
                      type="button"
                      onClick={() => detachPolicy.mutate(p.policyId)}
                      className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label="Detach policy"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {available.length > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <select
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                if (v) {
                  attachPolicy.mutate(v);
                  e.target.value = '';
                }
              }}
              className="flex-1 rounded-md border bg-background px-2 py-1 text-xs"
            >
              <option value="" disabled>
                Attach an existing policy…
              </option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Link
              to="/access/policies"
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
            >
              <Plus className="h-3 w-3" /> Manage policies
            </Link>
          </div>
        )}
        {conflictReport && (
          <ConflictReportPanel
            conflicts={conflictReport.conflicts}
            warnings={conflictReport.warnings}
          />
        )}
        {attachPolicy.error && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {(attachPolicy.error as Error).message}
          </p>
        )}
      </section>

      <section className="rounded-lg border p-4">
        <header className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Members</h3>
          <span className="text-xs text-muted-foreground">{role.users.length} assigned</span>
        </header>
        {role.users.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No users assigned yet. Provide a user id below to assign one.
          </p>
        )}
        {role.users.length > 0 && (
          <ul className="space-y-1">
            {role.users.map((u) => (
              <li
                key={u.userId}
                className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2 text-xs"
              >
                <span className="font-mono">{u.userId}</span>
                <button
                  type="button"
                  onClick={() => removeUser.mutate(u.userId)}
                  className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Remove user"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <AssignUserInline onAssign={(userId) => assignUser.mutate(userId)} />
      </section>
    </div>
  );
}

function FlagToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 rounded-md border p-3 text-sm hover:bg-accent/30">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div>
        <span className="font-medium">{label}</span>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </label>
  );
}

function ConflictReportPanel({
  conflicts,
  warnings,
}: {
  conflicts: AccessConflict[];
  warnings: AccessConflict[];
}) {
  if (conflicts.length === 0 && warnings.length === 0) {
    return (
      <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700">
        No permission conflicts detected.
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 font-medium text-amber-800">
        <AlertTriangle className="h-3.5 w-3.5" />
        Permission conflict preview
      </div>
      {conflicts.length > 0 && (
        <ConflictList
          title="Blocking"
          items={conflicts}
          className="border-destructive/30 bg-destructive/10 text-destructive"
        />
      )}
      {warnings.length > 0 && (
        <ConflictList
          title="Warnings"
          items={warnings}
          className="border-amber-500/30 bg-background/60 text-foreground"
        />
      )}
    </div>
  );
}

function ConflictList({
  title,
  items,
  className,
}: {
  title: string;
  items: AccessConflict[];
  className: string;
}) {
  return (
    <div className={`rounded-md border px-2 py-1.5 ${className}`}>
      <p className="mb-1 font-medium">{title}</p>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li key={`${item.collection}:${item.action}:${index}`}>
            <span className="font-mono">{item.collection}</span> / {item.action}: {item.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AssignUserInline({ onAssign }: { onAssign: (userId: string) => void }) {
  const [userId, setUserId] = useState('');
  return (
    <div className="mt-3 flex items-center gap-2">
      <input
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        placeholder="user id"
        className="flex-1 rounded-md border bg-background px-2 py-1 text-xs font-mono"
      />
      <button
        type="button"
        disabled={!userId.trim()}
        onClick={() => {
          onAssign(userId.trim());
          setUserId('');
        }}
        className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
      >
        <UserPlus className="h-3 w-3" /> Assign
      </button>
    </div>
  );
}
