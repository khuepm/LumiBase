import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { directionOf } from '@/lib/text-direction';
import { supportedUiLanguage, UI_LANGUAGES, type UiLanguage } from '@/lib/ui-language';

/** Endonyms, so a user can find their language whatever the UI is showing. */
export const UI_LANGUAGE_LABELS: Record<UiLanguage, string> = {
  en: 'English',
  vi: 'Tiếng Việt',
  ar: 'العربية',
  he: 'עברית',
  fa: 'فارسی',
};

/**
 * Per-user interface language (#761). Writes `preferences.language` through
 * `PATCH /api/v1/me/preferences`; `SiteLanguageSync` then switches i18next and
 * sets `<html lang dir>`, so choosing Arabic, Hebrew or Farsi mirrors the
 * Studio. Uses `getApiClient()` like every other Studio call (shell C1/C2).
 */
export function UiLanguagePicker() {
  const { i18n } = useTranslation();
  const queryClient = useQueryClient();
  const current = supportedUiLanguage(i18n?.language) ?? 'en';

  const save = useMutation({
    mutationFn: (language: UiLanguage) => getApiClient().me.updatePreferences({ language }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me-preferences'] });
      void queryClient.invalidateQueries({ queryKey: ['me', 'preferences'] });
    },
  });

  return (
    <label className="relative hidden h-9 items-center sm:inline-flex">
      <Languages className="pointer-events-none absolute start-2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <select
        aria-label="Interface language"
        value={current}
        disabled={save.isPending}
        onChange={(e) => {
          const next = supportedUiLanguage(e.target.value);
          if (next) save.mutate(next);
        }}
        className="h-9 appearance-none rounded-md border border-border bg-background ps-8 pe-2 text-sm text-muted-foreground shadow-sm transition hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        {UI_LANGUAGES.map((lang) => (
          <option key={lang} value={lang} lang={lang} dir={directionOf(lang)}>
            {UI_LANGUAGE_LABELS[lang]}
          </option>
        ))}
      </select>
    </label>
  );
}

export default UiLanguagePicker;
