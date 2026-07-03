import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Webhook, Plus, Trash2, Edit, Save, Activity } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { useSaveHandler } from '@/lib/keybindings/use-keybindings';
import type { WebhookResource } from '@lumibase/sdk';

export function WebhooksPage() {
  const { t } = useTranslation();
  const client = getApiClient();
  const qc = useQueryClient();

  const webhooksQuery = useQuery({
    queryKey: ['webhooks'],
    queryFn: async () => (await client.webhooks.list()).data,
  });

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<WebhookResource | null>(null);

  const webhooks = webhooksQuery.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.webhooks.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t('webhooks', 'Webhooks')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure external endpoints to receive real-time system events.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          <Plus className="h-4 w-4" /> Add Webhook
        </button>
      </header>

      <div className="grid gap-4">
        {webhooksQuery.isLoading && <div className="text-muted-foreground">Loading...</div>}
        {webhooks.length === 0 && !webhooksQuery.isLoading && (
          <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
            No webhooks configured.
          </div>
        )}
        {webhooks.map((hook) => (
          <div key={hook.id} className="flex items-center justify-between rounded-lg border bg-background p-4 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 text-blue-600">
                <Webhook className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold">{hook.name}</h3>
                <p className="text-sm text-muted-foreground">{hook.url}</p>
                <div className="mt-2 flex gap-2">
                  <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${hook.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-muted text-muted-foreground'}`}>
                    {hook.status}
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Activity className="h-3 w-3" />
                    {hook.actions.length} actions
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setEditing(hook)} className="text-muted-foreground hover:text-foreground">
                <Edit className="h-4 w-4" />
              </button>
              <button
                onClick={() => {
                  if (confirm('Delete webhook?')) deleteMutation.mutate(hook.id);
                }}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {(creating || editing) && (
        <WebhookEditorDialog hook={editing} onClose={() => { setCreating(false); setEditing(null); }} />
      )}
    </div>
  );
}

function WebhookEditorDialog({ hook, onClose }: { hook: WebhookResource | null; onClose: () => void }) {
  const client = getApiClient();
  const qc = useQueryClient();
  
  const [name, setName] = useState(hook?.name ?? '');
  const [url, setUrl] = useState(hook?.url ?? '');
  const [status, setStatus] = useState(hook?.status ?? 'active');

  const mutation = useMutation({
    mutationFn: () => {
      const payload = { name, url, status };
      if (hook) return client.webhooks.update(hook.id, payload);
      return client.webhooks.create(payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['webhooks'] });
      onClose();
    },
  });

  // Cmd/Ctrl+S → save this webhook (mirrors the Save button's gating).
  useSaveHandler(() => mutation.mutate(), !mutation.isPending && !!name && !!url);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold mb-4">{hook ? 'Edit Webhook' : 'Add Webhook'}</h2>
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
            <label className="mb-1 block text-sm font-medium">Payload URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <button onClick={onClose} className="rounded-md px-4 py-2 text-sm font-medium hover:bg-muted">
              Cancel
            </button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!name || !url || mutation.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              <Save className="mr-2 h-4 w-4 inline" />
              {mutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
