import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Mail, Shield, UserX, UserCheck, ShieldAlert, Trash2, Edit } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { UserResource } from '@lumibase/sdk';

export function UsersPage() {
  const { t } = useTranslation();
  const client = getApiClient();
  const qc = useQueryClient();

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: async () => (await client.users.list()).data,
  });

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: async () => (await client.roles.list()).data,
  });

  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<UserResource | null>(null);

  const users = usersQuery.data ?? [];
  const roles = rolesQuery.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.users.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const getRoleName = (roleId: string | null) => {
    if (!roleId) return 'No Role';
    return roles.find(r => r.id === roleId)?.name ?? 'Unknown';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('users', 'Users')}</h1>
        <button
          type="button"
          onClick={() => setInviting(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          <Mail className="h-4 w-4" /> Invite User
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border bg-background shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-start text-xs uppercase text-muted-foreground border-b">
            <tr>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Last Seen</th>
              <th className="w-24 px-4 py-3 text-end">Actions</th>
            </tr>
          </thead>
          <tbody>
            {usersQuery.isLoading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!usersQuery.isLoading && users.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No users found.</td></tr>
            )}
            {users.map((row) => (
              <tr key={row.id} className="border-b hover:bg-muted/10 last:border-0">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary font-medium">
                      {row.firstName?.[0] ?? row.email[0]?.toUpperCase() ?? '?'}
                    </div>
                    <div>
                      <div className="font-medium text-foreground">
                        {row.firstName} {row.lastName}
                      </div>
                      <div className="text-xs text-muted-foreground">{row.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs text-foreground">
                    <Shield className="h-3 w-3" />
                    {getRoleName(row.roleId)}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <UserStatusBadge status={row.status} />
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : 'Never'}
                </td>
                <td className="px-4 py-3 text-end">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(row)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm('Are you sure you want to remove this user from the site?')) {
                          deleteMutation.mutate(row.id);
                        }
                      }}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {inviting && (
        <InviteDialog onClose={() => setInviting(false)} />
      )}
      
      {editing && (
        <EditUserDialog user={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function UserStatusBadge({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
        <UserCheck className="h-3 w-3" /> Active
      </span>
    );
  }
  if (status === 'invited') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
        <Mail className="h-3 w-3" /> Invited
      </span>
    );
  }
  if (status === 'suspended') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
        <UserX className="h-3 w-3" /> Suspended
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {status}
    </span>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const client = getApiClient();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: async () => (await client.roles.list()).data,
  });

  const mutation = useMutation({
    mutationFn: () => client.users.invite({ email, roleId: roleId || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold mb-4">Invite User</h2>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Email address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
              placeholder="user@example.com"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Assign Role</label>
            <select
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="">No Role</option>
              {(rolesQuery.data ?? []).map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => mutation.mutate()}
              disabled={!email || mutation.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {mutation.isPending ? 'Inviting…' : 'Send Invite'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EditUserDialog({ user, onClose }: { user: UserResource; onClose: () => void }) {
  const client = getApiClient();
  const qc = useQueryClient();
  const [roleId, setRoleId] = useState(user.roleId ?? '');
  const [status, setStatus] = useState(user.status);

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: async () => (await client.roles.list()).data,
  });

  const mutation = useMutation({
    mutationFn: () => client.users.update(user.id, { roleId: roleId || null, status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold mb-4">Edit User: {user.email}</h2>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Role</label>
            <select
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="">No Role</option>
              {(rolesQuery.data ?? []).map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="active">Active</option>
              <option value="invited">Invited</option>
              <option value="suspended">Suspended</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
