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
      className="glass-chip glass-chip-hover rounded-2xl px-2.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.5)] [&>option]:bg-popover [&>option]:text-popover-foreground"
    >
      {locales.map((loc) => (
        <option key={loc} value={loc}>
          {localeNames[loc] ?? loc}
        </option>
      ))}
    </select>
  );
}
