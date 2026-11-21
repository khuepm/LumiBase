import { RefreshCw, WifiOff, X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  getRequestProblem,
  reportRequestProblem,
  subscribeRequestProblem,
  type RequestProblem,
} from '@/lib/request-resilience';

/**
 * "Try again" dialog for transient request failures (#694): a dropped
 * connection, a 429 or a gateway error that outlived the automatic retries.
 * The page underneath stays as it was — nothing blanks out — and the user
 * decides when to retry. For a failed save the retry re-sends the same write.
 */
const TEXT: Record<RequestProblem['kind'], { title: string; body: string }> = {
  offline: {
    title: 'Can’t reach the server',
    body: 'Check your connection. Nothing on this page was lost.',
  },
  'rate-limited': {
    title: 'Too many requests',
    body: 'The server asked to slow down for a moment.',
  },
  unavailable: {
    title: 'The server is busy',
    body: 'It answered with a temporary error.',
  },
};

export function ConnectionProblemDialog() {
  const problem = useSyncExternalStore(subscribeRequestProblem, getRequestProblem, getRequestProblem);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);

  useEffect(() => {
    setWait(problem?.retryAfterSeconds ?? 0);
    if (!problem?.retryAfterSeconds) return;
    const timer = setInterval(() => setWait((w) => (w > 0 ? w - 1 : 0)), 1000);
    return () => clearInterval(timer);
  }, [problem]);

  if (!problem) return null;
  const text = TEXT[problem.kind];

  const retry = async () => {
    setBusy(true);
    const current = problem;
    reportRequestProblem(null);
    try {
      await current.retry();
    } catch {
      /* a still-failing retry reports itself again through the caches */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="connection-problem-title"
      className="fixed bottom-4 end-4 z-50 w-80 rounded-lg border bg-background p-4 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="flex-1 space-y-1">
          <h2 id="connection-problem-title" className="text-sm font-semibold">
            {text.title}
          </h2>
          <p className="text-xs text-muted-foreground">
            {text.body}{' '}
            {problem.scope === 'write' ? 'Your last change was not saved yet.' : 'Some data could not be loaded.'}
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => reportRequestProblem(null)}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => void retry()}
          disabled={busy || wait > 0}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
          {wait > 0 ? `Try again in ${wait}s` : busy ? 'Retrying…' : 'Try again'}
        </button>
      </div>
    </div>
  );
}
