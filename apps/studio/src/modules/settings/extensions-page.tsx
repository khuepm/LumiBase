import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Puzzle, Upload, Trash2, Power, Code } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import type { ExtensionResource } from '@lumibase/sdk';

export function ExtensionsPage() {
  const { t } = useTranslation();
  const client = getApiClient();
  const qc = useQueryClient();

  const extensionsQuery = useQuery({
    queryKey: ['extensions'],
    queryFn: async () => (await client.extensions.list()).data,
  });

  const extensions = extensionsQuery.data ?? [];

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      client.extensions.update(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['extensions'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.extensions.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['extensions'] }),
  });

  // Mock install from bundle URL
  const [installUrl, setInstallUrl] = useState('');
  const installMutation = useMutation({
    mutationFn: () => client.extensions.create({
      name: `Extension ${Math.floor(Math.random() * 1000)}`,
      version: '1.0.0',
      type: 'module',
      enabled: false,
      bundleUrl: installUrl,
      capabilities: ['read_items'],
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['extensions'] });
      setInstallUrl('');
    },
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">{t('extensions', 'Extensions')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Extend LumiBase with custom panels, modules, displays, and endpoints.
        </p>
      </header>

      <div className="flex gap-2">
        <input
          type="text"
          placeholder="https://example.com/bundle.js"
          value={installUrl}
          onChange={(e) => setInstallUrl(e.target.value)}
          className="w-full max-w-md rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={() => installMutation.mutate()}
          disabled={!installUrl || installMutation.isPending}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          <Upload className="h-4 w-4" /> Install from URL
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {extensionsQuery.isLoading && <div className="text-muted-foreground">Loading...</div>}
        {extensions.length === 0 && !extensionsQuery.isLoading && (
          <div className="col-span-full rounded-xl border border-dashed p-12 text-center text-muted-foreground">
            No extensions installed.
          </div>
        )}
        {extensions.map((ext) => (
          <div key={ext.id} className="flex flex-col justify-between rounded-lg border bg-background p-4 shadow-sm">
            <div>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${ext.enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                    <Puzzle className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold flex items-center gap-2">
                      {ext.name}
                      <span className="text-xs font-normal text-muted-foreground bg-muted px-1.5 py-0.5 rounded">v{ext.version}</span>
                    </h3>
                    <p className="text-xs text-muted-foreground capitalize">{ext.type} extension</p>
                  </div>
                </div>
                <button
                  onClick={() => toggleMutation.mutate({ id: ext.id, enabled: !ext.enabled })}
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${ext.enabled ? 'bg-emerald-100 text-emerald-600 hover:bg-emerald-200' : 'bg-muted text-muted-foreground hover:bg-muted-foreground/20'}`}
                  title={ext.enabled ? 'Disable' : 'Enable'}
                >
                  <Power className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-4 flex flex-wrap gap-1">
                {ext.capabilities.map(cap => (
                  <span key={cap} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                    <Code className="h-3 w-3" />
                    {cap}
                  </span>
                ))}
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end border-t pt-3">
              <button
                onClick={() => {
                  if (confirm('Uninstall this extension?')) deleteMutation.mutate(ext.id);
                }}
                className="text-sm font-medium text-destructive hover:underline"
              >
                Uninstall
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
