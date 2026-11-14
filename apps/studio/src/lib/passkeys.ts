/**
 * Passkey (WebAuthn) helpers for the Studio (#735).
 *
 * Shell contract C5: the desktop/mobile shell runs WKWebView / WebView2 /
 * WebKitGTK, where WebAuthn is either missing or bound to an origin
 * (`tauri://localhost`) the server cannot accept as an RP. Passkey UI is
 * therefore hidden inside the shell and in any browser without
 * `PublicKeyCredential`; password + TOTP keep working there.
 */

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { isDesktopShell } from './shell';

export function passkeysSupported(): boolean {
  if (isDesktopShell()) return false;
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** Run the browser's sign-in prompt. */
export function promptPasskey(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON> {
  return startAuthentication({ optionsJSON: options });
}

/** Run the browser's "create a passkey" prompt. */
export function createPasskey(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON: options });
}

/** Cancel an in-flight prompt (e.g. when the user navigates back). */
export function cancelPasskeyPrompt(): void {
  WebAuthnAbortService.cancelCeremony();
}

/**
 * A readable message for a failed or cancelled prompt. The browser reports a
 * user cancel as `NotAllowedError`, which is not an error worth alarming about.
 */
export function passkeyErrorMessage(err: unknown, fallback: string): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return 'Passkey request was cancelled or timed out.';
  if (name === 'InvalidStateError') return 'This passkey is already registered on this account.';
  return err instanceof Error && err.message ? err.message : fallback;
}

export interface PasskeyCeremony<T> {
  ceremonyId: string;
  options: T;
}
