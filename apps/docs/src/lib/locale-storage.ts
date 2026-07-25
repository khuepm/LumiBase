import { locales, defaultLocale } from 'virtual:docs-registry';

/**
 * Shared localStorage key for the user's locale preference.
 * Kept in one place so useLocale (writer) and the redirect routes
 * (readers) never drift out of sync.
 */
export const LOCALE_STORAGE_KEY = 'lumibase-docs:locale';

/**
 * Reads the user's previously chosen locale from localStorage, falling
 * back to `defaultLocale` when unset, invalid, or unavailable (SSR,
 * private browsing, quota errors).
 */
export function getPreferredLocale(): string {
  if (typeof window === 'undefined') return defaultLocale;
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && locales.includes(stored)) return stored;
  } catch {
    // Gracefully ignore storage errors (private browsing, quota exceeded)
  }
  return defaultLocale;
}
