/**
 * Loads docs site configuration from docs.config.json (Docusaurus-style).
 *
 * Vite imports JSON natively as a module, so the config is statically
 * inlined into the bundle at build time. This keeps the docs viewer fast
 * and dependency-free while exposing a familiar surface for editors.
 */

import rawConfig from '../../docs.config.json';

export interface NavbarItem {
  /** Label can be a plain string or a locale-keyed object for i18n. */
  label: string | Record<string, string>;
  /** Internal path (e.g. "/docs/README"). */
  to?: string;
  /** External URL. */
  href?: string;
  position?: 'left' | 'right';
}

export interface FooterLinkItem {
  /** Label can be a plain string or a locale-keyed object for i18n. */
  label: string | Record<string, string>;
  to?: string;
  href?: string;
}

export interface FooterColumn {
  /** Title can be a plain string or a locale-keyed object for i18n. */
  title: string | Record<string, string>;
  items: FooterLinkItem[];
}

export interface I18nConfig {
  /** The default locale used as fallback. Must be included in `locales`. */
  defaultLocale: string;
  /** List of supported locale codes. */
  locales: string[];
  /** Human-readable display names for each locale. */
  localeNames: Record<string, string>;
}

export interface ThemeConfig {
  colorMode?: {
    defaultMode?: 'light' | 'dark';
    respectPrefersColorScheme?: boolean;
  };
  prism?: {
    theme?: string;
    darkTheme?: string;
  };
}

export interface SiteConfig {
  title: string;
  tagline: string;
  url: string;
  baseUrl: string;
  organizationName: string;
  projectName: string;
  i18n: I18nConfig;
  navbar: {
    title: string;
    items: NavbarItem[];
  };
  footer: {
    style: 'dark' | 'light';
    links: FooterColumn[];
    copyright: string;
  };
  themeConfig?: ThemeConfig;
}

/**
 * Validates that the i18n configuration is consistent.
 * Throws an error if `defaultLocale` is not included in `locales`.
 */
export function validateI18nConfig(config: SiteConfig): void {
  const { i18n } = config;
  if (!i18n.locales.includes(i18n.defaultLocale)) {
    throw new Error(
      `[docs.config.json] Invalid i18n config: defaultLocale "${i18n.defaultLocale}" is not included in locales [${i18n.locales.join(', ')}].`,
    );
  }
}

/**
 * Resolve a label that can be either a plain string or a locale-keyed object.
 * - If `label` is a string, return it directly (backward-compat).
 * - If `label` is an object `{ [locale]: string }`, return the value for the
 *   given locale; fallback to defaultLocale; fallback to first available value.
 *
 * Requirements: 7.3, 7.4
 */
export function resolveLabel(
  label: string | Record<string, string>,
  locale: string,
): string {
  if (typeof label === 'string') return label;
  if (label[locale]) return label[locale];
  const dl = rawConfig.i18n?.defaultLocale ?? 'en';
  if (label[dl]) return label[dl];
  const values = Object.values(label);
  return values[0] ?? '';
}

export const siteConfig = rawConfig as SiteConfig;

// Validate at module load time (build-time for Vite bundled code)
validateI18nConfig(siteConfig);
