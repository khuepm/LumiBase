import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  shouldShowSetupStateError,
  useSetupStateQuery,
} from './use-setup-state-query';

/**
 * sessionStorage key under which `readSetupToken` caches the operator-
 * supplied setup token between page navigations. Exported so other
 * modules in the wizard (notably `useCompleteSetup`) can read the same
 * key when assembling `POST /setup/complete` payloads and clear it on
 * a successful completion.
 */
export const SETUP_TOKEN_STORAGE_KEY = 'lumibase.setup.token';

/**
 * Read a setup token from `?token=` query param (preferred — matches the
 * URL the operator pastes from CMS stdout, Req 2.3) with sessionStorage
 * fallback so the token survives across step navigation.
 *
 * NOTE: This treats any non-empty token string as locally accepted. Real
 * server-side validation happens inside `POST /api/v1/setup/complete`
 * (which re-checks the token hash). A dedicated `/setup/verify-token`
 * endpoint may land in a follow-up task; for now the prompt simply
 * unblocks rendering the wizard.
 */
function readSetupToken(): string | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get('token');
  if (fromQuery && fromQuery.trim().length > 0) {
    try {
      window.sessionStorage.setItem(SETUP_TOKEN_STORAGE_KEY, fromQuery);
    } catch {
      // sessionStorage may be unavailable (private mode) — query-param wins
      // anyway, this is just a soft persistence.
    }
    return fromQuery;
  }
  try {
    const stored = window.sessionStorage.getItem(SETUP_TOKEN_STORAGE_KEY);
    return stored && stored.trim().length > 0 ? stored : null;
  } catch {
    return null;
  }
}

function persistSetupToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SETUP_TOKEN_STORAGE_KEY, token);
  } catch {
    // ignore
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('token', token);
    window.history.replaceState({}, '', url.toString());
  } catch {
    // ignore
  }
}

interface SetupStateGateProps {
  children: ReactNode;
}

/**
 * Gate for every public Setup Wizard route.
 *
 * Decision tree (spec §5.2 / Req 2.1–2.4):
 *
 *   ┌── loading                 → spinner
 *   ├── network/5xx error       → retry UI
 *   ├── state = 'initialized'   → hard 404 (no redirect, no AppShell leak)
 *   ├── requires token, none yet → SetupTokenPrompt
 *   └── otherwise              → render `children` (the wizard step)
 *
 * The gate sits *outside* `SetupLayout` so the 404 / retry / token-prompt
 * screens never display the progress indicator chrome.
 */
export function SetupStateGate({ children }: SetupStateGateProps) {
  const [token, setToken] = useState<string | null>(() => readSetupToken());
  const [hasFailed, setHasFailed] = useState(false);

  const query = useSetupStateQuery();

  // Latch failure until the next success so a manual refetch (which can
  // briefly put the query back into `pending` when there is no cached
  // data) does not replace the alert with the full-page spinner.
  useEffect(() => {
    if (query.isError) setHasFailed(true);
    if (query.isSuccess) setHasFailed(false);
  }, [query.isError, query.isSuccess]);

  // If the token query param appears later (e.g. user pastes a fresh URL),
  // pick it up so the prompt unblocks without a manual reload.
  useEffect(() => {
    const onPop = () => setToken(readSetupToken());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (
    shouldShowSetupStateError({
      isError: query.isError,
      isSuccess: query.isSuccess,
      isFetching: query.isFetching,
      hasFailed,
    })
  ) {
    return (
      <SetupRetryScreen
        isRetrying={query.isFetching}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  if (query.isPending || !query.data) {
    return <SetupLoadingScreen />;
  }

  if (query.data.state === 'initialized') {
    // Hard 404 — never redirect, never reveal the Studio AppShell. (Req 2.2)
    return <SetupNotFoundScreen />;
  }

  if (query.data.requiresSetupToken && !token) {
    return (
      <SetupTokenPrompt
        onSubmit={(value) => {
          persistSetupToken(value);
          setToken(value);
        }}
      />
    );
  }

  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Standalone screens — no progress chrome, no Studio AppShell.
// ---------------------------------------------------------------------------

/** Centered shell used by every gate-only screen. */
function GateShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md rounded-xl border bg-background p-8 shadow-sm">
        {children}
      </div>
    </div>
  );
}

function SetupLoadingScreen() {
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

interface SetupRetryScreenProps {
  onRetry: () => void;
  isRetrying?: boolean;
}

function SetupRetryScreen({ onRetry, isRetrying = false }: SetupRetryScreenProps) {
  return (
    <GateShell>
      <div role="alert" className="space-y-4">
        <h1 className="text-lg font-semibold">Couldn’t reach the server</h1>
        <p className="text-sm text-muted-foreground">
          We couldn’t check whether this instance has been set up yet. Make
          sure the LumiBase backend is running, then try again.
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
    </GateShell>
  );
}

/**
 * Hard 404 rendered when the instance is already initialized. Uses status
 * markup so screen readers don't announce it as the wizard. Crucially this
 * does NOT mount any Studio AppShell, sidebar, or wizard chrome (Req 2.2).
 */
function SetupNotFoundScreen() {
  return (
    <GateShell>
      <div className="space-y-3 text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          404
        </p>
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          The page you’re looking for doesn’t exist.
        </p>
      </div>
    </GateShell>
  );
}

interface SetupTokenPromptProps {
  onSubmit: (token: string) => void;
}

/**
 * Prompt rendered when the backend reports `requiresSetupToken=true` but the
 * URL doesn't carry a `?token=` query param yet. Operator workflow (Req 2.3):
 *
 *   1. Start CMS with `LUMIBASE_REQUIRE_SETUP_TOKEN=true`.
 *   2. CMS prints the token to stdout exactly once at startup.
 *   3. Operator pastes the token here; we persist it to sessionStorage and
 *      mirror it into the URL so a refresh keeps the wizard accessible.
 *
 * Final validation happens server-side at `POST /setup/complete`. We accept
 * any non-empty token locally — see `readSetupToken` comment.
 */
export function SetupTokenPrompt({ onSubmit }: SetupTokenPromptProps) {
  const [value, setValue] = useState('');
  const trimmed = useMemo(() => value.trim(), [value]);
  const canSubmit = trimmed.length > 0;

  return (
    <GateShell>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          onSubmit(trimmed);
        }}
      >
        <div className="space-y-2">
          <h1 className="text-lg font-semibold">Setup token required</h1>
          <p className="text-sm text-muted-foreground">
            This instance was started with{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              LUMIBASE_REQUIRE_SETUP_TOKEN=true
            </code>
            . Paste the one-time setup token printed in the CMS startup logs
            to continue.
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Setup token</span>
          <input
            type="text"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
            aria-label="Setup token"
          />
        </label>

        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Continue
        </button>
      </form>
    </GateShell>
  );
}
