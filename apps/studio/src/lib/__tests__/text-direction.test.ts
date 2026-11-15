// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  applyDocumentLanguage,
  contentDirProps,
  directionOf,
  isRtl,
  RTL_LANGUAGES,
  RTL_SCRIPTS,
} from '../text-direction';

describe('directionOf (#761)', () => {
  it.each([
    ['ar', 'rtl'],
    ['ar-EG', 'rtl'],
    ['AR_sa', 'rtl'],
    ['he', 'rtl'],
    ['he-IL', 'rtl'],
    ['iw', 'rtl'],
    ['fa', 'rtl'],
    ['fa-IR', 'rtl'],
    ['ur-PK', 'rtl'],
    ['ckb', 'rtl'],
    ['en', 'ltr'],
    ['en-US', 'ltr'],
    ['vi', 'ltr'],
    ['ja', 'ltr'],
    ['ku', 'ltr'], // Kurmanji defaults to Latin script
    ['', 'ltr'],
    ['  ', 'ltr'],
  ])('%s → %s', (tag, expected) => {
    expect(directionOf(tag)).toBe(expected);
  });

  it('lets an explicit script subtag override the language default', () => {
    expect(directionOf('az-Arab')).toBe('rtl');
    expect(directionOf('az-Arab-IR')).toBe('rtl');
    expect(directionOf('pa-Arab')).toBe('rtl');
    expect(directionOf('az-Latn')).toBe('ltr');
    expect(directionOf('ks-Deva')).toBe('ltr');
    expect(directionOf('uz-Cyrl')).toBe('ltr');
    expect(directionOf('yi-Hebr')).toBe('rtl');
  });

  it('treats non-strings as LTR instead of throwing', () => {
    for (const value of [undefined, null, 42, {}, [], true]) expect(directionOf(value)).toBe('ltr');
  });

  it('property: every RTL language is RTL with any region and casing', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RTL_LANGUAGES),
        fc.stringMatching(/^[A-Z]{2}$/),
        fc.constantFrom('-', '_'),
        fc.boolean(),
        (lang, region, sep, upper) => {
          const tag = `${upper ? lang.toUpperCase() : lang}${sep}${region}`;
          return directionOf(tag) === 'rtl' && isRtl(tag);
        },
      ),
    );
  });

  it('property: the script subtag decides, whatever the language', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{2,3}$/),
        fc.constantFrom(...RTL_SCRIPTS, 'latn', 'cyrl', 'deva', 'hans'),
        (lang, script) => {
          const tag = `${lang}-${script[0]!.toUpperCase()}${script.slice(1)}`;
          return directionOf(tag) === (RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr');
        },
      ),
    );
  });
});

describe('applyDocumentLanguage', () => {
  it('writes lang and dir to the document root and returns the direction', () => {
    expect(applyDocumentLanguage('ar')).toBe('rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('ar');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');

    expect(applyDocumentLanguage('en')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });

  it('targets a given element instead of the document when passed one', () => {
    const el = document.createElement('div');
    applyDocumentLanguage('fa-IR', el);
    expect(el.getAttribute('dir')).toBe('rtl');
    expect(el.getAttribute('lang')).toBe('fa-IR');
  });
});

describe('contentDirProps', () => {
  it('follows the content locale, independent of the UI language', () => {
    applyDocumentLanguage('en'); // English UI …
    expect(contentDirProps('ar')).toEqual({ dir: 'rtl', lang: 'ar' }); // … Arabic field is RTL
    applyDocumentLanguage('ar'); // Arabic UI …
    expect(contentDirProps('en')).toEqual({ dir: 'ltr', lang: 'en' }); // … English field stays LTR
  });

  it('falls back to dir="auto" when the content locale is unknown', () => {
    expect(contentDirProps()).toEqual({ dir: 'auto' });
    expect(contentDirProps(null)).toEqual({ dir: 'auto' });
    expect(contentDirProps('  ')).toEqual({ dir: 'auto' });
  });
});
