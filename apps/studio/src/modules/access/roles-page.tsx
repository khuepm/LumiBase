import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { RoleResource } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';

/**
 * Roles list page. Shows every role in the active site plus a primary CTA to
 * create a new one. Drilling in opens `RoleDetailPage` which handles policy
 * attachments and user assignment.
 */
export function RolesListPage() {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const rolesQuery = useQuery({
    queryKey: ['access', 'roles'],
    queryFn: async () => (await client.roles.list()).data,
  });

  const removeRole = useMutation({
    mutationFn: (id: string) => client.roles.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'roles'] }),
  });

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Roles</h2>
          <p className="text-xs text-muted-foreground">
            Each user has one primary role per site. Assign policies to roles
            to grant collection permissions.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> New role
        </button>
      </header>

      {rolesQuery.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load roles.
        </div>
      )}

      {rolesQuery.data && rolesQuery.data.length === 0 && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <ShieldCheck className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <h3 className="text-base font-medium">No roles yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a role to start assigning permissions.
          </p>
        </div>
      )}

      {rolesQuery.data && rolesQuery.data.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-start text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Admin</th>
                <th className="px-4 py-2 font-medium">App access</th>
                <th className="px-4 py-2 font-medium">Description</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rolesQuery.data.map((r) => (
                <tr key={r.id} className="border-t hover:bg-muted/20">
                  <td className="px-4 py-2">
                    <Link
                      to="/access/roles/$id"
                      params={{ id: r.id }}
                      className="font-medium text-primary hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-xs">{r.adminAccess ? 'yes' : 'no'}</td>
                  <td className="px-4 py-2 text-xs">{r.appAccess ? 'yes' : 'no'}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {r.description ?? '—'}
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      aria-label={`Delete role ${r.name}`}
                      onClick={() => {
                        if (confirm(`Delete role "${r.name}"?`)) removeRole.mutate(r.id);
                      }}
                      className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateRoleDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            queryClient.invalidateQueries({ queryKey: ['access', 'roles'] });
          }}
        />
      )}
    </div>
  );
}

function CreateRoleDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (role: RoleResource) => void;
}) {
  const client = getApiClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [adminAccess, setAdminAccess] = useState(false);
  const [appAccess, setAppAccess] = useState(true);

  const create = useMutation({
    mutationFn: async () => {
      const res = await client.roles.create({
        name: name.trim(),
        description: description.trim() || undefined,
        adminAccess,
        appAccess,
      });
      return res.data;
    },
    onSuccess: (role) => onCreated(role),
  });

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg border bg-background p-5 shadow-lg">
        <h3 className="mb-3 text-base font-semibold">New role</h3>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="editor"
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={adminAccess}
              onChange={(e) => setAdminAccess(e.target.checked)}
            />
            <span>Admin access (bypass all permission checks)</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={appAccess}
              onChange={(e) => setAppAccess(e.target.checked)}
            />
            <span>App access (members can sign in to Studio)</span>
          </label>
          {create.error && (
            <p className="text-xs text-destructive">{(create.error as Error).message}</p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-xs"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
