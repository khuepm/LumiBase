import {
  useMutation,
  type UseMutationResult,
} from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { clearAccountDraft, getAccountDraft } from '../steps/step-account';
import { clearPathDraft, getPathDraft } from '../steps/step-path';
import type { LockoutPolicyFormValues } from '../schemas/policy';
import { SETUP_TOKEN_STORAGE_KEY } from '../setup-state-gate';
import { useSetupStore } from '../setup-store';

/**
 * Mutation hook that finalizes the Admin Setup Wizard by calling
 * `POST /api/v1/setup/complete` (design §4.3) with the in-memory
 * Account + Path drafts plus the Security step's policy values.
 *
 * Lifecycle on success (Req 1.5, 3.6, 4.6, 14.1):
 *
 *   1. Persist `adminPath` into the Zustand store so the Done step can
 *      surface it for the operator to bookmark.
 *   2. Flip the wizard's `completed` flag to true.
 *   3. Drop the in-memory account/path drafts so the plaintext
 *      password and chosen path don't outlive their single
 *      legitimate use.
 *   4. Remove the cached setup token from `sessionStorage` so future
 *      visitors of the same tab can't resubmit the wizard.
 *   5. Navigate to `/setup/done`.
 *
 * On failure: the mutation surfaces a `SetupCompleteError` carrying a
 * normalized `code` (see `SetupCompleteErrorCode`). The hook does NOT
 * navigate away — consumers (the Security step's submit handler) read
 * `mutation.error` and render an inline banner. We deliberately do
 * not auto-retry: a 4xx classification represents a deterministic
 * client error, and a transient 5xx may have already mutated state on
 * the server (the wizard is single-shot per row-lock, see design §6.6).
 *
 * Note: `useSetupStore.getState().reset()` is intentionally NOT called
 * here. The Done step still needs `adminPath` from the store (it's set
 * on step 1 above), and resetting would clobber it. The wizard's reset
 * lives on the Done step's "Reset wizard" link instead.
 *
 * Spec refs: requirements §1.5, §2.6 (setup token clear), §3.6, §4.6,
 * §14.1; design.md §4.3 (request/response contract), §5.2 (mutations),
 * §7.3 (secret handling — backup codes single-use, plaintext password
 * never persists).
 */

// ── Public types ─────────────────────────────────────────────────────────

/**
 * Caller-supplied payload. Account and admin path come from the
 * module-scoped drafts in `step-account.tsx` / `step-path.tsx` to keep
 * the plaintext password out of any persistent storage; the operator
 * provides only the policy values from the Security step.
 */
export interface SetupCompletePayload {
  policy: LockoutPolicyFormValues;
}

/**
 * Shape of the 201 Created response from `POST /setup/complete`. Mirrors
 * design §4.3 verbatim. `setupToken` is always `null` post-completion —
 * the server invalidates it as part of the same transaction.
 */
export interface SetupCompleteResponse {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  adminPath: string;
  /** Eight plaintext backup codes — returned exactly once (Req 14.1). */
  backupCodes: string[];
  setupToken: null;
}

/**
 * Discriminated error codes the hook surfaces to consumers. Mirrors
 * the status codes / error envelope codes from design §4.3 plus a
 * `UNKNOWN` bucket for unexpected status codes or malformed bodies.
 */
export type SetupCompleteErrorCode =
  | 'VALIDATION_ERROR'
  | 'ALREADY_INITIALIZED'
  | 'SETUP_IN_PROGRESS'
  | 'PATH_PREDICTABLE'
  | 'PATH_RESERVED'
  | 'UNKNOWN';

/**
 * Error subtype the mutation throws when `POST /setup/complete` fails.
 * Carries the original HTTP status (or `undefined` for network errors)
 * plus a normalized `code` that the UI can switch on to render an
 * appropriate banner. The `message` defaults to a human-readable
 * string but consumers should generally render copy keyed off `code`.
 */
export class SetupCompleteError extends Error {
  readonly code: SetupCompleteErrorCode;
  readonly status: number | undefined;

  constructor(
    code: SetupCompleteErrorCode,
    message: string,
    status: number | undefined,
  ) {
    super(message);
    this.name = 'SetupCompleteError';
    this.code = code;
    this.status = status;
  }
}

// ── Error envelope ───────────────────────────────────────────────────────

/**
 * Project-standard error envelope from design §4. Kept loose because
 * `code` may be missing/unexpected on malformed bodies — the
 * classification helper handles all those edge cases.
 */
interface ErrorEnvelope {
  errors?: Array<{ code?: string; message?: string }>;
}

/**
 * Pure error-classification helper. Extracted from the hook so we can
 * unit-test the full status × envelope matrix without spinning up
 * React, fetch mocks, or a router. Logic mirrors the contract in
 * design §4.3:
 *
 *   - 400  → `VALIDATION_ERROR`
 *   - 404  → `ALREADY_INITIALIZED`
 *   - 409  → `SETUP_IN_PROGRESS`
 *   - 422  → use envelope `code`:
 *              `'PATH_PREDICTABLE'` → `PATH_PREDICTABLE`
 *              `'PATH_RESERVED'`    → `PATH_RESERVED`
 *              anything else        → `VALIDATION_ERROR` (still a
 *                                     client-side input error)
 *   - 500+ → `UNKNOWN`
 *   - any other / malformed body → `UNKNOWN`
 *
 * Returns both the normalized code and the best human-readable
 * message we can extract (envelope `message` first, then a default).
 */
export function classifySetupCompleteError(
  status: number,
  body: unknown,
): { code: SetupCompleteErrorCode; message: string } {
  const envelope = isErrorEnvelope(body) ? body : null;
  const firstError = envelope?.errors?.[0];
  const envelopeCode = firstError?.code;
  const envelopeMessage = firstError?.message;

  switch (status) {
    case 400:
      return {
        code: 'VALIDATION_ERROR',
        message: envelopeMessage ?? 'The setup request was rejected as invalid.',
      };
    case 404:
      return {
        code: 'ALREADY_INITIALIZED',
        message:
          envelopeMessage ??
          'This instance has already been set up.',
      };
    case 409:
      return {
        code: 'SETUP_IN_PROGRESS',
        message:
          envelopeMessage ??
          'Another setup attempt is already in progress.',
      };
    case 422: {
      if (envelopeCode === 'PATH_PREDICTABLE') {
        return {
          code: 'PATH_PREDICTABLE',
          message:
            envelopeMessage ??
            'The chosen admin path is too predictable.',
        };
      }
      if (envelopeCode === 'PATH_RESERVED') {
        return {
          code: 'PATH_RESERVED',
          message:
            envelopeMessage ??
            'The chosen admin path conflicts with a reserved prefix.',
        };
      }
      return {
        code: 'VALIDATION_ERROR',
        message:
          envelopeMessage ??
          'The setup request failed validation.',
      };
    }
    default:
      return {
        code: 'UNKNOWN',
        message:
          envelopeMessage ??
          `Setup failed with an unexpected response (HTTP ${status}).`,
      };
  }
}

/**
 * Narrow `unknown` to the project error envelope shape. Defensive
 * because the body may be malformed JSON or a string; the hook treats
 * those as `UNKNOWN`.
 */
function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { errors?: unknown };
  if (candidate.errors === undefined) return true;
  return Array.isArray(candidate.errors);
}

// ── Setup token helpers ──────────────────────────────────────────────────

/**
 * Read the cached setup token from `sessionStorage` or the URL
 * `?token=` query param. Mirrors `readSetupToken` in
 * `setup-state-gate.tsx` but does not persist anything — we only want
 * to know whether to include the token in the request body. Returns
 * `null` (omit field) when nothing is set.
 */
function readSetupTokenForRequest(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.sessionStorage.getItem(SETUP_TOKEN_STORAGE_KEY);
    if (stored && stored.trim().length > 0) return stored;
  } catch {
    // sessionStorage may be unavailable (private mode); fall through.
  }
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get('token');
    if (fromQuery && fromQuery.trim().length > 0) return fromQuery;
  } catch {
    // ignore
  }
  return null;
}

/**
 * Drop the cached setup token from `sessionStorage`. Called on a
 * successful `/setup/complete` so the token can never be reused.
 */
function clearSetupToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(SETUP_TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ── Mutation function ────────────────────────────────────────────────────

/**
 * Build the `/setup/complete` request body and POST it. Throws a
 * `SetupCompleteError` on any non-201 response or on a missing draft.
 *
 * Exported (alongside the hook) so the same logic can be exercised
 * from a future StrictMode-safe alternative or from tests; not part
 * of the documented public surface yet, hence the `__` prefix.
 */
async function completeSetup(
  payload: SetupCompletePayload,
): Promise<SetupCompleteResponse> {
  const account = getAccountDraft();
  const path = getPathDraft();

  if (account === null || path === null) {
    // Defensive: the wizard's deep-link guard (task 3.9) should
    // already have routed the operator back to the missing step
    // before they could trigger this mutation. Surfacing as an error
    // gives test/debug visibility if that guard ever fails.
    throw new SetupCompleteError(
      'VALIDATION_ERROR',
      'setup_incomplete',
      undefined,
    );
  }

  const token = readSetupTokenForRequest();

  const body: {
    account: {
      email: string;
      password: string;
      firstName: string;
      lastName: string;
    };
    adminPath: string;
    policy: LockoutPolicyFormValues;
    setupToken?: string;
  } = {
    account: {
      email: account.email,
      password: account.password,
      firstName: account.firstName,
      lastName: account.lastName,
    },
    adminPath: path.adminPath,
    policy: payload.policy,
  };

  if (token !== null) {
    body.setupToken = token;
  }

  let response: Response;
  try {
    response = await fetch('/api/v1/setup/complete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SetupCompleteError(
      'UNKNOWN',
      'Network error while completing setup.',
      undefined,
    );
  }

  if (response.status === 201) {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new SetupCompleteError(
        'UNKNOWN',
        'Setup succeeded but the response could not be parsed.',
        201,
      );
    }
    if (!isSetupCompleteResponse(parsed)) {
      throw new SetupCompleteError(
        'UNKNOWN',
        'Setup succeeded but the response shape was unexpected.',
        201,
      );
    }
    return parsed;
  }

  // Non-201 — try to parse the project standard error envelope.
  let errorBody: unknown = null;
  try {
    errorBody = await response.json();
  } catch {
    errorBody = null;
  }

  const { code, message } = classifySetupCompleteError(
    response.status,
    errorBody,
  );
  throw new SetupCompleteError(code, message, response.status);
}

/** Narrow `unknown` to a structurally valid `SetupCompleteResponse`. */
function isSetupCompleteResponse(value: unknown): value is SetupCompleteResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<SetupCompleteResponse>;
  if (typeof v.adminPath !== 'string') return false;
  if (!Array.isArray(v.backupCodes)) return false;
  if (!v.backupCodes.every((c) => typeof c === 'string')) return false;
  if (v.setupToken !== null) return false;
  if (typeof v.user !== 'object' || v.user === null) return false;
  const u = v.user as Partial<SetupCompleteResponse['user']>;
  return (
    typeof u.id === 'string' &&
    typeof u.email === 'string' &&
    typeof u.firstName === 'string' &&
    typeof u.lastName === 'string'
  );
}

// ── Hook ─────────────────────────────────────────────────────────────────

/**
 * React Query mutation that finalizes the wizard. See module-level
 * doc above for the full success/error lifecycle.
 *
 * Usage from the Security step (task 6.5 / 8.3) will look like:
 *
 *   const complete = useCompleteSetup();
 *   complete.mutate({ policy: form.getValues() });
 */
export function useCompleteSetup(): UseMutationResult<
  SetupCompleteResponse,
  SetupCompleteError,
  SetupCompletePayload
> {
  const navigate = useNavigate();

  return useMutation<
    SetupCompleteResponse,
    SetupCompleteError,
    SetupCompletePayload
  >({
    mutationKey: ['setup', 'complete'],
    mutationFn: completeSetup,
    retry: false,
    onSuccess: (data) => {
      // 1. Surface the chosen admin path on the Done step.
      const store = useSetupStore.getState();
      store.setAdminPath(data.adminPath);
      store.setCompleted(true);

      // 2. Drop in-memory plaintext drafts.
      clearAccountDraft();
      clearPathDraft();

      // 3. Remove the cached setup token (it's invalid server-side now too).
      clearSetupToken();

      // 4. Navigate to /setup/done. The route is wired in task 3.9; we
      //    cast to `never` here so the typecheck passes today against the
      //    not-yet-registered route table. TODO(task 3.9): drop the cast
      //    once `/setup/done` is registered with the typed router.
      navigate({ to: '/setup/done' as never });
    },
  });
}
