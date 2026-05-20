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

export interface SiteConfig {
  title: string;
  tagline: string;
  url: string;
  baseUrl: string;
  organizationName: string;
  projectName: string;
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

export const siteConfig = rawConfig as SiteConfig;
