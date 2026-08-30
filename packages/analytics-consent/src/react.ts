'use client';

import { useSyncExternalStore } from 'react';

import { safeLocalStorage } from './browser';
import { CONSENT_CHANGE_EVENT, readConsent, type ConsentDecision } from './consent';

/**
 * `'unhydrated'` is what the server (and the first client render) sees.
 *
 * It has to be distinct from `null`: `null` means "asked, no answer yet" and
 * shows the banner, while `'unhydrated'` means "we have not read storage yet"
 * and must render nothing. Both consumers prerender to static HTML — one file for
 * every visitor — so anything decided before hydration would flash the banner at
 * people who already answered.
 */
export type ConsentSnapshot = ConsentDecision | null | 'unhydrated';

function subscribe(onChange: () => void): () => void {
  // Same-tab changes (banner, privacy page) arrive as a custom event; other tabs
  // arrive as `storage`.
  window.addEventListener(CONSENT_CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);

  return () => {
    window.removeEventListener(CONSENT_CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

function getSnapshot(): ConsentSnapshot {
  return readConsent(safeLocalStorage());
}

function getServerSnapshot(): ConsentSnapshot {
  return 'unhydrated';
}

/** Reads the visitor's analytics consent, re-rendering when it changes. */
export function useConsent(): ConsentSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export {
  CONSENT_CHANGE_EVENT,
  CONSENT_STORAGE_KEY,
  clearConsent,
  readConsent,
  resolveMeasurementId,
  shouldAskForConsent,
  shouldLoadAnalytics,
  writeConsent,
  type ConsentDecision,
} from './consent';
export { buildGtagBootstrap, gtagScriptUrl, loadGtag } from './gtag';
export { notifyConsentChanged, revokeAnalyticsStorage, safeLocalStorage } from './browser';
