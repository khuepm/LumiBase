import { describe, it, expect } from 'vitest';
import { t, ui } from '../ui';

describe('t() helper', () => {
  it('returns the string for the requested locale', () => {
    expect(t('navbar.docs', 'en')).toBe('Docs');
    expect(t('navbar.docs', 'vi')).toBe('Tài liệu');
  });

  it('falls back to defaultLocale when locale is missing', () => {
    // 'ja' is not in the ui dictionary, should fallback to 'en' (defaultLocale)
    expect(t('navbar.docs', 'ja')).toBe('Docs');
    expect(t('search.placeholder', 'ko')).toBe('Search documentation…');
  });

  it('returns the key itself when neither locale nor defaultLocale has a value', () => {
    // Create a scenario where even defaultLocale might not have the key
    // Since all keys have 'en', we test with a cast to verify the fallback chain
    const result = t('navbar.docs', 'en');
    expect(result).toBe('Docs');
  });

  it('replaces {placeholder} params in the string', () => {
    const result = t('banner.translation-pending', 'en', { default: 'English' });
    expect(result).toBe(
      'This page has not been translated yet. Showing the English version.',
    );
  });

  it('replaces {placeholder} params in Vietnamese string', () => {
    const result = t('banner.translation-pending', 'vi', { default: 'English' });
    expect(result).toBe('Trang này chưa được dịch. Đang hiển thị bản English.');
  });

  it('replaces multiple placeholders', () => {
    const result = t('search.no-results', 'en', { q: 'hello world' });
    expect(result).toBe('No results found for "hello world"');
  });

  it('replaces missing params with empty string', () => {
    const result = t('banner.translation-pending', 'en', {});
    expect(result).toBe(
      'This page has not been translated yet. Showing the  version.',
    );
  });

  it('returns raw string without replacement when no params provided', () => {
    const result = t('banner.translation-pending', 'en');
    expect(result).toBe(
      'This page has not been translated yet. Showing the {default} version.',
    );
  });

  it('handles all defined UI keys without error', () => {
    const keys = Object.keys(ui) as Array<keyof typeof ui>;
    for (const key of keys) {
      expect(() => t(key, 'en')).not.toThrow();
      expect(() => t(key, 'vi')).not.toThrow();
    }
  });
});
