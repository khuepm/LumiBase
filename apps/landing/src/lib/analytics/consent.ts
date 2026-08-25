/**
 * Consent state for the landing page's Google Analytics tag.
 *
 * Cloudflare Web Analytics (injected by Pages) is cookieless and needs no
 * consent, so everything here exists for GA4 alone: GA4 writes `_ga` cookies
 * and is a third-country processor, which puts it behind an opt-in.
 *
 * The module is deliberately free of React and of direct `window` access so it
 * can be unit-tested under `vitest` with `environment: 'node'` (see
 * `apps/landing/vitest.config.mts` — the landing suite only picks up `.ts`).
 */

/** Where the visitor's choice is persisted. Bump the suffix to re-ask. */
export const CONSENT_STORAGE_KEY = 'lumibase.consent.analytics.v1';

/** Event the privacy page fires to re-open the banner. */
export const CONSENT_CHANGE_EVENT = 'lumibase:consent-change';

export type ConsentDecision = 'granted' | 'denied';

/** The slice of `Storage` this module needs. */
export interface ConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isDecision(value: unknown): value is ConsentDecision {
  return value === 'granted' || value === 'denied';
}

/**
 * Reads the stored decision. Returns `null` when the visitor has not chosen
 * yet, when the stored value is unrecognised (older/forged key), or when
 * storage throws — Safari in Lockdown/private mode throws on access, and a
 * throwing browser must mean "no consent", never "consent".
 */
export function readConsent(storage: ConsentStorage | null | undefined): ConsentDecision | null {
  if (!storage) return null;

  try {
    const raw = storage.getItem(CONSENT_STORAGE_KEY);
    return isDecision(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Persists a decision. Failures are swallowed: consent still applies for this page view. */
export function writeConsent(
  storage: ConsentStorage | null | undefined,
  decision: ConsentDecision
): void {
  if (!storage) return;

  try {
    storage.setItem(CONSENT_STORAGE_KEY, decision);
  } catch {
    /* storage unavailable — the in-memory decision is authoritative for this page view */
  }
}

/** Forgets the decision so the banner asks again. */
export function clearConsent(storage: ConsentStorage | null | undefined): void {
  if (!storage) return;

  try {
    storage.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    /* nothing to do — see writeConsent */
  }
}

/**
 * A GA4 measurement ID looks like `G-XXXXXXX`. Validating it here is not
 * cosmetic: the ID is interpolated into an inline `<script>`, so anything that
 * is not this shape must never reach the page.
 */
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;

export function isValidMeasurementId(value: unknown): value is string {
  return typeof value === 'string' && MEASUREMENT_ID_PATTERN.test(value);
}

/**
 * Normalises `NEXT_PUBLIC_GA_ID` into a usable measurement ID, or `null` when
 * analytics is not configured. `null` is the default state: an unset variable
 * means no GA tag and no cookie banner at all.
 */
export function resolveMeasurementId(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim().toUpperCase();
  return isValidMeasurementId(trimmed) ? trimmed : null;
}

/** GA4 loads only with a configured ID *and* an explicit grant. */
export function shouldLoadAnalytics(
  measurementId: string | null,
  consent: ConsentDecision | null
): boolean {
  return measurementId !== null && consent === 'granted';
}

/** The banner appears only when there is something to consent to and no answer yet. */
export function shouldAskForConsent(
  measurementId: string | null,
  consent: ConsentDecision | null
): boolean {
  return measurementId !== null && consent === null;
}
