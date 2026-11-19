import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { isTransientError } from '@/lib/request-resilience';

/**
 * Router-level error screen (#694). A screen that throws while loading or
 * rendering shows this instead of a blank page: what happened, "Try again"
 * (re-runs the route) and a way back to Content. The rest of the Studio
 * (navigation, other modules) keeps working.
 */
export function RouteErrorScreen({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const transient = isTransientError(error);
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="mx-auto mt-16 max-w-md space-y-3 rounded-lg border bg-background p-6 text-center">
      <AlertTriangle className="mx-auto h-6 w-6 text-destructive" />
      <h1 className="text-lg font-semibold">
        {transient ? 'The server could not be reached' : 'This page ran into a problem'}
      </h1>
      <p className="break-words text-sm text-muted-foreground">
        {transient ? 'Check your connection, then try again.' : message}
      </p>
      <div className="flex justify-center gap-2">
        <button
          type="button"
          onClick={() => {
            reset();
            void router.invalidate();
          }}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          <RefreshCw className="h-4 w-4" />
          Try again
        </button>
        <button
          type="button"
          onClick={() => void router.navigate({ to: '/' })}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Go to Content
        </button>
      </div>
    </div>
  );
}
