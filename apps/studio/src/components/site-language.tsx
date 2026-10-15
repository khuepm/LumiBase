import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getApiClient, hasActiveToken } from '@/lib/api';
import { resolveUiLanguage } from '@/lib/ui-language';

/**
 * Switches the Studio's i18next language to the signed-in user's preference,
 * else the site's default language, else English (backlog B112). Renders
 * nothing. Mounted inside the admin layout, so it runs once a session exists.
 *
 * Both reads go through `getApiClient()` (API base + bearer from the token
 * store, shell contracts C1/C2) and reuse the query keys other Studio code
 * already shares (`['site-config']`, `['me-preferences']`). The language only
 * changes once both reads have settled, so a user whose preference differs
 * from the site default does not see the UI flip twice.
 */
export function SiteLanguageSync() {
  const { i18n } = useTranslation();
  const enabled = hasActiveToken();
  const siteQuery = useQuery({
    queryKey: ['site-config'],
    queryFn: async () => (await getApiClient().site.get()).data,
    enabled,
    staleTime: 60_000,
  });
  const prefsQuery = useQuery({
    queryKey: ['me-preferences'],
    queryFn: async () =>
      (await getApiClient().rawRequest<{ language?: string | null }>('/api/v1/me/preferences')).data,
    enabled,
  });

  const settled = !siteQuery.isPending && !prefsQuery.isPending;
  const siteDefault = (siteQuery.data as { defaultLanguage?: string } | undefined)?.defaultLanguage;
  const preference = (prefsQuery.data as { language?: string | null } | undefined)?.language;

  useEffect(() => {
    if (!enabled || !settled || !i18n?.changeLanguage) return;
    const lang = resolveUiLanguage({ preference, siteDefault });
    if (i18n.language !== lang) void i18n.changeLanguage(lang);
    // Screen readers pick the pronunciation from the document language.
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
  }, [enabled, settled, preference, siteDefault, i18n]);

  return null;
}

export default SiteLanguageSync;
