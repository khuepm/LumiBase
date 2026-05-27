import { useCallback } from 'react';
import { useLocale } from './useLocale';
import { t, type UiKey } from '../translations/ui';

/**
 * Convenience hook that wraps `t(key, locale, params?)` with the current locale
 * from `useLocale()`. Components don't need to pass locale explicitly each time.
 *
 * Requirements: 6.5
 */
export function useT() {
  const { locale } = useLocale();

  return useCallback(
    (key: UiKey, params?: Record<string, string>) => t(key, locale, params),
    [locale]
  );
}
