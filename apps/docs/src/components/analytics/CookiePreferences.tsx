import {
  clearConsent,
  notifyConsentChanged,
  revokeAnalyticsStorage,
  safeLocalStorage,
  useConsent,
} from '@lumibase/analytics-consent/react';
import { useT } from '../../hooks/useT';

/**
 * Footer control that shows the visitor's analytics choice and lets them undo it.
 *
 * Consent is per-origin, so the landing page's control cannot reach this site's
 * storage — `docs.lumibase.dev` needs its own. Clearing re-opens the banner rather
 * than silently flipping to declined, so the visitor makes the call.
 */
export function CookiePreferences() {
  const t = useT();
  const consent = useConsent();

  if (consent === 'unhydrated') return null;

  const reset = () => {
    clearConsent(safeLocalStorage());
    revokeAnalyticsStorage();
    notifyConsentChanged();
  };

  const status =
    consent === 'granted'
      ? t('consent.status-granted')
      : consent === 'denied'
        ? t('consent.status-denied')
        : t('consent.status-unset');

  return (
    <div className="mt-5 flex flex-wrap items-center justify-center gap-3 border-t border-border pt-5">
      <span className="text-[13px] font-medium text-muted-foreground">{status}</span>
      <button
        type="button"
        onClick={reset}
        className="rounded-md border border-border px-3 py-1 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {consent ? t('consent.change') : t('consent.review')}
      </button>
    </div>
  );
}
