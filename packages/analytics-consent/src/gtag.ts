/**
 * The GA4 tag itself: the inline bootstrap for apps that render script tags
 * declaratively (Next.js `<Script>`), and `loadGtag()` for apps that have to
 * inject it imperatively (a Vite SPA).
 *
 * Callers load this only after an explicit grant, so no GA request is made before
 * consent. The Consent Mode v2 calls are still emitted because they are what pins
 * the tag's behaviour once it is running: advertising storage stays denied
 * forever, only `analytics_storage` is granted.
 */

import { isValidMeasurementId } from './consent';

/** Signals the public sites never grant — they run no ads and buy no audiences. */
export const DENIED_CONSENT_SIGNALS = [
  'ad_storage',
  'ad_user_data',
  'ad_personalization',
] as const;

/** Config passed to `gtag('config', …)`, kept identical across both load paths. */
const CONFIG_PARAMS = {
  allow_google_signals: false,
  allow_ad_personalization_signals: false,
} as const;

function assertMeasurementId(measurementId: string): void {
  if (!isValidMeasurementId(measurementId)) {
    // Unreachable through the components, which resolve the ID first. Throwing
    // beats emitting a script with an unvalidated value interpolated into it.
    throw new Error(`Refusing to load analytics for invalid measurement ID: ${measurementId}`);
  }
}

export function buildGtagBootstrap(measurementId: string): string {
  assertMeasurementId(measurementId);

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
    `gtag('config', ${id}, ${JSON.stringify(CONFIG_PARAMS)});`,
  ].join('\n');
}

/** The tag script URL for a measurement ID. */
export function gtagScriptUrl(measurementId: string): string {
  assertMeasurementId(measurementId);

  return `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
}

export interface LoadGtagOptions {
  /** Document to inject into. Defaults to the ambient one; omitted under SSR. */
  doc?: Document;
  /** `id` of the injected `<script>`, which also makes repeat calls idempotent. */
  scriptId?: string;
}

const DEFAULT_SCRIPT_ID = 'lumibase-ga-tag';

type DataLayerWindow = Window & { dataLayer?: unknown[] };

/**
 * Injects the GA4 tag and applies Consent Mode, for apps without a declarative
 * `<Script>` primitive.
 *
 * Idempotent: a second call with the same `scriptId` does nothing, so a
 * re-rendering SPA cannot stack duplicate tags. Returns `true` when it injected
 * the tag, `false` when there was nothing to do (no document, already loaded).
 */
export function loadGtag(measurementId: string, options: LoadGtagOptions = {}): boolean {
  assertMeasurementId(measurementId);

  const doc = options.doc ?? (typeof document === 'undefined' ? undefined : document);
  const win = doc?.defaultView as DataLayerWindow | null | undefined;
  if (!doc || !win) return false; // server-side render — nothing to inject into

  const scriptId = options.scriptId ?? DEFAULT_SCRIPT_ID;
  if (doc.getElementById(scriptId)) return false;

  const dataLayer = win.dataLayer ?? [];
  win.dataLayer = dataLayer;

  // Pushes `arguments`, not a rest array: gtag.js reads the pushed value as an
  // Arguments object, and this is the shape Google's own snippet pushes. The rest
  // parameter exists only to type the call sites.
  function gtag(..._args: unknown[]): void {
    // eslint-disable-next-line prefer-rest-params
    dataLayer.push(arguments);
  }

  const denied = Object.fromEntries(DENIED_CONSENT_SIGNALS.map((signal) => [signal, 'denied']));
  gtag('consent', 'default', { ...denied, analytics_storage: 'denied' });
  gtag('consent', 'update', { analytics_storage: 'granted' });
  gtag('js', new Date());
  gtag('config', measurementId, { ...CONFIG_PARAMS });

  const script = doc.createElement('script');
  script.id = scriptId;
  script.async = true;
  script.src = gtagScriptUrl(measurementId);
  doc.head.appendChild(script);

  return true;
}
