import { Moon, Sun, MonitorSmartphone } from 'lucide-react';
import { useTheme, type ThemeMode } from '../hooks/useTheme';
import { useT } from '../hooks/useT';
import type { UiKey } from '../translations/ui';

const ICON: Record<ThemeMode, typeof Sun> = {
  light: Sun,
  dark: Moon,
  auto: MonitorSmartphone,
};

const LABEL_KEY: Record<ThemeMode, UiKey> = {
  light: 'theme.light',
  dark: 'theme.dark',
  auto: 'theme.auto',
};

/**
 * Header control cycling the color theme (light → dark → auto). Persists the
 * choice via useTheme (localStorage) and follows the OS scheme while `auto`.
 * The `auto` step is hidden when config disables respectPrefersColorScheme.
 */
export function ThemeToggle() {
  const { theme, cycle } = useTheme();
  const t = useT();

  const Icon = ICON[theme];
  const modeLabel = t(LABEL_KEY[theme]);

  return (
    <button
      type="button"
      onClick={cycle}
      title={t('theme.toggle-tooltip', { mode: modeLabel })}
      aria-label={t('theme.toggle-tooltip', { mode: modeLabel })}
      className="glass-chip rounded-2xl p-2 text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-glass-strong"
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );
}
