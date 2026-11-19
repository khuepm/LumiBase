import { GitMerge, RefreshCw, X } from 'lucide-react';
import type { MergeResult } from './stale-merge';

/**
 * Stale-draft UI (#685): someone saved a newer version while this draft was
 * open. Offered before the save fails, so the editor can fold the other
 * changes in first.
 */
export function StaleDraftBanner({ onMerge, onReload }: { onMerge: () => void; onReload: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
    >
      <span className="flex-1">A newer version of this item was saved by someone else while you were editing.</span>
      <button type="button" onClick={onMerge} className="inline-flex items-center gap-1 rounded border border-amber-400 px-2 py-1 font-medium hover:bg-amber-100 dark:hover:bg-amber-900">
        <GitMerge className="h-3.5 w-3.5" /> Merge their changes
      </button>
      <button type="button" onClick={onReload} className="inline-flex items-center gap-1 rounded border border-amber-400 px-2 py-1 hover:bg-amber-100 dark:hover:bg-amber-900">
        <RefreshCw className="h-3.5 w-3.5" /> Discard mine and load latest
      </button>
    </div>
  );
}

/** What a merge did: fields taken from the newer version, and conflicts kept as mine. */
export function MergeNote({ result, onDismiss }: { result: MergeResult; onDismiss: () => void }) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-md border bg-muted/30 p-2 text-xs">
      <GitMerge className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="flex-1 space-y-0.5">
        <p>
          Merged with the latest version.{' '}
          {result.fromTheirs.length > 0 ? `Updated from it: ${result.fromTheirs.join(', ')}.` : 'Nothing to take from it.'}
        </p>
        {result.conflicts.length > 0 && (
          <p className="text-amber-800 dark:text-amber-200">
            Changed on both sides — your version is kept, review before saving: {result.conflicts.join(', ')}.
          </p>
        )}
        <p className="text-muted-foreground">Save to apply.</p>
      </div>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="rounded p-0.5 hover:bg-muted">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
