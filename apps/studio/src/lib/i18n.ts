import i18n, { type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { LumiError } from '@lumibase/sdk';
import { getApiClient } from './api';
import { isSetupPath } from './admin-base';
import { formatSafeError } from '@lumibase/contracts/utils';
import { CONTENT_NS, registerContentBundles } from '@/modules/content/draft-review-i18n';
import { applyDocumentLanguage } from './text-direction';
import { readStoredUiLanguage } from './ui-language';

/**
 * Initializes i18next for the Studio UI.
 * Fetches the 'ui' namespace translations from the backend API, and registers
 * the bundled `content` namespace (`locales/{en,vi}/content.json`).
 *
 * The fetch is optional: the UI renders from the bundled locales and the
 * components' default strings without it. It is skipped on the setup wizard,
 * which runs before any site or session exists (#1044), and a 4xx answer
 * (anonymous 401, unknown site 404) is expected, so it only warns.
 */
export async function initI18n() {
  if (i18n.isInitialized) return;

  // The last language this browser resolved (see `SiteLanguageSync`), so the
  // login page and the first paint after a reload use the right direction.
  const initialLanguage = readStoredUiLanguage() ?? 'en';

  // `<html lang dir>` follows every language switch, from any caller (#761).
  i18n.on('languageChanged', (lng) => {
    applyDocumentLanguage(lng);
  });

  i18n
    .use(initReactI18next)
    .init({
      fallbackLng: 'en',
      // Before sign-in. Once a session exists, `SiteLanguageSync` (mounted in
      // the admin layout) switches to the user's or the site's language.
      lng: initialLanguage,
      ns: ['ui', CONTENT_NS],
      defaultNS: 'ui',
      interpolation: {
        escapeValue: false, // React already escapes
      },
      resources: {}, // We will load dynamically or inject
    });
  registerContentBundles(i18n);
  applyDocumentLanguage(initialLanguage);

  await loadUiTranslations(i18n);
}

/**
 * Adds the CMS's `ui` namespace to `instance`. Never throws: without it the
 * Studio keeps the bundled locales. Exported for tests.
 */
export async function loadUiTranslations(instance: I18n): Promise<void> {
  if (typeof window !== 'undefined' && isSetupPath(window.location.pathname)) return;

  try {
    const uiTranslations = await getApiClient().translations.list({ namespace: 'ui' });

    // Group by language
    const byLang: Record<string, Record<string, string>> = {};
    for (const t of uiTranslations.data) {
      if (!byLang[t.language]) byLang[t.language] = {};
      byLang[t.language]![t.key] = t.value;
    }

    for (const [lang, keys] of Object.entries(byLang)) {
      instance.addResourceBundle(lang, 'ui', keys, true, true);
    }
  } catch (error) {
    // A client error is an expected state (signed out, stale site), not a fault.
    const expected = error instanceof LumiError && error.status >= 400 && error.status < 500;
    (expected ? console.warn : console.error)(
      '[i18n] UI translations unavailable, using bundled locales',
      formatSafeError(error),
    );
  }
}
