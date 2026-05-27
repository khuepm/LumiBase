/**
 * Loads docs site configuration from docs.config.json (Docusaurus-style).
 *
 * Vite imports JSON natively as a module, so the config is statically
 * inlined into the bundle at build time. This keeps the docs viewer fast
 * and dependency-free while exposing a familiar surface for editors.
 */

import rawConfig from '../../docs.config.json';

export interface NavbarItem {
  label: string;
  /** Internal path (e.g. "/docs/README"). */
  to?: string;
  /** External URL. */
  href?: string;
  position?: 'left' | 'right';
}

export interface FooterLinkItem {
  label: string;
  to?: string;
  href?: string;
}

export interface FooterColumn {
  title: string;
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

export const siteConfig = rawConfig as SiteConfig;

// Validate at module load time (build-time for Vite bundled code)
validateI18nConfig(siteConfig);
