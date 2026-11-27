import { useEffect } from 'react';
import { LogIn } from 'lucide-react';
import {
  holdTfaRedirect,
  setActiveRefreshToken,
  setActiveToken,
  signInAgainWithTfa,
  tfaRequiredReason,
  type TfaRequiredReason,
} from '@/lib/api';

/**
 * Session plumbing shared by the TOTP and passkey sections of Settings →
 * Security (#1048).
 */

/** A `403 TFA_REQUIRED` answer, kept apart from a generic load failure. */
export class TfaRequiredError extends Error {
  constructor(readonly reason: TfaRequiredReason) {
    super(
      reason === 'verification_required'
        ? 'This session has not been verified with two-factor authentication.'
        : 'Two-factor authentication enrollment is required for this account.',
    );
    this.name = 'TfaRequiredError';
  }
}

/** Throw a {@link TfaRequiredError} when `res` is a `403 TFA_REQUIRED`. */
export async function throwIfTfaRequired(res: Response): Promise<void> {
  if (res.status !== 403) return;
  const body: unknown = await res.clone().json().catch(() => null);
  const reason = tfaRequiredReason(body);
  if (reason) throw new TfaRequiredError(reason);
}

export function isTfaVerificationRequired(err: unknown): boolean {
  return err instanceof TfaRequiredError && err.reason === 'verification_required';
}

/** The TFA-verified pair returned by enrolling a first factor. */
export interface UpgradedSession {
  token: string;
  refreshToken: string;
  refreshTokenExpiresAt?: string;
}

/**
 * Adopt the session the server upgraded after a first-factor enrolment.
 * Goes through the same token store as login (keychain in the desktop shell,
 * localStorage in the browser), so nothing about where tokens live changes.
 * Returns whether a session was adopted.
 */
export function adoptUpgradedSession(session: UpgradedSession | null | undefined): boolean {
  if (!session?.token || !session.refreshToken) return false;
  setActiveToken(session.token);
  setActiveRefreshToken(session.refreshToken);
  return true;
}

/**
 * Keep the automatic `TFA_REQUIRED` redirect away while `active` — the
 * one-time recovery codes must never be navigated off screen.
 */
export function useHoldTfaRedirect(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    return holdTfaRedirect();
  }, [active]);
}

/**
 * Shown instead of a generic error when this session has to be replaced by
 * one signed in with the second factor.
 */
export function TfaReverifyNotice({ blocked = false }: { blocked?: boolean }) {
  return (
    <div role="alert" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      <p>
        Your account now requires two-factor authentication, but this session was signed in without it. Sign in again
        with your second factor to continue.
      </p>
      {blocked ? (
        <p className="text-xs">Save your recovery codes first: they are shown only once.</p>
      ) : null}
      <button
        type="button"
        disabled={blocked}
        onClick={() => void signInAgainWithTfa()}
        className="inline-flex items-center gap-2 rounded-md border border-amber-400 px-3 py-1.5 text-sm font-medium disabled:opacity-60 dark:border-amber-600"
      >
        <LogIn className="h-4 w-4" aria-hidden="true" />
        Sign in again with 2FA
      </button>
    </div>
  );
}
