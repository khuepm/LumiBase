import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * Cross-step state for the Admin Setup Wizard.
 *
 * The wizard navigates Account → Path → Security → Recovery → Done
 * (design.md §5.4). Each step needs a small amount of "did this step
 * pass validation" state visible to:
 *
 *   - the deep-link guard (`/setup/security` while `pathValid=false`
 *     redirects back to `/setup/path`, design §11.2);
 *   - the progress indicator chrome in `setup-layout.tsx`;
 *   - the Done step, which surfaces the chosen `adminPath` so the
 *     operator can bookmark `${adminPath}/login`.
 *
 * The actual form *values* (email, password, policy fields) live in
 * each step's local React Hook Form state and are flushed to the
 * `POST /api/v1/setup/complete` mutation in one shot — they never land
 * here. Persisting only boolean validity flags keeps the wizard robust
 * to a hard refresh without ever putting the plaintext password (or any
 * other secret) into `sessionStorage`.
 *
 * Spec refs: design.md §5.3 (state management), §5.4 (step machine),
 * §11.2 (deep-link guard).
 */

// ── Storage layout ───────────────────────────────────────────────────────

/**
 * sessionStorage key for the persisted slice. Spec design §5.3 fixes
 * this name as `'lumibase.setup'`; do not rename without coordinating
 * a `version` bump + migration in the persist middleware below.
 */
export const SETUP_STORE_STORAGE_KEY = 'lumibase.setup';

/**
 * Persist schema version. Bump and add a `migrate` handler whenever
 * the persisted shape changes in a way old stored state can't
 * deserialize cleanly.
 */
const SETUP_STORE_VERSION = 1;

// ── State ────────────────────────────────────────────────────────────────

/**
 * The full state surface (flags + adminPath + actions). Only the
 * shape defined by `PersistedSetupState` survives a refresh — the
 * action methods are re-attached at hydration time by the store
 * factory below.
 */
export interface SetupState {
  /** `true` once the Account step's Zod schema validates. */
  accountValid: boolean;
  /** `true` once the Path step's Zod schema validates. */
  pathValid: boolean;
  /** `true` once the Security/policy step validates. */
  policyValid: boolean;
  /**
   * `true` once the operator ticks the "I have saved these backup
   * codes" checkbox on the Recovery step (Req 14.3).
   */
  confirmed: boolean;
  /**
   * `true` after `POST /setup/complete` returns 201 Created. Drives
   * the redirect to `/setup/done` and unblocks that step's deep-link
   * guard.
   */
  completed: boolean;
  /**
   * Normalized `/<slug>` admin path captured from the `/setup/complete`
   * response. Surfaced on the Done step so the operator can bookmark
   * the URL. Stored client-side because the path is not a secret to
   * the just-authenticated bootstrap admin (Req 4.7 — admin can fetch
   * it post-login via `/me/admin-path`); we keep a copy here so the
   * Done step renders without an extra round-trip.
   */
  adminPath: string | null;

  // Setters — one per persisted field for explicit, debuggable updates.
  setAccountValid: (value: boolean) => void;
  setPathValid: (value: boolean) => void;
  setPolicyValid: (value: boolean) => void;
  setConfirmed: (value: boolean) => void;
  setCompleted: (value: boolean) => void;
  setAdminPath: (path: string | null) => void;
  /**
   * Reset every persisted field back to its default. Called on a
   * successful `/setup/complete` response after the operator has been
   * shown the Done step, so a future visitor never sees stale flags
   * from a prior browser session.
   */
  reset: () => void;
}

/**
 * The subset of `SetupState` that actually lands in sessionStorage.
 * Critically EXCLUDES anything that could leak a secret:
 *
 *   - plaintext `password` / `confirmPassword` (held only in React
 *     Hook Form local state on the Account step);
 *   - the `setupToken` (handled separately by `setup-state-gate.tsx`);
 *   - the 8 plaintext `backupCodes` (rendered once in-memory on the
 *     Recovery step from the `/setup/complete` 201 response and
 *     dropped on navigation — Req 14.1).
 *
 * Only the boolean validity flags + the chosen `adminPath` survive a
 * page refresh.
 */
type PersistedSetupState = Pick<
  SetupState,
  | 'accountValid'
  | 'pathValid'
  | 'policyValid'
  | 'confirmed'
  | 'completed'
  | 'adminPath'
>;

const DEFAULT_PERSISTED_STATE: PersistedSetupState = {
  accountValid: false,
  pathValid: false,
  policyValid: false,
  confirmed: false,
  completed: false,
  adminPath: null,
};

// ── Store factory ────────────────────────────────────────────────────────

/**
 * Zustand hook for the setup wizard state. Use the typed selectors
 * exported below in components for a stable identity and minimal
 * re-renders.
 *
 * Persistence:
 *   - storage: `sessionStorage` via `createJSONStorage` (cleared when
 *     the tab closes — appropriate for a one-shot wizard).
 *   - name: `'lumibase.setup'` (design §5.3).
 *   - partialize: only the persisted slice shape; never the action
 *     fns or any future transient state.
 *   - version: `1`. Bump + add `migrate` for breaking shape changes.
 *
 * SSR safety: Studio is a pure Vite SPA so `window` is always defined
 * at runtime. `createJSONStorage` is still given a function (rather
 * than a direct reference) so it falls back gracefully under
 * `typeof window === 'undefined'` test/SSR contexts.
 */
export const useSetupStore = create<SetupState>()(
  persist(
    (set) => ({
      ...DEFAULT_PERSISTED_STATE,

      setAccountValid: (value) => set({ accountValid: value }),
      setPathValid: (value) => set({ pathValid: value }),
      setPolicyValid: (value) => set({ policyValid: value }),
      setConfirmed: (value) => set({ confirmed: value }),
      setCompleted: (value) => set({ completed: value }),
      setAdminPath: (path) => set({ adminPath: path }),

      reset: () => set({ ...DEFAULT_PERSISTED_STATE }),
    }),
    {
      name: SETUP_STORE_STORAGE_KEY,
      version: SETUP_STORE_VERSION,
      storage: createJSONStorage(() => {
        // Guard against SSR / non-browser contexts; production Studio
        // runs in the browser so the `window.sessionStorage` branch is
        // the hot path. The fallback only has to satisfy zustand's
        // `StateStorage` interface (getItem/setItem/removeItem) — not
        // the full DOM `Storage` interface.
        if (typeof window !== 'undefined') return window.sessionStorage;
        return {
          getItem: () => null,
          setItem: () => undefined,
          removeItem: () => undefined,
        };
      }),
      /**
       * Whitelist of fields that survive a refresh. We DO NOT persist
       * the action functions (zustand re-attaches them at hydration)
       * and — by design — DO NOT persist any plaintext password,
       * setup token, or backup codes.
       */
      partialize: (state): PersistedSetupState => ({
        accountValid: state.accountValid,
        pathValid: state.pathValid,
        policyValid: state.policyValid,
        confirmed: state.confirmed,
        completed: state.completed,
        adminPath: state.adminPath,
      }),
    },
  ),
);

// ── Selectors (typed, stable identity) ───────────────────────────────────

/**
 * Stable selectors so components subscribing to a single field don't
 * re-render when an unrelated field updates. Prefer these in step
 * components over inline `useSetupStore((s) => s.x)` so the call
 * sites stay grep-able.
 */
export const selectAccountValid = (s: SetupState): boolean => s.accountValid;
export const selectPathValid = (s: SetupState): boolean => s.pathValid;
export const selectPolicyValid = (s: SetupState): boolean => s.policyValid;
export const selectConfirmed = (s: SetupState): boolean => s.confirmed;
export const selectCompleted = (s: SetupState): boolean => s.completed;
export const selectAdminPath = (s: SetupState): string | null => s.adminPath;
