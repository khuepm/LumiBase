import { Check, Copy, Download } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useSetupStore, selectConfirmed } from '../setup-store';

/**
 * "Recovery Setup" step of the Setup Wizard.
 *
 * Implements Req 14.1 + 14.3 and design.md §5.2 (the component tree
 * lists this file as `step-recovery.tsx // hiển thị 8 backup codes +
 * checkbox xác nhận`).
 *
 * ── The data-flow nuance (read before editing) ──────────────────────
 *
 * The 8 plaintext backup codes exist for exactly ONE moment in the
 * client's lifetime: the body of the `POST /api/v1/setup/complete`
 * 201 response (`backupCodes: string[]`, see
 * `hooks/use-complete-setup.ts`). They are deliberately NOT written to
 * `sessionStorage` — the persisted Zustand slice in `setup-store.ts`
 * explicitly excludes them (see its doc comment: "the 8 plaintext
 * `backupCodes` ... rendered once in-memory ... and dropped on
 * navigation — Req 14.1"). Once that response is gone the codes are
 * unrecoverable; the server only kept PBKDF2 hashes.
 *
 * Because of that, `StepRecovery` is built as a PRESENTATIONAL +
 * CONTROLLED component, mirroring the `onSubmitted`-callback pattern
 * its sibling `step-security.tsx` uses (that step takes an
 * `onSubmitted?` callback and does NOT own navigation):
 *
 *   - The codes it renders arrive via the `backupCodes` prop. This
 *     keeps the component pure and trivially testable, and lets the
 *     routing / orchestration layer (a later task) decide where the
 *     codes come from — i.e. the in-memory `/setup/complete` response.
 *   - When `backupCodes` is empty (a deep-link or hard refresh that
 *     lost the in-memory codes) we render a graceful fallback panel
 *     rather than a broken page.
 *   - The confirmation checkbox is wired to the wizard's `confirmed`
 *     flag in the Zustand store (`selectConfirmed` + `setConfirmed`),
 *     the single piece of cross-step state this step owns (Req 14.3).
 *   - "Finish setup" is `disabled` until `confirmed === true`; on
 *     click it calls `onFinish?.()` and nothing else.
 *
 * ── What this file deliberately does NOT do ─────────────────────────
 *
 *   - It does NOT call `POST /api/v1/setup/complete` (that's the
 *     `useCompleteSetup` hook). The completion POST + the navigation
 *     to `/setup/done` are wired by the routing/orchestration task;
 *     this component only renders the codes, handles copy/download,
 *     manages the confirmation gate, and signals `onFinish`.
 *   - It does NOT own navigation or register routes.
 *   - It does NOT read the codes from `sessionStorage` — they never
 *     land there by design (see above). Codes-via-prop is the whole
 *     point.
 *   - It does NOT localize copy yet. Strings stay inline; a follow-up
 *     swaps them for i18n keys under `setup.steps.recovery.*`, exactly
 *     as the sibling steps note for their own copy.
 *
 * ── Accessibility ───────────────────────────────────────────────────
 *
 *   - `<h2>` heading sits under the layout's `<h1>` ("LumiBase
 *     Setup") for a clean two-level hierarchy.
 *   - `useId()` drives the heading / codes-region / status / checkbox
 *     ids; the checkbox label is linked via `htmlFor`.
 *   - Copy + Download buttons carry descriptive `aria-label`s.
 *   - The copy action surfaces a live region: `role="status"`
 *     (polite) on success and `role="alert"` on failure, mirroring
 *     the proven pattern in `step-done.tsx`.
 *   - The Finish button conveys its gated state with native
 *     `disabled` plus `aria-disabled`.
 *
 * Spec refs: requirements §14.1, §14.3; design.md §5.2 (component
 * tree), §5.3 (store), §7.3 (secret handling — backup codes are
 * single-use and shown exactly once).
 */

// ────────────────────────────────────────────────────────────────────────
// Helpers (pure, exported for unit tests)
// ────────────────────────────────────────────────────────────────────────

/**
 * First line written into the downloaded `.txt` file — a short
 * human-readable header reminding the operator what the file is and
 * that each code is single-use. Exported alongside the builder so a
 * test can pin the exact copy without re-deriving it.
 */
export const BACKUP_CODES_FILE_HEADER =
  'LumiBase backup codes — store securely. Each code works once.';

/**
 * Filename suggested by the "Download .txt" action.
 */
export const BACKUP_CODES_FILENAME = 'lumibase-backup-codes.txt';

/**
 * Build the plaintext body of the downloadable backup-codes file:
 * a single header line followed by one code per line, terminated with
 * a trailing newline so the file ends cleanly on POSIX tooling.
 *
 * Pure + exported so the file contents can be unit-tested without
 * React, a DOM, or `Blob`/`URL` — mirroring the exported
 * `joinAdminPathLogin` helper in `step-done.tsx`.
 */
export function buildBackupCodesFileContent(
  codes: readonly string[],
): string {
  return `${[BACKUP_CODES_FILE_HEADER, ...codes].join('\n')}\n`;
}

/**
 * Join the codes into the newline-separated string the "Copy" action
 * writes to the clipboard. Kept separate from the file builder
 * because the clipboard payload intentionally omits the header line —
 * an operator pasting into a password manager wants just the codes.
 */
export function joinBackupCodesForClipboard(
  codes: readonly string[],
): string {
  return codes.join('\n');
}

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

/**
 * Window of time (ms) the "Copied" confirmation stays visible after a
 * successful clipboard write before reverting to idle. Matches the
 * value used by `step-done.tsx` for a consistent feel.
 */
const COPY_CONFIRMATION_MS = 2000;

export interface StepRecoveryProps {
  /**
   * The plaintext backup codes to display. Sourced by the routing /
   * orchestration layer from the in-memory `/setup/complete` 201
   * response (never from `sessionStorage` — see the module doc). An
   * empty array renders the fallback panel.
   */
  backupCodes: readonly string[];
  /**
   * Invoked when the operator clicks "Finish setup" while the
   * confirmation checkbox is ticked. The routing layer uses it to
   * drive the completion POST + navigation to `/setup/done`; this
   * component intentionally owns neither.
   */
  onFinish?: () => void;
}

export function StepRecovery({ backupCodes, onFinish }: StepRecoveryProps) {
  // Branch before any hooks run so the two sub-components keep stable,
  // unconditional hook orders (same shape as `StepDone`).
  if (backupCodes.length === 0) {
    return <RecoveryNoCodes />;
  }
  return <RecoveryWithCodes backupCodes={backupCodes} onFinish={onFinish} />;
}

interface RecoveryWithCodesProps {
  backupCodes: readonly string[];
  onFinish?: () => void;
}

function RecoveryWithCodes({ backupCodes, onFinish }: RecoveryWithCodesProps) {
  const headingId = useId();
  const codesLabelId = useId();
  const copyStatusId = useId();
  const checkboxId = useId();

  // ── Confirmation gate (Req 14.3) ──────────────────────────────────
  // Read + write the wizard's `confirmed` flag straight off the store
  // so a refresh-and-return (the flag persists; the codes don't) keeps
  // the operator's acknowledgement intact, and the deep-link guard can
  // consult it once the Recovery route registers.
  const confirmed = useSetupStore(selectConfirmed);
  const setConfirmed = useSetupStore((s) => s.setConfirmed);

  // ── Copy-to-clipboard state ───────────────────────────────────────
  // Mirrors `step-done.tsx`: 'idle' default, 'copied' shows a Check
  // glyph + polite live region for COPY_CONFIRMATION_MS, 'error'
  // surfaces an assertive failure so a clipboard-blocked browser isn't
  // a silent no-op.
  type CopyState = 'idle' | 'copied' | 'error';
  const [copyState, setCopyState] = useState<CopyState>('idle');

  // Hold the hide-timer so a second click resets the countdown rather
  // than letting the first timeout cut the second confirmation short.
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up any pending timer on unmount so a state setter never
  // fires after the component is gone.
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

    // Defensive feature-check: SSR contexts and browsers that gate the
    // clipboard API behind a Permissions Policy won't expose
    // `navigator.clipboard`. Surface the failure rather than throw.
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
      await clipboard.writeText(joinBackupCodesForClipboard(backupCodes));
      setCopyState('copied');
    } catch {
      setCopyState('error');
    } finally {
      copyTimerRef.current = setTimeout(() => {
        setCopyState('idle');
        copyTimerRef.current = null;
      }, COPY_CONFIRMATION_MS);
    }
  }, [backupCodes]);

  // ── Download .txt ─────────────────────────────────────────────────
  // Build a Blob, mint an object URL, click a synthetic <a download>,
  // then revoke the URL. Defensive feature-checks keep this a safe
  // no-op under SSR / test environments missing `URL.createObjectURL`
  // or `document` so it never throws.
  const handleDownload = useCallback(() => {
    if (typeof document === 'undefined') return;
    if (
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return;
    }

    const content = buildBackupCodesFileContent(backupCodes);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = BACKUP_CODES_FILENAME;
      // Appending to the document makes the synthetic click reliable
      // across browsers; we remove it immediately afterwards.
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    } finally {
      if (typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url);
      }
    }
  }, [backupCodes]);

  return (
    <div className="space-y-6" aria-labelledby={headingId}>
      <header className="space-y-1">
        <h2
          id={headingId}
          className="text-lg font-semibold tracking-tight"
        >
          Save your recovery codes
        </h2>
        <p className="text-sm text-muted-foreground">
          Save these recovery codes. Each can be used once to regain
          access if you&rsquo;re locked out. They won&rsquo;t be shown
          again.
        </p>
      </header>

      {/* ── Backup codes ──────────────────────────────────────────── */}
      <section aria-labelledby={codesLabelId} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p
            id={codesLabelId}
            className="text-sm font-medium text-foreground"
          >
            Your backup codes
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copy backup codes"
              aria-describedby={copyStatusId}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
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
            <button
              type="button"
              onClick={handleDownload}
              aria-label="Download backup codes as a text file"
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              <span>Download .txt</span>
            </button>
          </div>
        </div>

        <ul
          aria-labelledby={codesLabelId}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          {backupCodes.map((code, index) => (
            // Codes are unique by construction (CSPRNG, Req 14.1); the
            // index suffix only guards against a hypothetical duplicate
            // in a malformed prop so React keys stay stable.
            <li key={`${code}-${index}`}>
              <code className="block rounded-md border border-border bg-muted/40 px-3 py-2 text-center font-mono text-sm tracking-wider break-all">
                {code}
              </code>
            </li>
          ))}
        </ul>

        {/*
          Copy live region. Render different politeness levels for
          success vs failure; always render the element (visually
          hidden when idle) so the `aria-describedby` id stays valid.
        */}
        {copyState === 'copied' ? (
          <p
            id={copyStatusId}
            role="status"
            aria-live="polite"
            className="text-xs text-emerald-700"
          >
            Copied backup codes to clipboard.
          </p>
        ) : copyState === 'error' ? (
          <p id={copyStatusId} role="alert" className="text-xs text-red-600">
            Couldn&rsquo;t copy automatically. Select the codes above and
            copy them manually, or use Download .txt.
          </p>
        ) : (
          <span id={copyStatusId} className="sr-only" aria-hidden="true" />
        )}
      </section>

      {/* ── Save-these reminder ───────────────────────────────────── */}
      <aside
        role="note"
        className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100"
      >
        Store these somewhere safe and offline — a password manager or a
        printout. Without them (or your admin path) you&rsquo;ll need the
        email recovery flow to get back in.
      </aside>

      {/* ── Confirmation gate (Req 14.3) ──────────────────────────── */}
      <label
        htmlFor={checkboxId}
        className="flex items-start gap-3 text-sm"
      >
        <input
          id={checkboxId}
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-2 focus:ring-primary/30"
        />
        <span className="text-foreground">
          I have saved these backup codes
        </span>
      </label>

      {/* ── Finish setup ──────────────────────────────────────────── */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={() => onFinish?.()}
          disabled={!confirmed}
          aria-disabled={!confirmed}
          className={cn(
            'inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          Finish setup
        </button>
      </div>
    </div>
  );
}

/**
 * Fallback panel rendered when `backupCodes` is empty — e.g. the
 * operator deep-linked to the Recovery step or hard-refreshed, losing
 * the in-memory codes from the `/setup/complete` response (they're
 * never persisted, by design). The codes are unrecoverable at this
 * point, so the only safe action is to restart the wizard.
 */
function RecoveryNoCodes() {
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">
          No backup codes to display
        </h2>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Your recovery codes are shown only once, right after setup
          completes, and aren&rsquo;t stored in this browser. Return to
          setup to generate a fresh set.
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

export default StepRecovery;
