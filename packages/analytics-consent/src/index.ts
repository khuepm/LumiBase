/**
 * Consent-gated Google Analytics for the public LumiBase sites.
 *
 * This entry is framework-free so it can be unit-tested under
 * `environment: 'node'` and consumed by both a Next.js app (`apps/landing`) and a
 * Vite SPA (`apps/docs`). The React hook lives behind
 * `@lumibase/analytics-consent/react` so importing the core never pulls React in.
 */

export {
  CONSENT_CHANGE_EVENT,
  CONSENT_STORAGE_KEY,
  clearConsent,
  isValidMeasurementId,
  readConsent,
  resolveMeasurementId,
  shouldAskForConsent,
  shouldLoadAnalytics,
  writeConsent,
  type ConsentDecision,
  type ConsentStorage,
} from './consent';
export {
  DENIED_CONSENT_SIGNALS,
  buildGtagBootstrap,
  gtagScriptUrl,
  loadGtag,
  type LoadGtagOptions,
} from './gtag';
export { notifyConsentChanged, revokeAnalyticsStorage, safeLocalStorage } from './browser';
