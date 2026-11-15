import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, X } from 'lucide-react';
import type { FileResource } from '@lumibase/sdk';
import { cn } from '@/lib/cn';
import type { UploadQueue, UploadTask } from './upload-queue';

/** Bottom-right panel for the bulk upload queue (#702): progress, retry, duplicates. */
export function UploadQueuePanel({ tasks, queue }: { tasks: ReadonlyArray<UploadTask<FileResource>>; queue: UploadQueue<FileResource> }) {
  if (tasks.length === 0) return null;
  const done = tasks.filter((t) => t.status === 'done').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const active = tasks.filter((t) => t.status === 'uploading' || t.status === 'queued' || t.status === 'hashing').length;
  const overall = tasks.reduce((n, t) => n + (t.status === 'done' ? 1 : t.progress), 0) / tasks.length;

  return (
    <aside className="fixed bottom-4 right-4 z-40 w-96 rounded-xl border bg-background shadow-lg" aria-label="Upload queue">
      <header className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        <span className="font-medium">
          {active > 0 ? `Uploading ${done}/${tasks.length}` : `Uploaded ${done}/${tasks.length}`}
        </span>
        {failed > 0 && (
          <button type="button" onClick={() => queue.retryFailed()} className="ml-auto inline-flex items-center gap-1 text-xs text-primary">
            <RotateCcw className="h-3 w-3" /> Retry {failed} failed
          </button>
        )}
        <button type="button" onClick={() => queue.clearFinished()} className={cn('text-xs text-muted-foreground hover:text-foreground', failed === 0 && 'ml-auto')}>
          Clear finished
        </button>
      </header>
      <div className="h-1 bg-muted">
        <div className="h-1 bg-primary transition-all" style={{ width: `${Math.round(overall * 100)}%` }} />
      </div>
      <ul className="max-h-72 overflow-y-auto text-xs">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0">
            {t.status === 'done' ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600" />
            ) : t.status === 'failed' || t.status === 'duplicate' ? (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
            ) : (
              <Loader2 className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', t.status !== 'cancelled' && 'animate-spin')} />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate">{t.file.name}</div>
              {t.status === 'uploading' && (
                <div className="mt-0.5 h-1 rounded bg-muted">
                  <div className="h-1 rounded bg-primary" style={{ width: `${Math.round(t.progress * 100)}%` }} />
                </div>
              )}
              {t.status === 'failed' && <div className="text-destructive">{t.error}</div>}
              {t.status === 'duplicate' && (
                <div className="text-amber-700">
                  Same content as “{t.duplicates?.[0]?.filenameDownload}”.{' '}
                  <button type="button" className="underline" onClick={() => queue.resolveDuplicate(t.id, 'skip')}>
                    Skip
                  </button>{' '}
                  ·{' '}
                  <button type="button" className="underline" onClick={() => queue.resolveDuplicate(t.id, 'upload')}>
                    Upload anyway
                  </button>
                </div>
              )}
            </div>
            {t.status === 'failed' && (
              <button type="button" aria-label={`Retry ${t.file.name}`} onClick={() => queue.retry(t.id)} className="text-muted-foreground hover:text-foreground">
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
            {(t.status === 'queued' || t.status === 'uploading') && (
              <button type="button" aria-label={`Cancel ${t.file.name}`} onClick={() => queue.cancel(t.id)} className="text-muted-foreground hover:text-destructive">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
