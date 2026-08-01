import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { UploadCloud, Save, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApiClient } from '@/lib/api';
import { formatSafeError } from '@lumibase/contracts/utils';
import type { UploadConfigResource } from '@lumibase/sdk';

const BYTES_PER_MB = 1024 * 1024;

/**
 * Settings → Uploads. Lets an admin choose which file types (extensions) may be
 * uploaded and the maximum size. The same allowlist is what the server-side
 * upload guard enforces on every upload surface; this page only edits it.
 */
export function UploadsSettingsPage() {
  const { t } = useTranslation();
  const client = getApiClient();
  const qc = useQueryClient();

  const configQuery = useQuery({
    queryKey: ['upload-config'],
    queryFn: async () => (await client.uploads.getConfig()).data,
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [maxMb, setMaxMb] = useState<string>('10');
  const [error, setError] = useState<string | null>(null);

  // Seed the form once the effective config loads.
  useEffect(() => {
    const cfg = configQuery.data;
    if (!cfg) return;
    setSelected(new Set(cfg.allowedMimeTypes));
    setMaxMb((cfg.maxBytes / BYTES_PER_MB).toFixed(cfg.maxBytes % BYTES_PER_MB === 0 ? 0 : 2));
  }, [configQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (input: { maxBytes: number; allowedMimeTypes: string[] }) =>
      client.uploads.updateConfig(input),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['upload-config'] });
    },
    onError: (err) => setError(friendlyError(err)),
  });

  const catalogue = configQuery.data?.catalogue ?? [];

  const toggle = (mime: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(mime)) next.delete(mime);
      else next.add(mime);
      return next;
    });
  };

  const onSave = () => {
    setError(null);
    const mb = Number.parseFloat(maxMb);
    if (!Number.isFinite(mb) || mb <= 0) {
      setError('Enter a valid maximum size in MB.');
      return;
    }
    if (selected.size === 0) {
      setError('Select at least one allowed file type.');
      return;
    }
    saveMutation.mutate({
      maxBytes: Math.round(mb * BYTES_PER_MB),
      allowedMimeTypes: [...selected],
    });
  };

  const allowedExtensions = catalogue
    .filter((entry) => selected.has(entry.mime))
    .flatMap((entry) => entry.extensions);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight">
          <UploadCloud className="h-7 w-7" /> {t('uploads', 'Uploads')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose which file types and sizes are accepted. These limits are enforced on the
          server for every upload — files that don't match their declared type, exceed the
          size cap, or embed active/script content are rejected before they reach storage.
        </p>
      </header>

      {configQuery.isLoading ? (
        <div className="text-muted-foreground">Loading…</div>
      ) : (
        <>
          <section className="space-y-3 rounded-xl border bg-background p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Allowed file types
            </h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {catalogue.map((entry) => (
                <label
                  key={entry.mime}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(entry.mime)}
                    onChange={() => toggle(entry.mime)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{entry.label}</span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {entry.extensions.join(', ')} · {entry.mime}
                    </span>
                    {entry.note && (
                      <span className="mt-1 flex items-start gap-1 text-[11px] text-amber-600">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {entry.note}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="space-y-2 rounded-xl border bg-background p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Maximum file size
            </h2>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={maxMb}
                onChange={(e) => setMaxMb(e.target.value)}
                className="w-32 rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
              />
              <span className="text-sm text-muted-foreground">MB per file</span>
            </div>
          </section>

          <section className="flex items-start gap-2 rounded-lg border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <span>
              The picker will offer:{' '}
              <span className="font-mono">{allowedExtensions.join(', ') || '—'}</span>. Uploads are
              content-sniffed (magic bytes) and served as downloads with{' '}
              <span className="font-mono">nosniff</span>, so a file cannot masquerade as an image or
              run as script.
            </span>
          </section>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onSave}
              disabled={saveMutation.isPending}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              <Save className="h-4 w-4" /> {saveMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function friendlyError(err: unknown): string {
  const message = formatSafeError(err);
  if (typeof message === 'string' && /403|forbidden/i.test(message)) {
    return 'Saving upload settings requires site admin access.';
  }
  return 'Failed to save upload settings.';
}

// Re-exported type for callers that want the shape.
export type { UploadConfigResource };
