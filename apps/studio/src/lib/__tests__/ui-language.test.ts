import { describe, expect, it } from 'vitest';
import { resolveUiLanguage, supportedUiLanguage } from '../ui-language';

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
