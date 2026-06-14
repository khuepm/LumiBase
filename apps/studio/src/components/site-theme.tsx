import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getApiClient, hasActiveToken } from '@/lib/api';

/**
 * Applies the active site's theme to Studio at runtime:
 *  - injects whitelisted CSS-variable overrides into `:root` (light) and
 *    `.dark` from `themeOverrides`, plus `--primary` from the brand color,
 *  - appends the site's raw `customCss` after the token block,
 *  - sets the `dark` class from the resolved appearance.
 *
 * Resolution order for appearance: per-user preference (localStorage) →
 * site default → `auto` (system). Branding/overrides/custom CSS are global to
 * the site. Renders nothing — it only manages a `<style>` element + the
 * root `dark` class.
 */

const STYLE_ID = 'lumibase-site-theme';
const USER_APPEARANCE_KEY = 'lumibase.appearance';

/** Subset mirroring SiteResource fields this component reads. */
interface SiteThemeData {
  defaultAppearance?: string;
  branding?: { brandColor?: string };
  themeOverrides?: { light?: Record<string, string>; dark?: Record<string, string> };
  customCss?: string | null;
}

const VALID_TOKEN = /^--[a-z-]+$/;
const HSL_TRIPLE = /^\d{1,3}(\.\d+)?\s+\d{1,3}(\.\d+)?%\s+\d{1,3}(\.\d+)?%$/;
const CSS_LENGTH = /^(0|\d{1,3}(\.\d+)?(px|rem|em))$/;

/** Render one `selector { --token: value; … }` rule from an override map. */
function ruleBlock(selector: string, vars: Record<string, string>): string {
  const decls = Object.entries(vars)
    .filter(([token, value]) => {
      if (!VALID_TOKEN.test(token)) return false;
      return token === '--radius' ? CSS_LENGTH.test(value) : HSL_TRIPLE.test(value);
    })
    .map(([token, value]) => `  ${token}: ${value};`)
    .join('\n');
  return decls ? `${selector} {\n${decls}\n}` : '';
}

function buildCss(site: SiteThemeData): string {
  const overrides = site.themeOverrides ?? {};
  const light = { ...(overrides.light ?? {}) };
  // Brand color maps onto the primary action token for both modes unless an
  // explicit override already set it.
  const brand = site.branding?.brandColor;
  if (brand && HSL_TRIPLE.test(brand) && !light['--primary']) {
    light['--primary'] = brand;
  }
  const blocks = [
    ruleBlock(':root', light),
    ruleBlock('.dark', overrides.dark ?? {}),
  ].filter(Boolean);

  // Raw custom CSS last so it can win. Defense-in-depth: strip any closing
  // </style> the server validation might have missed.
  const custom = (site.customCss ?? '').replace(/<\/\s*style\s*>/gi, '');
  if (custom.trim()) blocks.push(custom);

  return blocks.join('\n\n');
}

function resolveAppearance(siteDefault: string | undefined): 'light' | 'dark' {
  const user = typeof localStorage !== 'undefined' ? localStorage.getItem(USER_APPEARANCE_KEY) : null;
  const choice = user || siteDefault || 'auto';
  if (choice === 'light') return 'light';
  if (choice === 'dark') return 'dark';
  // auto → follow system
  const prefersDark =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

export function SiteThemeStyle() {
  const siteQuery = useQuery({
    queryKey: ['site-config'],
    queryFn: async () => (await getApiClient().site.get()).data,
    enabled: hasActiveToken(),
    staleTime: 60_000,
  });

  const site = siteQuery.data as SiteThemeData | undefined;

  useEffect(() => {
    if (!site) return;
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = buildCss(site);

    const appearance = resolveAppearance(site.defaultAppearance);
    document.documentElement.classList.toggle('dark', appearance === 'dark');
  }, [site]);

  return null;
}

export default SiteThemeStyle;
