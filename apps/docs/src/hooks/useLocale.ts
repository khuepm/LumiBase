import { useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { locales, defaultLocale } from 'virtual:docs-registry';
import { pathFor, parseUrl } from '../lib/url';
import { LOCALE_STORAGE_KEY } from '../lib/locale-storage';

/**
 * Hook providing the current locale derived from the URL, along with
 * helpers to switch locale. Reads `:locale` from route params and
 * validates against the known locale list.
 *
 * - If the URL param is missing or not in `locales`, falls back to `defaultLocale`.
 * - `setLocale(next, slug?)` navigates to the new locale path and persists
 *   the choice in localStorage for future visits to `/`.
 *
 * Requirements: 3.3, 3.4, 3.6
 */
export function useLocale(): {
  locale: string;
  defaultLocale: string;
  locales: string[];
  setLocale: (next: string, slug?: string) => void;
} {
  const params = useParams<{ locale: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  // Derive current locale from URL param, fallback to defaultLocale
  const locale =
    params.locale && locales.includes(params.locale)
      ? params.locale
      : defaultLocale;

  // Extract current slug from the pathname
  const parsed = parseUrl(location.pathname);
  const currentSlug = parsed?.slug ?? undefined;

  const setLocale = useCallback(
    (next: string, slug?: string) => {
      const targetSlug = slug ?? currentSlug ?? 'README';
      navigate(pathFor(next, targetSlug));

      // Persist preference for next visit to `/`
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, next);
      } catch {
        // Gracefully ignore storage errors (private browsing, quota exceeded)
      }
    },
    [navigate, currentSlug]
  );

  return {
    locale,
    defaultLocale,
    locales,
    setLocale,
  };
}
