import type { AccountFormValues } from './schemas/account';
import type { AdminPathFormValues } from './schemas/admin-path';
import type { LockoutPolicyFormValues } from './schemas/policy';
import type { ProjectConfigurationFormValues } from './schemas/project';

/**
 * In-memory Setup Wizard drafts (#757 — split out of the step components).
 *
 * Rationale for module memory: the wizard's persisted Zustand store
 * deliberately omits secret fields (see `setup-store.ts`) so a refresh never
 * lands the plaintext password in `sessionStorage`. React Hook Form local
 * state goes away as soon as a step unmounts. A module-scoped variable held
 * only in JS heap fits: it lives for the tab's lifetime, never touches
 * storage, and resets on a hard refresh.
 *
 * Why a separate module: `useCompleteSetup` (imported by the router on the
 * boot path) needs the getters/clearers. When they lived inside the step
 * components, that static import dragged every step — and with them Zod and
 * React Hook Form — into the initial Studio bundle, defeating the steps'
 * `React.lazy` boundaries. This file must stay free of runtime imports
 * (type-only imports above) so it costs a few hundred bytes on boot.
 *
 * The step modules re-export these functions, so existing imports from
 * `steps/step-*` keep working.
 */

// ── Account ────────────────────────────────────────────────────────────

let accountDraft: AccountFormValues | null = null;

/**
 * Read the current in-memory account draft. `null` until the Account step
 * submits in this tab, or after `clearAccountDraft()`. NEVER persists.
 */
export function getAccountDraft(): AccountFormValues | null {
  return accountDraft;
}

/**
 * Drop the in-memory draft. Call immediately after the values have been
 * posted to `POST /api/v1/setup/complete` so the plaintext password doesn't
 * outlive its single legitimate use.
 */
export function clearAccountDraft(): void {
  accountDraft = null;
}

/** Write the in-memory account draft (step submit or same-tab handoff). */
export function setAccountDraft(value: AccountFormValues): void {
  accountDraft = value;
}

// ── Admin path ─────────────────────────────────────────────────────────

let pathDraft: AdminPathFormValues | null = null;

/** Read the in-memory admin-path draft, or `null` if not yet captured. */
export function getPathDraft(): AdminPathFormValues | null {
  return pathDraft;
}

/** Drop the draft. Call after `POST /setup/complete` succeeds. */
export function clearPathDraft(): void {
  pathDraft = null;
}

export function setPathDraft(value: AdminPathFormValues): void {
  pathDraft = value;
}

// ── Lockout policy ─────────────────────────────────────────────────────
//
// Holds the FULL `LockoutPolicyFormValues` shape (visible fields + defaults
// from the chosen preset) so the recovery step can submit a complete policy.

let policyDraft: LockoutPolicyFormValues | null = null;

/** Read the in-memory policy draft, or `null` if not yet captured. */
export function getPolicyDraft(): LockoutPolicyFormValues | null {
  return policyDraft;
}

/** Drop the draft. Call after `POST /setup/complete` succeeds. */
export function clearPolicyDraft(): void {
  policyDraft = null;
}

export function setPolicyDraft(value: LockoutPolicyFormValues): void {
  policyDraft = value;
}

// ── Email identity mode (#794) ─────────────────────────────────────────
//
// Instance-wide account-key policy sent as `emailIdentityMode` in the
// `POST /setup/complete` body. `exact` is the default and the pre-#794
// behaviour.

export const EMAIL_IDENTITY_MODES = ['exact', 'root'] as const;
export type EmailIdentityMode = (typeof EMAIL_IDENTITY_MODES)[number];
export const DEFAULT_EMAIL_IDENTITY_MODE: EmailIdentityMode = 'exact';

let emailIdentityModeDraft: EmailIdentityMode = DEFAULT_EMAIL_IDENTITY_MODE;

/** The chosen instance email identity mode (`exact` until the operator picks). */
export function getEmailIdentityModeDraft(): EmailIdentityMode {
  return emailIdentityModeDraft;
}

export function setEmailIdentityModeDraft(value: EmailIdentityMode): void {
  emailIdentityModeDraft = value;
}

/** Reset to the default. Call after `POST /setup/complete` succeeds. */
export function clearEmailIdentityModeDraft(): void {
  emailIdentityModeDraft = DEFAULT_EMAIL_IDENTITY_MODE;
}

// ── Project ────────────────────────────────────────────────────────────

let projectDraft: ProjectConfigurationFormValues | null = null;

export function getProjectDraft(): ProjectConfigurationFormValues | null {
  return projectDraft;
}

export function clearProjectDraft(): void {
  projectDraft = null;
}

export function setProjectDraft(value: ProjectConfigurationFormValues): void {
  projectDraft = value;
}
