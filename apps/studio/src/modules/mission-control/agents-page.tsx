import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { missionControlApi, type AgentRoleInput, type AgentRoleRow } from './api';
import { MissionControlLayout } from './layout';

/**
 * Agents page (content-os-ui task 16; Req 16.1-16.5) — the agent role
 * library made operable. Roles define WHO can act (capability ceiling per
 * persona, model, prompt ref); the trust ledger defines HOW MUCH autonomy
 * each (role, capability) has earned. Creating/editing requires an admin —
 * the backend enforces it (403) and the page surfaces that instead of a
 * silently failing form.
 */

const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

function parseCapabilities(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function CreateRoleForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('');
  const [capabilities, setCapabilities] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: AgentRoleInput) => missionControlApi.createRole(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mc-agent-roles'] });
      onClose();
    },
  });

  const submit = () => {
    if (!NAME_PATTERN.test(name)) {
      setLocalError('Name must match ^[a-z][a-z0-9_-]*$');
      return;
    }
    setLocalError(null);
    mutation.mutate({
      name,
      capabilities: parseCapabilities(capabilities),
      ...(description ? { description } : {}),
      ...(model ? { model } : {}),
    });
  };

  return (
    <div className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">New agent role</h3>
        <button type="button" onClick={onClose} aria-label="Close create form" className="rounded-md border p-1 hover:bg-muted">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Name *</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="fact_checker"
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="default"
            className="w-full rounded-md border bg-background px-2 py-1.5"
          />
        </label>
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block text-muted-foreground">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-md border bg-background px-2 py-1.5"
          />
        </label>
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block text-muted-foreground">Capabilities (comma-separated) *</span>
          <input
            value={capabilities}
            onChange={(e) => setCapabilities(e.target.value)}
            placeholder="items:update, review:content"
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono"
          />
        </label>
      </div>
      {(localError || mutation.isError) && (
        <p className="text-xs text-destructive">
          {localError ??
            (mutation.error instanceof Error ? mutation.error.message : 'Create failed.')}
        </p>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={mutation.isPending || !name || !capabilities.trim()}
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {mutation.isPending ? 'Creating…' : 'Create role'}
      </button>
    </div>
  );
}

function RoleRow({ role }: { role: AgentRoleRow }) {
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['mc-agent-roles'] });

  const toggleMutation = useMutation({
    mutationFn: () => missionControlApi.updateRole(role.name, { enabled: !role.enabled }),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: () => missionControlApi.deleteRole(role.name),
    onSuccess: invalidate,
    onSettled: () => setConfirmingDelete(false),
  });

  return (
    <tr className="border-b align-top last:border-0">
      <td className="py-2">
        <span className="font-mono text-sm font-medium">{role.name}</span>
        {role.description && (
          <p className="mt-0.5 max-w-xs text-xs text-muted-foreground">{role.description}</p>
        )}
      </td>
      <td className="py-2 text-xs">{role.model ?? <span className="text-muted-foreground">default</span>}</td>
      <td className="py-2">
        <div className="flex max-w-sm flex-wrap gap-1">
          {role.capabilities.map((cap) => (
            <code key={cap} className="rounded bg-muted px-1 py-0.5 text-[10px]">
              {cap}
            </code>
          ))}
        </div>
      </td>
      <td className="py-2">
        <button
          type="button"
          role="switch"
          aria-checked={role.enabled}
          aria-label={`${role.name} enabled`}
          onClick={() => toggleMutation.mutate()}
          disabled={toggleMutation.isPending}
          className={cn(
            'relative h-5 w-9 rounded-full transition-colors disabled:opacity-50',
            role.enabled ? 'bg-primary' : 'bg-muted-foreground/30',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-4 w-4 rounded-full bg-background transition-all',
              role.enabled ? 'left-[18px]' : 'left-0.5',
            )}
          />
        </button>
      </td>
      <td className="py-2 text-right">
        {confirmingDelete ? (
          <span className="inline-flex gap-1">
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
            >
              Confirm delete
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            aria-label={`Delete ${role.name}`}
            className="rounded-md border p-1.5 text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        {(toggleMutation.isError || deleteMutation.isError) && (
          <p className="mt-1 text-right text-[10px] text-destructive">
            {((toggleMutation.error ?? deleteMutation.error) as Error)?.message ?? 'Action failed.'}
          </p>
        )}
      </td>
    </tr>
  );
}

function AgentsBody() {
  const [creating, setCreating] = useState(false);
  const rolesQuery = useQuery({ queryKey: ['mc-agent-roles'], queryFn: missionControlApi.roles });

  if (rolesQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading agent roles…</p>;
  }
  if (rolesQuery.isError) {
    const message =
      rolesQuery.error instanceof Error ? rolesQuery.error.message : 'Failed to load roles.';
    return <p className="text-sm text-destructive">{message}</p>;
  }

  const roles = rolesQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Role library — each role is a persona with a capability ceiling. Earned autonomy per
          capability lives in the trust ledger.
        </p>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" /> New role
          </button>
        )}
      </div>

      {creating && <CreateRoleForm onClose={() => setCreating(false)} />}

      <div className="rounded-lg border bg-background p-4">
        {roles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agent roles for this site yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2">Role</th>
                <th>Model</th>
                <th>Capabilities</th>
                <th>Enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <RoleRow key={role.id} role={role} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function AgentsPage() {
  return (
    <MissionControlLayout>
      <AgentsBody />
    </MissionControlLayout>
  );
}
