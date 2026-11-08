import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Save, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { TranslationResource } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { initI18n } from '@/lib/i18n';

/**
 * Translations Module
 * Manages translation strings across UI, field, and content namespaces.
 */
export function TranslationsPage() {
  const { t } = useTranslation();
  const client = getApiClient();
  const qc = useQueryClient();

  const [activeTab, setActiveTab] = useState<'ui' | 'field' | 'content'>('ui');
  const [lang, setLang] = useState('vi'); // Default to vi for editing
  
  // Settings for locales
  const settingsQuery = useQuery({
    queryKey: ['settings', 'locales'],
    queryFn: async () => {
      try {
        const res = await client.settings.get('locales');
        return res.data;
      } catch {
        return null; // Might not exist yet
      }
    },
  });

  const supportedLangs = (settingsQuery.data?.value?.supported as string[]) ?? ['en', 'vi'];

  const translationsQuery = useQuery({
    queryKey: ['translations', activeTab, lang],
    queryFn: async () => (await client.translations.list({ namespace: activeTab, language: lang })).data,
  });

  const translations = translationsQuery.data ?? [];
  const [editing, setEditing] = useState<TranslationResource | null>(null);
  const [creating, setCreating] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.translations.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['translations', activeTab, lang] });
      // Re-init i18n to fetch fresh keys
      initI18n();
    },
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('translations_title', 'Translations')}</h1>
        <div className="flex items-center gap-3">
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm outline-none"
          >
            {supportedLangs.map((l) => (
              <option key={l} value={l}>{l.toUpperCase()}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            <Plus className="h-4 w-4" /> Add
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b">
        {(['ui', 'field', 'content'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={cn(
              'border-b-2 px-4 py-2 text-sm font-medium capitalize transition-colors',
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground',
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="rounded-xl border bg-background shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/20 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Key</th>
              <th className="px-4 py-3">Value</th>
              <th className="px-4 py-3">Status</th>
              <th className="w-24 px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {translationsQuery.isLoading && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!translationsQuery.isLoading && translations.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No translations found.</td></tr>
            )}
            {translations.map((row) => (
              <tr key={row.id} className="border-b hover:bg-muted/10">
                <td className="px-4 py-2 font-mono text-xs">{row.key}</td>
                <td className="px-4 py-2">{row.value}</td>
                <td className="px-4 py-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">
                    {row.status}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => setEditing(row)}
                    className="text-primary hover:underline text-xs mr-3"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteMutation.mutate(row.id)}
                    className="text-destructive hover:opacity-80"
                  >
                    <Trash2 className="h-3.5 w-3.5 inline" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <TranslationEditor
          resource={editing}
          namespace={activeTab}
          language={lang}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            qc.invalidateQueries({ queryKey: ['translations', activeTab, lang] });
            initI18n();
          }}
        />
      )}
    </div>
  );
}

function TranslationEditor({
  resource,
  namespace,
  language,
  onClose,
  onSaved,
}: {
  resource: TranslationResource | null;
  namespace: string;
  language: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = getApiClient();
  const [key, setKey] = useState(resource?.key ?? '');
  const [value, setValue] = useState(resource?.value ?? '');

  const mutation = useMutation({
    mutationFn: () => {
      if (resource) {
        return client.translations.update(resource.id, { key, value });
      }
      return client.translations.create({ language, namespace, key, value });
    },
    onSuccess: onSaved,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{resource ? 'Edit' : 'New'} Translation</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Key</label>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="w-full rounded-md border bg-muted/20 px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Value</label>
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={3}
              className="w-full rounded-md border bg-muted/20 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={!key || !value || mutation.isPending}
            className="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
          >
            <Save className="mr-2 h-4 w-4 inline" />
            {mutation.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
