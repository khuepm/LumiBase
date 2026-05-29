import { Check, Copy } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSetupStore, selectAdminPath } from '../setup-store';

/**
 * "Done" step of the Setup Wizard.
 *
 * Implements Req 4.5 and design.md §5.4:
 *
 *   - Read the chosen `adminPath` straight off the persisted Zustand
 *     store (set by `useCompleteSetup` on a 201 response from
 *     `POST /api/v1/setup/complete`). The store is the single source
 *     of truth on this step — we deliberately do NOT call any API
 *     here (the bootstrap admin isn't logged in yet, so the
 *     authenticated `GET /me/admin-path` endpoint from task 4.4 isn't
 *     reachable) and we do NOT read from `sessionStorage` directly.
 *   - If `adminPath` is null (e.g. the operator hard-refreshed and
 *     `sessionStorage` was cleared, or they deep-linked to
 *     `/setup/done` before completing the flow) we render a fallback
 *     "no admin path on file" panel with a link back to `/setup`. The
 *     deep-link guard from task 3.9 will already have redirected such
 *     visits in normal navigation; this fallback is the belt-and-
 *     braces case for a direct URL hit during the brief window before
 *     the guard runs.
 *   - Reminds the operator to bookmark `${adminPath}` (Req 4.5: "Lưu
 *     lại path này. Mất path đồng nghĩa cần chạy recovery flow.").
 *   - Primary CTA is a plain `<a href>` (NOT TanStack `<Link>`)
 *     pointing at `${adminPath}/login`. The destination is outside
 *     the public layout route — the admin path guard from task 4.2
 *     and the Studio router for the authenticated AppShell only
 *     engage on a fresh document load — so we want a full navigation,
 *     not the SPA in-memory route swap that `<Link>` would do.
 *   - Secondary "Reset wizard" link is a plain `<a href="/setup">`
 *     that also clears the persisted store. Useful in development
 *     for re-running the flow without manually wiping
 *     `sessionStorage`. Marked unobtrusively; can be removed once
 *     the flow stabilises. We use a bare anchor (rather than
 *     TanStack `<Link>`) for two reasons: (1) the `/setup` route
 *     isn't registered in the typed router tree until task 3.9
 *     wires public routes, and (2) we want a fresh document load so
 *     `SetupStateGate` re-runs and the wizard starts cleanly.
 *
 * Accessibility:
 *   - `<h2>` heading sits inside the layout's `<h1>` ("LumiBase
 *     Setup") for a clean two-level hierarchy.
 *   - The success paragraph carries `aria-live="polite"` so screen
 *     readers announce arrival on this terminal step without
 *     interrupting any other live region.
 *   - The Copy button has `aria-label="Copy admin path"`; on a
 *     successful clipboard write we render a transient "Copied"
 *     confirmation (`role="status"`) that auto-clears after 2s. We
 *     also flip the visible button glyph to a check mark in the same
 *     window for a sighted-user signal.
 *
 * What this file deliberately does NOT do:
 *   - It does not localize copy. Strings stay inline; task 3.10 swaps
 *     them for i18n keys under `setup.steps.done.*`.
 *   - It does not surface the 8 backup codes from `/setup/complete`.
 *     Those are the Recovery step's responsibility (task 10.3) and
 *     are already shown + acknowledged before the wizard reaches
 *     here.
 *   - It does not call the admin-path-guard or auth APIs. Login
 *     happens on the next page load, after the bookmark click.
 *
 * Spec refs: requirements §4.5; design.md §5.4 (state machine), §5.2
 * (cwd component tree), §5.3 (store).
 */

// ────────────────────────────────────────────────────────────────────────
// Helpers (pure, exported for unit tests)
// ────────────────────────────────────────────────────────────────────────

/**
 * Join a stored admin path with `/login` into a fully formed URL the
 * `<a href>` CTA can navigate to.
 *
 * The CMS schema (`apps/cms/src/modules/setup/path-validator.ts`)
 * already normalises `adminPath` to a single leading slash with no
 * trailing slash — but we are defensive on the client too because:
 *
 *   - the value could come from a future store migration that preserves
 *     a legacy un-normalised entry,
 *   - the caller might have hand-typed it during a dev re-run.
 *
 * The function:
 *   - returns a string of the form `<normalisedAdminPath>/login`,
 *   - trims surrounding whitespace,
 *   - collapses any number of leading slashes to exactly one,
 *   - drops any trailing slash before appending `/login`,
 *   - returns the bare `'/login'` if `adminPath` is empty / pure
 *     whitespace (the caller guards on `null` separately so an empty
 *     string here is a malformed input we still render usefully).
 */
export function joinAdminPathLogin(adminPath: string): string {
  const trimmed = adminPath.trim();
  if (trimmed.length === 0) return '/login';

  // Collapse any run of leading slashes to a single one. Without this
  // a stored value of `'//lumi-7f3a9c'` would render as
  // `'//lumi-7f3a9c/login'` and the browser would treat it as a
  // protocol-relative URL — a small but real foot-gun.
  const noLeading = trimmed.replace(/^\/+/, '');

  // Drop any trailing slash so the final string never doubles up to
  // `/foo//login`.
  const noTrailing = noLeading.replace(/\/+$/, '');

  // Re-attach the canonical single leading slash. If `noTrailing`
  // ended up empty (input was just slashes) we fall back to `/login`.
  return noTrailing.length === 0 ? '/login' : `/${noTrailing}/login`;
}

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

/**
 * Window of time (ms) the "Copied" confirmation stays visible after a
 * successful clipboard write before fading out.
 */
const COPY_CONFIRMATION_MS = 2000;

export function StepDone() {
  const adminPath = useSetupStore(selectAdminPath);

  if (adminPath === null) {
    return <DoneNoAdminPath />;
  }

  return <DoneWithAdminPath adminPath={adminPath} />;
}

interface DoneWithAdminPathProps {
  adminPath: string;
}

function DoneWithAdminPath({ adminPath }: DoneWithAdminPathProps) {
  const headingId = useId();
  const adminPathBoxId = useId();
  const copyStatusId = useId();

  // Compute the CTA href once per `adminPath` change. Cheap; not
  // memoised because re-evaluation is a few regex calls.
  const loginHref = joinAdminPathLogin(adminPath);

  // ── Copy-to-clipboard state ────────────────────────────────────────
  // Two visible states drive UI:
  //   - 'idle': default; button shows the Copy icon and label.
  //   - 'copied': button shows a Check icon for COPY_CONFIRMATION_MS;
  //     a polite live region announces "Copied admin path".
  // We also surface 'error' so a sighted user knows the action failed
  // (e.g. clipboard API blocked by the browser); screen readers get an
  // assertive announcement so the failure isn't silent.
  type CopyState = 'idle' | 'copied' | 'error';
  const [copyState, setCopyState] = useState<CopyState>('idle');

  // Hold the timer so a second click within the window resets the
  // countdown rather than letting the first timeout cut the second
  // confirmation short.
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up any pending timer on unmount so the React state setter
  // doesn't fire after the component is gone.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    // Reset any pending hide-timer up front so two rapid clicks don't
    // interleave their state transitions.
    if (copyTimerRef.current !== null) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }

    // Defensive feature-check: SSR contexts and very old browsers
    // (or those with the clipboard API gated by Permissions Policy)
    // won't expose `navigator.clipboard`. We surface the failure
    // rather than throw.
    const clipboard =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      setCopyState('error');
      copyTimerRef.current = setTimeout(() => {
        setCopyState('idle');
        copyTimerRef.current = null;
      }, COPY_CONFIRMATION_MS);
      return;
    }

    try {
      await clipboard.writeText(adminPath);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    } finally {
      copyTimerRef.current = setTimeout(() => {
        setCopyState('idle');
        copyTimerRef.current = null;
      }, COPY_CONFIRMATION_MS);
    }
  }, [adminPath]);

  // ── Reset wizard (dev convenience) ────────────────────────────────
  const handleResetWizard = useCallback(() => {
    // Use the imperative store getter so this stays a one-shot side
    // effect — we don't need to subscribe to the action.
    useSetupStore.getState().reset();
  }, []);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2
          id={headingId}
          className="text-lg font-semibold tracking-tight"
        >
          Setup complete
        </h2>
        <p
          className="text-sm text-muted-foreground"
          aria-live="polite"
        >
          Your LumiBase instance is initialised. Save the admin URL
          below before navigating away.
        </p>
      </header>

      {/* ── Admin path display + copy ─────────────────────────────── */}
      <section
        aria-labelledby={`${adminPathBoxId}-label`}
        className="space-y-2"
      >
        <p
          id={`${adminPathBoxId}-label`}
          className="text-sm font-medium text-foreground"
        >
          Your admin path
        </p>
        <div className="flex items-stretch gap-2">
          <code
            id={adminPathBoxId}
            className="flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm break-all"
          >
            {adminPath}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copy admin path"
            aria-describedby={copyStatusId}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copyState === 'copied' ? (
              <>
                <Check
                  className="h-4 w-4 text-emerald-600"
                  aria-hidden="true"
                />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" aria-hidden="true" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
        {/*
          Live region for assistive tech. We render different politeness
          levels for success vs error so a clipboard-blocked browser
          gets an assertive announcement instead of a silent no-op.
        */}
        {copyState === 'copied' ? (
          <p
            id={copyStatusId}
            role="status"
            aria-live="polite"
            className="text-xs text-emerald-700"
          >
            Copied admin path to clipboard.
          </p>
        ) : copyState === 'error' ? (
          <p
            id={copyStatusId}
            role="alert"
            className="text-xs text-red-600"
          >
            Couldn&rsquo;t copy automatically. Select the path above
            and copy it manually.
          </p>
        ) : (
          // Always render an empty live region so the IDs in
          // `aria-describedby` stay valid; visually hidden so it
          // doesn't push layout around between states.
          <span
            id={copyStatusId}
            className="sr-only"
            aria-hidden="true"
          />
        )}
      </section>

      {/* ── Save-this-URL reminder ────────────────────────────────── */}
      <aside
        role="note"
        className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100"
      >
        Save this URL as a bookmark. Without it, you&rsquo;ll need to
        run the recovery flow with one of your backup codes.
      </aside>

      {/* ── Primary CTA: full navigation to the admin login ───────── */}
      <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
        {/*
          Plain anchor — NOT TanStack `<Link>`. We want a real
          document load so the admin path guard middleware (task 4.2)
          and the AppShell route tree pick the request up fresh. A
          client-side navigation here would land us on a route the
          public layout doesn't know about and bypass the guard.
        */}
        <a
          href={loginHref}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
        >
          Go to admin login
        </a>

        {/*
          Secondary "Reset wizard" link. Useful for developers
          re-running the flow without manually clearing
          `sessionStorage`; unobtrusive in production. The handler
          fires on click so the store is wiped before the browser
          navigates back to `/setup`.
        */}
        <a
          href="/setup"
          onClick={handleResetWizard}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Reset wizard (dev)
        </a>
      </div>
    </div>
  );
}

/**
 * Fallback panel rendered when `useSetupStore` reports no `adminPath`
 * on file. In normal navigation the deep-link guard from task 3.9
 * catches this case and redirects, but a direct hit on `/setup/done`
 * before the guard mounts (or after a `sessionStorage` wipe) still
 * needs a sane page — empty state with a clear way back into the
 * wizard.
 */
function DoneNoAdminPath() {
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">
          No setup in progress
        </h2>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          We couldn&rsquo;t find a completed setup in this browser
          session. Start the wizard from the beginning to configure
          your instance.
        </p>
      </header>
      <a
        href="/setup"
        className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
      >
        Return to setup
      </a>
    </div>
  );
}

export default StepDone;
