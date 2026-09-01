import { useCallback, useEffect } from 'react';
import {
  loadGtag,
  notifyConsentChanged,
  revokeAnalyticsStorage,
  safeLocalStorage,
  shouldAskForConsent,
  shouldLoadAnalytics,
  useConsent,
  writeConsent,
  type ConsentDecision,
} from '@lumibase/analytics-consent/react';
import { useT } from '../../hooks/useT';

/**
 * Loads GA4 behind an opt-in, and renders the banner that asks for it.
 *
 * Two invariants, the same ones the landing app holds:
 *
 * 1. **No GA request before a grant.** `loadGtag()` runs only once consent is
 *    `granted`; the tag is never fetched otherwise. This is stricter than Consent
 *    Mode alone, which loads the tag and merely withholds storage.
 * 2. **Nothing renders before hydration.** `useConsent()` reports `'unhydrated'`
 *    during the SSR prerender, so the static HTML never carries a banner that
 *    would flash at visitors who already answered.
 *
 * Cloudflare Web Analytics keeps counting page views either way — it is cookieless
 * and needs no consent.
 */
export function AnalyticsConsent({ measurementId }: { measurementId: string }) {
  const t = useT();
  const consent = useConsent();
  // Before hydration we have not read storage, which is not the same as "declined";
  // treat it as undecided for gating and render nothing until it resolves.
  const decided = consent === 'unhydrated' ? null : consent;
  const shouldLoad = shouldLoadAnalytics(measurementId, decided);

  useEffect(() => {
    if (!shouldLoad) return;
    // Idempotent: a re-render (locale switch, route change) cannot stack tags.
    loadGtag(measurementId);
  }, [shouldLoad, measurementId]);

  const decide = useCallback((decision: ConsentDecision) => {
    writeConsent(safeLocalStorage(), decision);

    if (decision === 'denied') {
      // Covers "granted earlier in this session, denied now": the tag is already
      // running, so tell it to stop storing and clear what it wrote.
      revokeAnalyticsStorage();
    }

    notifyConsentChanged();
  }, []);

  if (consent === 'unhydrated') return null;
  if (!shouldAskForConsent(measurementId, decided)) return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="consent-banner-title"
      className="fixed inset-x-0 bottom-0 z-50 px-4 pb-4"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4 rounded-xl border border-border bg-background/95 px-5 py-4 shadow-lg backdrop-blur-[12px] sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p id="consent-banner-title" className="mb-1 text-[13px] font-semibold text-foreground">
            {t('consent.title')}
          </p>
          <p className="text-[13px] leading-5 text-muted-foreground">
            {t('consent.body')}{' '}
            <a
              href="https://lumibase.dev/privacy/"
              target="_blank"
              rel="noreferrer"
              className="underline transition-colors hover:text-foreground"
            >
              {t('consent.privacy-link')}
            </a>
          </p>
        </div>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => decide('denied')}
            className="rounded-md border border-border px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('consent.decline')}
          </button>
          <button
            type="button"
            onClick={() => decide('granted')}
            className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            {t('consent.allow')}
          </button>
        </div>
      </div>
    </div>
  );
}
