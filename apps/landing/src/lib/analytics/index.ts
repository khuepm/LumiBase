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
export { DENIED_CONSENT_SIGNALS, buildGtagBootstrap, gtagScriptUrl } from './gtag';
export { notifyConsentChanged, revokeAnalyticsStorage, safeLocalStorage } from './browser';
export { useConsent, type ConsentSnapshot } from './use-consent';
