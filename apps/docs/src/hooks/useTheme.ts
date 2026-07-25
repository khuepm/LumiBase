import { useCallback, useEffect, useState } from 'react';
import { siteConfig } from '../lib/site-config';

const STORAGE_KEY = 'lumibase-docs:theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** User-selectable theme preference. `auto` follows the OS color scheme. */
export type ThemeMode = 'light' | 'dark' | 'auto';
/** The theme actually applied to the DOM once `auto` is resolved. */
export type ResolvedTheme = 'light' | 'dark';

/**
 * Whether the "auto" (follow-OS) mode is offered. Driven by
 * docs.config.json → themeConfig.colorMode.respectPrefersColorScheme.
 * When false, the toggle cycles light ↔ dark only.
 */
const AUTO_ENABLED =
  siteConfig.themeConfig?.colorMode?.respectPrefersColorScheme !== false;

/**
 * Fallback resolved theme used when the OS preference cannot be read (SSR,
 * no matchMedia). Comes from themeConfig.colorMode.defaultMode.
 */
const DEFAULT_RESOLVED: ResolvedTheme =
  siteConfig.themeConfig?.colorMode?.defaultMode === 'light' ? 'light' : 'dark';

function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return DEFAULT_RESOLVED === 'dark';
  }
  return window.matchMedia(DARK_QUERY).matches;
}

/** Read the stored preference, coercing unknown/absent values to `auto`. */
function readStoredMode(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'auto';
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
  } catch {
    // localStorage blocked (private mode) — fall through to default
  }
  return 'auto';
}

/** Resolve a preference to the concrete theme that should be on <html>. */
function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === 'auto') return prefersDark() ? 'dark' : 'light';
  return mode;
}

function applyResolved(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

/**
 * Theme hook: light / dark / auto with localStorage persistence and OS
 * `prefers-color-scheme` tracking. Applies the resolved theme to <html> by
 * toggling the `dark` class (Tailwind `darkMode: ['class']`).
 *
 * The no-flash bootstrap in index.html sets the initial class before paint;
 * this hook keeps it in sync after hydration and reacts to OS changes while
 * in `auto` mode.
 */
export function useTheme(): {
  /** The user's stored preference. */
  theme: ThemeMode;
  /** The concrete theme currently applied (`auto` resolved via OS). */
  resolvedTheme: ResolvedTheme;
  /** Whether `auto` mode is available (config-gated). */
  autoEnabled: boolean;
  /** Set the preference explicitly and persist it. */
  setTheme: (next: ThemeMode) => void;
  /** Advance to the next preference (light → dark → auto → light). */
  cycle: () => void;
} {
  // Seed state with the same deterministic defaults the server uses (`auto` /
  // DEFAULT_RESOLVED) rather than reading localStorage/matchMedia here. Doing
  // the environment-dependent read during the initial render makes the
  // client's first paint diverge from the prerendered HTML whenever the
  // visitor has a stored preference or an OS scheme different from
  // DEFAULT_RESOLVED, which throws a hydration mismatch (React error #418)
  // on every doc page. The real preference is applied client-side in the
  // effect below, after hydration has already committed.
  const [theme, setThemeState] = useState<ThemeMode>('auto');
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(DEFAULT_RESOLVED);

  // On mount, read the actual stored/OS preference and apply it — this runs
  // only on the client, after hydration, so it can safely diverge from the
  // server-rendered default.
  useEffect(() => {
    const mode = readStoredMode();
    const resolvedMode = mode === 'auto' && !AUTO_ENABLED ? resolve('auto') : mode;
    setThemeState(resolvedMode);
  }, []);

  // Apply + re-resolve whenever the preference changes.
  useEffect(() => {
    const resolved = resolve(theme);
    setResolvedTheme(resolved);
    applyResolved(resolved);
  }, [theme]);

  // While in auto, follow live OS changes.
  useEffect(() => {
    if (theme !== 'auto' || typeof window === 'undefined' || !window.matchMedia) {
      return;
    }
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      const resolved: ResolvedTheme = mql.matches ? 'dark' : 'light';
      setResolvedTheme(resolved);
      applyResolved(resolved);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Gracefully ignore storage errors (private browsing, quota exceeded)
    }
  }, []);

  const cycle = useCallback(() => {
    setThemeState((prev) => {
      const order: ThemeMode[] = AUTO_ENABLED
        ? ['light', 'dark', 'auto']
        : ['light', 'dark'];
      const idx = order.indexOf(prev);
      const next: ThemeMode = order[(idx + 1) % order.length] ?? 'light';
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return { theme, resolvedTheme, autoEnabled: AUTO_ENABLED, setTheme, cycle };
}
