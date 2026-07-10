import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Trash2, Users } from 'lucide-react';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { deleteBookmark, type ViewPreset } from './api';

/**
 * Admin panel for managing role- and global-scoped presets (presets-inheritance
 * Req 5.4, 4.1). Lists every shared (non-user) preset for the site and lets an
 * admin delete them. Mounted in the role/settings detail area. The server
 * enforces admin on the mutating calls, so this is a convenience surface — a
 * non-admin who reached it still can't write.
 */

async function listAllPresets(): Promise<ViewPreset[]> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await fetch('/api/v1/presets', {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'x-site-id': site } : {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: ViewPreset[] };
  return body.data ?? [];
}

export function RolePresets() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['all-presets'], queryFn: listAllPresets });

  const del = useMutation({
    mutationFn: (id: string) => deleteBookmark(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['all-presets'] }),
  });

  // Shared presets only: role- or global-scoped (userId is null).
  const shared = (query.data ?? []).filter((p) => !p.userId);

  return (
    <section className="space-y-3">
      <header>
        <h3 className="text-sm font-semibold">Shared presets</h3>
        <p className="text-xs text-muted-foreground">Role- and global-scoped views and bookmarks for this site.</p>
      </header>

      {query.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {shared.length === 0 && !query.isLoading && (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No shared presets yet.</p>
      )}

      <ul className="divide-y rounded-md border">
        {shared.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="flex items-center gap-2 truncate">
              {p.roleId ? <Users className="h-4 w-4 opacity-60" /> : <Globe className="h-4 w-4 opacity-60" />}
              <span className="truncate">
                {p.bookmark ?? <span className="text-muted-foreground">Default view</span>} · {p.collection}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                {p.roleId ? 'role' : 'global'}
              </span>
            </span>
            <button
              type="button"
              aria-label="Delete preset"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
              disabled={del.isPending}
              onClick={() => del.mutate(p.id)}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
