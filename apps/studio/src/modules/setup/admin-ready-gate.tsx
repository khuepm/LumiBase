import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';
import {
  fetchSetupState,
  type SetupStateFetchError,
  type SetupStateResponse,
} from './setup-state';

interface AdminReadyGateProps {
  children: ReactNode;
}

/**
 * Guard for the authenticated Studio shell.
 *
 * The public setup wizard owns first-time initialization. Until the backend
 * reports `initialized`, dashboard chrome and admin modules should not mount.
 */
export function AdminReadyGate({ children }: AdminReadyGateProps) {
  const navigate = useNavigate();
  const query = useQuery<SetupStateResponse, SetupStateFetchError>({
    queryKey: ['setup', 'state', 'admin-ready'],
    queryFn: fetchSetupState,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (query.data?.state === 'uninitialized') {
      navigate({ to: '/setup' });
    }
  }, [navigate, query.data?.state]);

  if (query.isPending || query.data?.state === 'uninitialized') {
    return <AdminReadyLoadingScreen />;
  }

  if (query.isError) {
    return (
      <AdminReadyErrorScreen
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  return <>{children}</>;
}

function AdminReadyLoadingScreen() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-muted/30"
      role="status"
      aria-live="polite"
      aria-label="Checking setup status"
    >
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

function AdminReadyErrorScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div role="alert" className="w-full max-w-md rounded-xl border bg-background p-8 shadow-sm">
        <div className="space-y-4">
          <h1 className="text-lg font-semibold">Couldn’t reach the server</h1>
          <p className="text-sm text-muted-foreground">
            We couldn’t check whether this instance has finished setup yet.
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
