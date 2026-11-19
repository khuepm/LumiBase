import { useMutation, useQuery } from '@tanstack/react-query';
import { History, Link2, RefreshCw, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { LumiError, type FileReferenceResource, type FileResource } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { VideoPanel } from './video-panel';

interface Props {
  fileId: string;
  onClose: () => void;
  onChanged: () => void;
}

interface EmbeddedSummary {
  title?: string;
  description?: string;
  creator?: string;
  credit?: string;
  copyright?: string;
  keywords?: string[];
}

function referenceLabel(ref: FileReferenceResource): string {
  return ref.kind === 'item' ? `${ref.collection} › ${ref.id}${ref.fields.length ? ` (${ref.fields.join(', ')})` : ''}` : `page /${ref.slug} — ${ref.title}`;
}

/**
 * Asset details (#703, #705, #706): rename + editorial metadata, replace the
 * binary in place, version history with restore, "where used", and a delete
 * that shows the references before it asks to confirm. Videos also get
 * processing status, a preview player and caption tracks (#871).
 */
export function FileDetailsDrawer({ fileId, onClose, onChanged }: Props) {
  const client = getApiClient();
  const replaceInput = useRef<HTMLInputElement>(null);
  const [pendingDelete, setPendingDelete] = useState<{ references: FileReferenceResource[]; policy: string } | null>(null);

  const fileQuery = useQuery({ queryKey: ['files', 'detail', fileId], queryFn: async () => (await client.files.get(fileId)).data });
  const usageQuery = useQuery({ queryKey: ['files', 'usage', fileId], queryFn: async () => (await client.files.usage(fileId)).data });
  const versionsQuery = useQuery({ queryKey: ['files', 'versions', fileId], queryFn: async () => (await client.files.versions(fileId)).data });

  const refresh = () => {
    void fileQuery.refetch();
    void versionsQuery.refetch();
    onChanged();
  };

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => client.files.update(fileId, patch),
    onSuccess: refresh,
    onError: (err: Error) => alert(err.message),
  });
  const replace = useMutation({
    mutationFn: (file: File) =>
      client.files.replaceContent(fileId, file, {
        mime: file.type || 'application/octet-stream',
        filename: file.name,
        expectedVersion: fileQuery.data?.version,
      }),
    onSuccess: refresh,
    onError: (err: Error) => alert(err.message),
  });
  const restore = useMutation({
    mutationFn: (versionId: string) => client.files.restoreVersion(fileId, versionId),
    onSuccess: refresh,
    onError: (err: Error) => alert(err.message),
  });
  const remove = useMutation({
    mutationFn: (confirm: boolean) => client.files.delete(fileId, { confirm }),
    onSuccess: () => {
      onChanged();
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof LumiError && err.status === 409 && err.body?.errors?.[0]?.code === 'FILE_IN_USE') {
        const details = err.body.errors[0].details as { policy: string; usage: { references: FileReferenceResource[] } };
        setPendingDelete({ references: details.usage.references, policy: details.policy });
        return;
      }
      alert(err instanceof Error ? err.message : String(err));
    },
  });

  const file: FileResource | undefined = fileQuery.data;
  const meta = (file?.metadata ?? {}) as Record<string, unknown>;
  const embedded = (meta.embedded as { summary?: EmbeddedSummary; gps?: unknown } | undefined) ?? undefined;
  const usage = usageQuery.data ?? [];

  return (
    <aside className="fixed inset-y-0 end-0 z-40 flex w-[28rem] flex-col border-s bg-background shadow-xl" aria-label="File details">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <h2 className="truncate font-semibold">{file?.filenameDownload ?? '…'}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="ms-auto rounded p-1 hover:bg-muted">
          <X className="h-4 w-4" />
        </button>
      </header>
      {!file ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex-1 space-y-5 overflow-y-auto p-4 text-sm">
          <dl className="grid grid-cols-3 gap-1 text-xs">
            <dt className="text-muted-foreground">Type</dt>
            <dd className="col-span-2">{file.mime}</dd>
            <dt className="text-muted-foreground">Size</dt>
            <dd className="col-span-2">{(file.filesize / 1024).toFixed(1)} KB{file.width ? ` · ${file.width}×${file.height}` : ''}</dd>
            <dt className="text-muted-foreground">Version</dt>
            <dd className="col-span-2">v{file.version ?? 1}</dd>
            {file.scanStatus && file.scanStatus !== 'skipped' && (
              <>
                <dt className="text-muted-foreground">Scan</dt>
                <dd className="col-span-2">{file.scanStatus}</dd>
              </>
            )}
          </dl>

          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              save.mutate({
                filenameDownload: String(form.get('filenameDownload') ?? file.filenameDownload),
                metadata: { alt: String(form.get('alt') ?? ''), caption: String(form.get('caption') ?? '') },
              });
            }}
          >
            <label className="block">
              <span className="text-xs text-muted-foreground">Name</span>
              <input name="filenameDownload" defaultValue={file.filenameDownload} className="mt-1 w-full rounded-md border px-2 py-1.5" />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Alt text</span>
              <input name="alt" defaultValue={String(meta.alt ?? '')} className="mt-1 w-full rounded-md border px-2 py-1.5" />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Caption</span>
              <input name="caption" defaultValue={String(meta.caption ?? '')} className="mt-1 w-full rounded-md border px-2 py-1.5" />
            </label>
            <button type="submit" disabled={save.isPending} className="rounded-md border px-3 py-1.5 font-medium hover:bg-muted">
              Save
            </button>
          </form>

          {embedded?.summary && (
            <section>
              <h3 className="mb-1 font-medium">Embedded metadata</h3>
              <dl className="grid grid-cols-3 gap-1 text-xs">
                {(['title', 'creator', 'credit', 'copyright'] as const).map((k) =>
                  embedded.summary?.[k] ? (
                    <div key={k} className="contents">
                      <dt className="capitalize text-muted-foreground">{k}</dt>
                      <dd className="col-span-2">{embedded.summary[k]}</dd>
                    </div>
                  ) : null,
                )}
                {embedded.summary.keywords && embedded.summary.keywords.length > 0 && (
                  <>
                    <dt className="text-muted-foreground">Keywords</dt>
                    <dd className="col-span-2">{embedded.summary.keywords.join(', ')}</dd>
                  </>
                )}
                {embedded.gps ? (
                  <>
                    <dt className="text-muted-foreground">GPS</dt>
                    <dd className="col-span-2">present (strip on public delivery in DAM settings)</dd>
                  </>
                ) : null}
              </dl>
            </section>
          )}

          {file.mime.toLowerCase().startsWith('video/') && <VideoPanel file={file} />}

          <section>
            <h3 className="mb-1 flex items-center gap-1 font-medium">
              <RefreshCw className="h-4 w-4" /> Replace file
            </h3>
            <p className="mb-2 text-xs text-muted-foreground">Same id and URL; every item using this file shows the new version.</p>
            <button type="button" disabled={replace.isPending} onClick={() => replaceInput.current?.click()} className="rounded-md border px-3 py-1.5 hover:bg-muted">
              {replace.isPending ? 'Replacing…' : 'Choose replacement…'}
            </button>
            <input
              ref={replaceInput}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) replace.mutate(f);
                e.target.value = '';
              }}
            />
          </section>

          <section>
            <h3 className="mb-1 flex items-center gap-1 font-medium">
              <History className="h-4 w-4" /> Previous versions
            </h3>
            {(versionsQuery.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">None kept.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {(versionsQuery.data ?? []).map((v) => (
                  <li key={v.id} className="flex items-center gap-2">
                    <span>
                      v{v.version} · {v.filenameDownload} · until {new Date(v.expiresAt).toLocaleDateString()}
                    </span>
                    <button type="button" disabled={restore.isPending} onClick={() => restore.mutate(v.id)} className="ms-auto text-primary underline">
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-1 flex items-center gap-1 font-medium">
              <Link2 className="h-4 w-4" /> Used in ({usage.length})
            </h3>
            {usage.length === 0 ? (
              <p className="text-xs text-muted-foreground">Not referenced by any item or page.</p>
            ) : (
              <ul className="space-y-0.5 text-xs">
                {usage.map((r) => (
                  <li key={`${r.kind}:${r.id}`}>{referenceLabel(r)}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="border-t pt-4">
            {pendingDelete ? (
              <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
                <p className="font-medium">This file is used in {pendingDelete.references.length} place(s):</p>
                <ul className="list-disc ps-4">
                  {pendingDelete.references.slice(0, 10).map((r) => (
                    <li key={`${r.kind}:${r.id}`}>{referenceLabel(r)}</li>
                  ))}
                </ul>
                {pendingDelete.policy === 'block' ? (
                  <p>The site blocks deleting referenced files. Remove the references first.</p>
                ) : (
                  <button type="button" onClick={() => remove.mutate(true)} className="rounded-md bg-destructive px-3 py-1.5 font-medium text-destructive-foreground">
                    Delete anyway
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => confirm('Delete this file?') && remove.mutate(false)}
                className="inline-flex items-center gap-1 text-destructive hover:underline"
              >
                <Trash2 className="h-4 w-4" /> Delete file
              </button>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}
