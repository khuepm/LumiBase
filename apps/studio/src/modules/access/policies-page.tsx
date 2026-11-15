import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FileLock2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { PolicyResource } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';

/**
 * Policies list page. Each policy is a reusable bundle of permission rows
 * that can be attached to roles or users with a priority.
 */
export function PoliciesListPage() {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const policiesQuery = useQuery({
    queryKey: ['access', 'policies'],
    queryFn: async () => (await client.policies.list()).data,
  });

  const removePolicy = useMutation({
    mutationFn: (id: string) => client.policies.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'policies'] }),
  });

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Policies</h2>
          <p className="text-xs text-muted-foreground">
            Each policy bundles permission rows (collection × action). Attach
            policies to roles or users; lower priority runs first.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> New policy
        </button>
      </header>

      {policiesQuery.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load policies.
        </div>
      )}

      {policiesQuery.data && policiesQuery.data.length === 0 && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <FileLock2 className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <h3 className="text-base font-medium">No policies yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a policy and add permission rules to it.
          </p>
        </div>
      )}

      {policiesQuery.data && policiesQuery.data.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-start text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Description</th>
                <th className="px-4 py-2 font-medium">Guards</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {policiesQuery.data.map((p) => (
                <tr key={p.id} className="border-t hover:bg-muted/20">
                  <td className="px-4 py-2">
                    <Link
                      to="/access/policies/$id"
                      params={{ id: p.id }}
                      className="font-medium text-primary hover:underline"
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {p.description ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    <GuardSummary rules={p.rules} />
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      aria-label={`Delete policy ${p.name}`}
                      onClick={() => {
                        if (confirm(`Delete policy "${p.name}"?`)) removePolicy.mutate(p.id);
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
        <CreatePolicyDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            queryClient.invalidateQueries({ queryKey: ['access', 'policies'] });
          }}
        />
      )}
    </div>
  );
}

/** Summarise guardrails (time/IP) so the list view stays scannable. */
function GuardSummary({ rules }: { rules: Record<string, unknown> }) {
  const parts: string[] = [];
  if (typeof rules.validFrom === 'string') parts.push(`from ${rules.validFrom.slice(0, 10)}`);
  if (typeof rules.validUntil === 'string') parts.push(`until ${rules.validUntil.slice(0, 10)}`);
  if (Array.isArray(rules.ipAllow) && rules.ipAllow.length) {
    parts.push(`allow ${(rules.ipAllow as string[]).length} ip`);
  }
  if (Array.isArray(rules.ipDeny) && rules.ipDeny.length) {
    parts.push(`deny ${(rules.ipDeny as string[]).length} ip`);
  }
  return <span>{parts.length ? parts.join(' · ') : '—'}</span>;
}

function CreatePolicyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (policy: PolicyResource) => void;
}) {
  const client = getApiClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const create = useMutation({
    mutationFn: async () => {
      const res = await client.policies.create({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      return res.data;
    },
    onSuccess: (policy) => onCreated(policy),
  });

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg border bg-background p-5 shadow-lg">
        <h3 className="mb-3 text-base font-semibold">New policy</h3>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="content-editors"
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
          {create.error && (
            <p className="text-xs text-destructive">{(create.error as Error).message}</p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs">
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
