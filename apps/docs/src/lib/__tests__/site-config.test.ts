import { describe, it, expect } from 'vitest';
import { validateI18nConfig, type SiteConfig } from '../site-config';

function makeSiteConfig(i18n: SiteConfig['i18n']): SiteConfig {
  return {
    title: 'Test',
    tagline: 'Test tagline',
    url: 'https://example.com',
    baseUrl: '/',
    organizationName: 'test',
    projectName: 'test',
    i18n,
    navbar: { title: 'Test', items: [] },
    sidebar: { docs: [] },
    footer: { style: 'dark', links: [], copyright: '' },
  };
}

describe('validateI18nConfig', () => {
  it('should pass when defaultLocale is in locales', () => {
    const config = makeSiteConfig({
      defaultLocale: 'en',
      locales: ['en', 'vi'],
      localeNames: { en: 'English', vi: 'Tiếng Việt' },
    });
    expect(() => validateI18nConfig(config)).not.toThrow();
  });

  it('should throw when defaultLocale is not in locales', () => {
    const config = makeSiteConfig({
      defaultLocale: 'fr',
      locales: ['en', 'vi'],
      localeNames: { en: 'English', vi: 'Tiếng Việt' },
    });
    expect(() => validateI18nConfig(config)).toThrow(
      'defaultLocale "fr" is not included in locales [en, vi]',
    );
  });

  it('should pass with a single locale that matches defaultLocale', () => {
    const config = makeSiteConfig({
      defaultLocale: 'en',
      locales: ['en'],
      localeNames: { en: 'English' },
    });
    expect(() => validateI18nConfig(config)).not.toThrow();
  });

  it('should throw with empty locales array', () => {
    const config = makeSiteConfig({
      defaultLocale: 'en',
      locales: [],
      localeNames: {},
    });
    expect(() => validateI18nConfig(config)).toThrow(
      'defaultLocale "en" is not included in locales []',
    );
  });
});
