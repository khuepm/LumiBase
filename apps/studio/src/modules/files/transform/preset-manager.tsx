import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { transformUrl } from './transform-panel';

/**
 * Transform preset manager (image-transform-dsl Req 5.1, 5.3). Lists named
 * presets, creates/deletes them, and offers a Copy-URL for applying a preset to
 * a given file key. Backend enforces the media permission.
 */

interface TransformPreset {
  id: string;
  key: string;
  name: string;
  dsl: { width?: number; height?: number; format?: string; quality?: number; fit?: string };
}

async function presetApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1/transform-presets${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(getActiveToken() ? { Authorization: `Bearer ${getActiveToken()}` } : {}),
      ...(getActiveSite() ? { 'x-site-id': getActiveSite()! } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message: string }> };
  if (!res.ok) throw new Error(body.errors?.[0]?.message ?? `Request failed: ${res.status}`);
  return body.data as T;
}

export function PresetManager({ fileKey }: { fileKey?: string }) {
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ key: '', name: '', width: '', height: '', format: '' });

  const query = useQuery({ queryKey: ['transform-presets'], queryFn: () => presetApi<TransformPreset[]>('') });

  const create = useMutation({
    mutationFn: () =>
      presetApi<TransformPreset>('', {
        method: 'POST',
        body: JSON.stringify({
          key: form.key.trim(),
          name: form.name.trim(),
          dsl: {
            ...(form.width ? { width: Number(form.width) } : {}),
            ...(form.height ? { height: Number(form.height) } : {}),
            ...(form.format ? { format: form.format } : {}),
          },
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['transform-presets'] });
      setShowNew(false);
      setForm({ key: '', name: '', width: '', height: '', format: '' });
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => presetApi<null>(`/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['transform-presets'] }),
  });

  const presets = query.data ?? [];

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Transform presets</h3>
        <button type="button" className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted" onClick={() => setShowNew((s) => !s)}>
          <Plus className="h-3.5 w-3.5" /> New preset
        </button>
      </header>

      {showNew && (
        <div className="grid grid-cols-2 gap-2 rounded-md border p-3 sm:grid-cols-5">
          <input placeholder="key (slug)" className="rounded border px-2 py-1 text-sm" value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} />
          <input placeholder="Name" className="rounded border px-2 py-1 text-sm" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          <input placeholder="width" type="number" className="rounded border px-2 py-1 text-sm" value={form.width} onChange={(e) => setForm((f) => ({ ...f, width: e.target.value }))} />
          <input placeholder="height" type="number" className="rounded border px-2 py-1 text-sm" value={form.height} onChange={(e) => setForm((f) => ({ ...f, height: e.target.value }))} />
          <button type="button" disabled={!form.key.trim() || !form.name.trim() || create.isPending} className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50" onClick={() => create.mutate()}>
            Save
          </button>
          {create.isError && <p className="col-span-full text-xs text-destructive">{(create.error as Error).message}</p>}
        </div>
      )}

      <ul className="divide-y rounded-md border">
        {presets.length === 0 && <li className="p-3 text-sm text-muted-foreground">No presets yet.</li>}
        {presets.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="truncate">
              <span className="font-medium">{p.name}</span>{' '}
              <span className="font-mono text-xs text-muted-foreground">{p.key}</span>
            </span>
            <span className="flex items-center gap-1">
              {fileKey && (
                <button
                  type="button"
                  aria-label={`Copy URL for ${p.key}`}
                  className="rounded p-1 text-muted-foreground hover:bg-muted"
                  onClick={() => void navigator.clipboard?.writeText(transformUrl(fileKey, {}) + `?preset=${p.key}`)}
                >
                  <Copy className="h-4 w-4" />
                </button>
              )}
              <button type="button" aria-label={`Delete ${p.key}`} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive" disabled={del.isPending} onClick={() => del.mutate(p.id)}>
                <Trash2 className="h-4 w-4" />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
