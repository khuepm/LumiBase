/**
 * Builds the inline gtag bootstrap for GA4.
 *
 * The component only mounts this after an explicit grant, so no GA request is
 * made before consent. The Consent Mode v2 calls are still emitted because they
 * are what pins the tag's behaviour once it is running: advertising storage
 * stays denied forever, only `analytics_storage` is granted.
 */

import { isValidMeasurementId } from './consent';

/** Signals the landing page never grants — it runs no ads and buys no audiences. */
export const DENIED_CONSENT_SIGNALS = [
  'ad_storage',
  'ad_user_data',
  'ad_personalization',
] as const;

export function buildGtagBootstrap(measurementId: string): string {
  if (!isValidMeasurementId(measurementId)) {
    // Unreachable through the component, which resolves the ID first. Throwing
    // beats emitting a script with an unvalidated value interpolated into it.
    throw new Error(`Refusing to build a gtag snippet for invalid measurement ID: ${measurementId}`);
  }

  const id = JSON.stringify(measurementId);
  const denied = DENIED_CONSENT_SIGNALS.map((signal) => `${signal}: 'denied'`).join(', ');

  return [
    'window.dataLayer = window.dataLayer || [];',
    'function gtag(){dataLayer.push(arguments);}',
    `gtag('consent', 'default', { ${denied}, analytics_storage: 'denied' });`,
    "gtag('consent', 'update', { analytics_storage: 'granted' });",
    "gtag('js', new Date());",
    // GA4 anonymises IPs unconditionally; what still needs saying is that this
    // property must not feed Google Signals or ad remarketing.
    `gtag('config', ${id}, { allow_google_signals: false, allow_ad_personalization_signals: false });`,
  ].join('\n');
}

/** The tag script URL for a measurement ID. */
export function gtagScriptUrl(measurementId: string): string {
  if (!isValidMeasurementId(measurementId)) {
    throw new Error(`Refusing to build a gtag URL for invalid measurement ID: ${measurementId}`);
  }

  return `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
}
