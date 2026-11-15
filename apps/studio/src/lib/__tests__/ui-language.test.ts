import { describe, expect, it } from 'vitest';
import {
  BUNDLED_UI_LANGUAGES,
  readStoredUiLanguage,
  resolveUiLanguage,
  storeUiLanguage,
  supportedUiLanguage,
  UI_LANGUAGE_STORAGE_KEY,
  UI_LANGUAGES,
} from '../ui-language';

describe('resolveUiLanguage (B112)', () => {
  it.each([
    [{ preference: 'vi', siteDefault: 'en' }, 'vi'],
    [{ preference: 'en', siteDefault: 'vi' }, 'en'],
    [{ preference: undefined, siteDefault: 'vi' }, 'vi'],
    [{ preference: null, siteDefault: 'vi' }, 'vi'],
    [{ preference: 'fr', siteDefault: 'vi' }, 'vi'],
    [{ preference: 'vi-VN', siteDefault: 'en' }, 'vi'],
    [{ preference: 'VI_vn', siteDefault: undefined }, 'vi'],
    [{ preference: 'fr', siteDefault: 'de' }, 'en'],
    [{}, 'en'],
    [{ preference: 42, siteDefault: {} }, 'en'],
  ])('%o → %s', (sources, expected) => {
    expect(resolveUiLanguage(sources)).toBe(expected);
  });

  it('matches on the base language only', () => {
    expect(supportedUiLanguage('en-GB')).toBe('en');
    expect(supportedUiLanguage('vietnamese')).toBeNull();
    expect(supportedUiLanguage('')).toBeNull();
  });
});

describe('RTL UI languages (#761)', () => {
  it('supports Arabic, Hebrew and Farsi for layout', () => {
    expect(resolveUiLanguage({ preference: 'ar' })).toBe('ar');
    expect(resolveUiLanguage({ preference: 'he-IL', siteDefault: 'en' })).toBe('he');
    expect(resolveUiLanguage({ siteDefault: 'fa-IR' })).toBe('fa');
    expect(supportedUiLanguage('iw')).toBe('he'); // legacy Hebrew tag
    expect(supportedUiLanguage('ur')).toBeNull(); // RTL but not offered as a UI language
  });

  it('ships bundled copy only for en and vi (the others fall back to English)', () => {
    expect(BUNDLED_UI_LANGUAGES).toEqual(['en', 'vi']);
    for (const lang of BUNDLED_UI_LANGUAGES) expect(UI_LANGUAGES).toContain(lang);
  });
});

describe('remembered UI language', () => {
  function memoryStorage() {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  }

  it('round-trips through storage under a fixed key', () => {
    const storage = memoryStorage();
    expect(readStoredUiLanguage(storage)).toBeNull();
    storeUiLanguage('ar', storage);
    expect(storage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('ar');
    expect(readStoredUiLanguage(storage)).toBe('ar');
  });

  it('ignores a tampered or unsupported stored value', () => {
    const storage = memoryStorage();
    storage.setItem(UI_LANGUAGE_STORAGE_KEY, '<script>');
    expect(readStoredUiLanguage(storage)).toBeNull();
  });

  it('never throws when storage is unavailable', () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error('SecurityError');
      },
      setItem: (): void => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(readStoredUiLanguage(throwing)).toBeNull();
    expect(() => storeUiLanguage('he', throwing)).not.toThrow();
    expect(readStoredUiLanguage(null)).toBeNull();
  });
});
