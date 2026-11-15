import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Users, Plus, Trash2, Edit, Save, X, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import type { TeamResource } from '@lumibase/sdk';

export function TeamsPage() {
  const { t } = useTranslation();
  const client = getApiClient();
  const qc = useQueryClient();

  const teamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: async () => (await client.teams.list()).data,
  });

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TeamResource | null>(null);
  const [managingMembers, setManagingMembers] = useState<TeamResource | null>(null);

  const teams = teamsQuery.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.teams.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teams'] }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('teams', 'Teams')}</h1>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          <Plus className="h-4 w-4" /> Create Team
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {teamsQuery.isLoading && (
          <div className="col-span-full py-8 text-center text-muted-foreground">Loading…</div>
        )}
        {!teamsQuery.isLoading && teams.length === 0 && (
          <div className="col-span-full py-8 text-center text-muted-foreground">No teams found.</div>
        )}
        {teams.map((team) => (
          <div key={team.id} className="flex flex-col justify-between rounded-xl border bg-background p-5 shadow-sm">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="flex h-8 w-8 items-center justify-center rounded bg-primary/10 text-primary">
                  <Users className="h-4 w-4" />
                </div>
                <h3 className="font-semibold text-foreground">{team.name}</h3>
              </div>
              <p className="text-sm text-muted-foreground mb-4 h-10 line-clamp-2">
                {team.description || 'No description provided.'}
              </p>
            </div>
            
            <div className="flex items-center justify-between border-t pt-4">
              <button
                type="button"
                onClick={() => setManagingMembers(team)}
                className="text-sm font-medium text-primary hover:underline"
              >
                Manage Members
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(team)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Edit className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm('Delete this team?')) deleteMutation.mutate(team.id);
                  }}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {(creating || editing) && (
        <TeamEditorDialog
          team={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
        />
      )}

      {managingMembers && (
        <TeamMembersDialog
          team={managingMembers}
          onClose={() => setManagingMembers(null)}
        />
      )}
    </div>
  );
}

function TeamEditorDialog({ team, onClose }: { team: TeamResource | null; onClose: () => void }) {
  const client = getApiClient();
  const qc = useQueryClient();
  const [name, setName] = useState(team?.name ?? '');
  const [description, setDescription] = useState(team?.description ?? '');

  const mutation = useMutation({
    mutationFn: () => {
      if (team) return client.teams.update(team.id, { name, description });
      return client.teams.create({ name, description });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teams'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold mb-4">{team ? 'Edit Team' : 'Create Team'}</h2>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
            />
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
              disabled={!name || mutation.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              <Save className="me-2 h-4 w-4 inline" />
              {mutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TeamMembersDialog({ team, onClose }: { team: TeamResource; onClose: () => void }) {
  const client = getApiClient();
  const qc = useQueryClient();
  const [userIdToAdd, setUserIdToAdd] = useState('');

  const membersQuery = useQuery({
    queryKey: ['teams', team.id, 'members'],
    queryFn: async () => (await client.teams.members.list(team.id)).data,
  });

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: async () => (await client.users.list()).data,
  });

  const addMutation = useMutation({
    mutationFn: () => client.teams.members.add(team.id, userIdToAdd),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teams', team.id, 'members'] });
      setUserIdToAdd('');
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => client.teams.members.remove(team.id, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teams', team.id, 'members'] }),
  });

  const members = membersQuery.data ?? [];
  const allUsers = usersQuery.data ?? [];

  // Filter out users who are already members
  const memberIds = new Set(members.map(m => m.userId));
  const availableUsers = allUsers.filter(u => !memberIds.has(u.id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{team.name} Members</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>
        
        <div className="mb-6 flex gap-2">
          <select
            value={userIdToAdd}
            onChange={(e) => setUserIdToAdd(e.target.value)}
            className="flex-1 rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
          >
            <option value="">Select a user to add...</option>
            {availableUsers.map(u => (
              <option key={u.id} value={u.id}>{u.email}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => addMutation.mutate()}
            disabled={!userIdToAdd || addMutation.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <UserPlus className="h-4 w-4" /> Add
          </button>
        </div>

        <div className="max-h-60 overflow-y-auto rounded-lg border">
          <table className="w-full text-sm">
            <tbody>
              {membersQuery.isLoading && (
                <tr><td className="px-4 py-4 text-center text-muted-foreground">Loading…</td></tr>
              )}
              {!membersQuery.isLoading && members.length === 0 && (
                <tr><td className="px-4 py-4 text-center text-muted-foreground">No members yet.</td></tr>
              )}
              {members.map(m => {
                const u = allUsers.find(x => x.id === m.userId);
                return (
                  <tr key={m.userId} className="border-b last:border-0 hover:bg-muted/10">
                    <td className="px-4 py-3 font-medium">
                      {u ? (u.firstName ? `${u.firstName} ${u.lastName}` : u.email) : m.userId}
                    </td>
                    <td className="px-4 py-3 text-end">
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm('Remove user from team?')) removeMutation.mutate(m.userId);
                        }}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
