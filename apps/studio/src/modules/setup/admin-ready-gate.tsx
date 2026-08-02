import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { hasActiveToken } from '@/lib/api';
import { shouldAutoRedirectToAdmin } from './setup-environment';
import { selectAdminPath, useSetupStore } from './setup-store';
import {
  shouldShowSetupStateError,
  useSetupStateQuery,
} from './use-setup-state-query';

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
  const { location } = useRouterState();
  const adminPath = useSetupStore(selectAdminPath);
  const query = useSetupStateQuery();
  const [hasFailed, setHasFailed] = useState(false);

  useEffect(() => {
    if (query.isError) setHasFailed(true);
    if (query.isSuccess) setHasFailed(false);
  }, [query.isError, query.isSuccess]);

  useEffect(() => {
    if (query.data?.state === 'uninitialized') {
      navigate({ to: '/setup' });
      return;
    }
    if (
      query.data?.state === 'initialized' &&
      !hasActiveToken() &&
      adminPath &&
      shouldAutoRedirectToAdmin()
    ) {
      navigate({ to: `${adminPath}/login` });
    }
  }, [adminPath, navigate, query.data?.state]);

  // Stable error screen first — never fall back to the spinner while a
  // manual retry is in flight (avoids a continuous-refresh feeling when
  // the CMS is down).
  if (
    shouldShowSetupStateError({
      isError: query.isError,
      isSuccess: query.isSuccess,
      isFetching: query.isFetching,
      hasFailed,
    })
  ) {
    return (
      <AdminReadyErrorScreen
        isRetrying={query.isFetching}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  if (query.isPending || query.data?.state === 'uninitialized') {
    return <AdminReadyLoadingScreen />;
  }

  if (!hasActiveToken()) {
    return <AdminReadyLoginRequiredScreen currentPath={location.pathname} />;
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

function AdminReadyLoginRequiredScreen({ currentPath }: { currentPath: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div role="alert" className="w-full max-w-md rounded-md border bg-background p-8 shadow-sm">
        <div className="space-y-3">
          <h1 className="text-lg font-semibold">Not found</h1>
          <p className="text-sm text-muted-foreground">
            The Studio is available only from the configured admin URL.
          </p>
          {currentPath === '/' ? (
            <p className="text-xs text-muted-foreground">
              Use the admin URL saved at the end of setup.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AdminReadyErrorScreen({
  onRetry,
  isRetrying = false,
}: {
  onRetry: () => void;
  isRetrying?: boolean;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div role="alert" className="w-full max-w-md rounded-xl border bg-background p-8 shadow-sm">
        <div className="space-y-4">
          <h1 className="text-lg font-semibold">Couldn’t reach the server</h1>
          <p className="text-sm text-muted-foreground">
            We couldn’t check whether this instance has finished setup yet.
            Make sure the LumiBase backend is running, then try again.
          </p>
          <button
            type="button"
            onClick={onRetry}
            disabled={isRetrying}
            aria-busy={isRetrying}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isRetrying ? (
              <span
                className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"
                aria-hidden
              />
            ) : null}
            {isRetrying ? 'Checking…' : 'Try again'}
          </button>
        </div>
      </div>
    </div>
  );
}
