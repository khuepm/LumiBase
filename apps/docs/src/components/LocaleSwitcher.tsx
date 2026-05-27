import { localeNames } from 'virtual:docs-registry';
import { useLocale } from '../hooks/useLocale';
import { useCurrentSlug } from '../hooks/useCurrentSlug';

/**
 * Dropdown locale switcher rendered in the header.
 * Lists all available locales with display names from config.
 * Switching locale navigates to the same slug under the new locale prefix.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
 */
export function LocaleSwitcher() {
  const { locale, locales, setLocale } = useLocale();
  const slug = useCurrentSlug();

  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value, slug || undefined)}
      aria-label="Switch language"
      className="rounded-md border border-border bg-background px-2 py-1 text-sm text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
    >
      {locales.map((loc) => (
        <option key={loc} value={loc}>
          {localeNames[loc] ?? loc}
        </option>
      ))}
    </select>
  );
}
