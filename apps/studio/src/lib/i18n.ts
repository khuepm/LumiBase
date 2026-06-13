import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getApiClient } from './api';
import { formatSafeError } from '@lumibase/shared/utils';

/**
 * Initializes i18next for the Studio UI.
 * Fetches the 'ui' namespace translations from the backend API.
 */
export async function initI18n() {
  if (i18n.isInitialized) return;

  const client = getApiClient();

  i18n
    .use(initReactI18next)
    .init({
      fallbackLng: 'en',
      lng: 'en', // Can be derived from local storage or settings later
      ns: ['ui'],
      defaultNS: 'ui',
      interpolation: {
        escapeValue: false, // React already escapes
      },
      resources: {}, // We will load dynamically or inject
    });

  try {
    // Fetch supported locales from settings, or default to just 'en' for now
    const uiTranslations = await client.translations.list({ namespace: 'ui' });
    
    // Group by language
    const byLang: Record<string, Record<string, string>> = {};
    for (const t of uiTranslations.data) {
      if (!byLang[t.language]) byLang[t.language] = {};
      byLang[t.language]![t.key] = t.value;
    }

    // Add to i18next instance
    for (const [lang, keys] of Object.entries(byLang)) {
      i18n.addResourceBundle(lang, 'ui', keys, true, true);
    }
  } catch (error) {
    console.error('[i18n] Failed to load UI translations', formatSafeError(error));
  }
}
