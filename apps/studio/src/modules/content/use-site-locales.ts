import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '@/lib/api';

/**
 * Supported locales for the current site, plus whether the setting has been
 * read yet (intent links must not act on the `['en', 'vi']` placeholder).
 *
 * Reads the `locales` setting (`value.supported: string[]`) — the same source
 * the `translatable-text` interface and the Translations module already use.
 * Falls back to `['en', 'vi']` when the key hasn't been configured yet.
 */
export function useSiteLocalesState(): { locales: string[]; isLoaded: boolean } {
  const client = getApiClient();
  const query = useQuery({
    queryKey: ['settings', 'locales'],
    queryFn: async () => {
      try {
        const res = await client.settings.get('locales');
        return res.data;
      } catch {
        return null; // Setting may not exist yet.
      }
    },
  });
  return {
    locales: (query.data?.value?.supported as string[] | undefined) ?? ['en', 'vi'],
    isLoaded: !query.isPending,
  };
}

/** Supported locales for the current site (see {@link useSiteLocalesState}). */
export function useSiteLocales(): string[] {
  return useSiteLocalesState().locales;
}
