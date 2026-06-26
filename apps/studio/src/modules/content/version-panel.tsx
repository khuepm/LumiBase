import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Change } from '@lumibase/shared';
import { useState } from 'react';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';
import { RevisionsDiff } from './revisions-diff';

/**
 * Content versions panel (content-versioning spec). Lists named draft branches
 * of an item, lets you create one, compare it field-by-field with main (reusing
 * RevisionsDiff), and promote it to main. Self-contained so it slots into the
 * item editor as a tab without touching the existing flow.
 */

interface VersionRow {
  id: string;
  key: string;
  name: string;
  createdAt: string;
  mainChanged: boolean;
}

interface CompareResult {
  main: Record<string, unknown>;
  version: Record<string, unknown>;
  changes: Change[];
}

async function versionFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'x-site-id': site } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message: string }> };
  if (!res.ok) throw new Error(body.errors?.[0]?.message ?? `Request failed: ${res.status}`);
  return body.data as T;
}

export function VersionPanel({ collection, itemId }: { collection: string; itemId: string }) {
  const queryClient = useQueryClient();
  const base = `/api/v1/items/${collection}/${itemId}/versions`;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [comparingKey, setComparingKey] = useState<string | null>(null);

  const versionsQuery = useQuery({
    queryKey: ['versions', collection, itemId],
    queryFn: () => versionFetch<VersionRow[]>(base),
  });

  const compareQuery = useQuery({
    queryKey: ['version-compare', collection, itemId, comparingKey],
    queryFn: () => versionFetch<CompareResult>(`${base}/${comparingKey}/compare`),
    enabled: !!comparingKey,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['versions', collection, itemId] });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      versionFetch<VersionRow>(base, {
        method: 'POST',
        body: JSON.stringify({ key: slugify(name), name: name.trim() }),
      }),
    onSuccess: () => {
      setName('');
      setCreating(false);
      invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) => versionFetch<null>(`${base}/${key}`, { method: 'DELETE' }),
    onSuccess: () => {
      setComparingKey(null);
      invalidate();
    },
  });

  const promoteMutation = useMutation({
    mutationFn: (key: string) => versionFetch<unknown>(`${base}/${key}/promote`, { method: 'POST' }),
    onSuccess: () => {
      setComparingKey(null);
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['item', collection, itemId] });
      queryClient.invalidateQueries({ queryKey: ['revisions', collection, itemId] });
    },
  });

  const versions = versionsQuery.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Versions</h3>
        <button type="button" onClick={() => setCreating((v) => !v)} className="rounded border px-2 py-1 text-xs hover:bg-muted">
          New version
        </button>
      </div>

      {creating && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) createMutation.mutate();
          }}
        >
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Version name" className="flex-1 rounded border px-2 py-1 text-sm" />
          <button type="submit" disabled={!name.trim() || createMutation.isPending} className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50">
            Create
          </button>
          {createMutation.isError && <span className="text-xs text-destructive">{(createMutation.error as Error).message}</span>}
        </form>
      )}

      {versionsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading versions…</p>
      ) : versions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No versions yet. Create one to draft changes off the live record.</p>
      ) : (
        <ul className="space-y-1">
          {versions.map((v) => (
            <li key={v.id} className="rounded border">
              <div className="flex items-center justify-between px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{v.name}</span>
                  <code className="rounded bg-muted px-1 text-[10px]">{v.key}</code>
                  {v.mainChanged && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700" title="Main has changed since this version was created">
                      main changed
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => setComparingKey(comparingKey === v.key ? null : v.key)} className="rounded px-1.5 py-0.5 text-xs hover:bg-muted">
                    {comparingKey === v.key ? 'Hide' : 'Compare'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Promote "${v.name}" to main?${v.mainChanged ? ' Main has changed since this version was created.' : ''}`)) {
                        promoteMutation.mutate(v.key);
                      }
                    }}
                    className="rounded px-1.5 py-0.5 text-xs text-primary hover:bg-muted"
                  >
                    Promote
                  </button>
                  <button type="button" onClick={() => deleteMutation.mutate(v.key)} className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-destructive">
                    ✕
                  </button>
                </div>
              </div>
              {comparingKey === v.key && (
                <div className="border-t bg-muted/10 p-2">
                  {compareQuery.isLoading ? (
                    <p className="text-xs text-muted-foreground">Loading diff…</p>
                  ) : compareQuery.data ? (
                    <RevisionsDiff before={compareQuery.data.main} after={compareQuery.data.version} />
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {promoteMutation.isError && <p className="text-xs text-destructive">{(promoteMutation.error as Error).message}</p>}
    </div>
  );
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'version';
}
