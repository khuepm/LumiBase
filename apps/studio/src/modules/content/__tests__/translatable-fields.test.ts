import { describe, expect, it } from 'vitest';
import type { FieldResource } from '@lumibase/sdk';
import {
  completionPct,
  hasTranslation,
  localeValue,
  setLocaleValue,
  tmLearnEntries,
  translatableFields,
} from '../translatable-fields';

/**
 * Translatable-field helpers (translation-memory-ui).
 *
 * **Validates: Requirements 4.1, 5.1, 6.1**
 */

function field(name: string, iface: string): FieldResource {
  return {
    id: `f_${name}`,
    collectionId: 'c1',
    name,
    type: 'string',
    interface: iface,
    required: false,
    hidden: false,
    sortOrder: 0,
  } as FieldResource;
}

const FIELDS = [
  field('title', 'translatable-text'),
  field('slug', 'input'),
  field('body', 'translatable-text'),
];

describe('translatableFields', () => {
  it('keeps only translatable-text interfaces in order', () => {
    expect(translatableFields(FIELDS).map((f) => f.name)).toEqual(['title', 'body']);
  });
});

describe('locale value helpers', () => {
  it('reads a locale from a map and defaults to empty', () => {
    expect(localeValue({ en: 'Hi', vi: 'Chào' }, 'vi')).toBe('Chào');
    expect(localeValue({ en: 'Hi' }, 'fr')).toBe('');
    expect(localeValue('scalar', 'en')).toBe('');
    expect(localeValue(null, 'en')).toBe('');
  });

  it('sets a locale without mutating the original', () => {
    const original = { en: 'Hi' };
    const next = setLocaleValue(original, 'vi', 'Chào');
    expect(next).toEqual({ en: 'Hi', vi: 'Chào' });
    expect(original).toEqual({ en: 'Hi' });
  });

  it('treats whitespace-only as untranslated', () => {
    expect(hasTranslation({ vi: '  ' }, 'vi')).toBe(false);
    expect(hasTranslation({ vi: 'x' }, 'vi')).toBe(true);
  });
});

describe('completionPct', () => {
  it('is the ratio of translated translatable fields', () => {
    const data = { title: { en: 'T', vi: 'T-vi' }, body: { en: 'B' }, slug: 'my-slug' };
    // 1 of 2 translatable fields have vi → 50
    expect(completionPct(FIELDS, data, 'vi')).toBe(50);
  });

  it('is 100 when both translatable fields are done', () => {
    const data = { title: { vi: 'a' }, body: { vi: 'b' } };
    expect(completionPct(FIELDS, data, 'vi')).toBe(100);
  });

  it('is 100 when there are no translatable fields', () => {
    expect(completionPct([field('slug', 'input')], {}, 'vi')).toBe(100);
  });
});

describe('tmLearnEntries (learn-on-save, Req 6.1)', () => {
  const data = { title: { en: 'Hello', vi: 'Xin chào' }, body: { en: 'B', vi: '' } };

  it('returns human pairs for edited fields when enabled', () => {
    expect(
      tmLearnEntries({
        enabled: true,
        editedFields: ['title'],
        data,
        sourceLocale: 'en',
        targetLocale: 'vi',
      }),
    ).toEqual([{ sourceLang: 'en', targetLang: 'vi', sourceText: 'Hello', targetText: 'Xin chào' }]);
  });

  it('returns nothing when learning is disabled', () => {
    expect(
      tmLearnEntries({
        enabled: false,
        editedFields: ['title'],
        data,
        sourceLocale: 'en',
        targetLocale: 'vi',
      }),
    ).toEqual([]);
  });

  it('skips fields missing either source or target text', () => {
    // `body` has an empty vi target → not learnable.
    expect(
      tmLearnEntries({
        enabled: true,
        editedFields: ['body'],
        data,
        sourceLocale: 'en',
        targetLocale: 'vi',
      }),
    ).toEqual([]);
  });

  it('returns nothing when source and target locale match', () => {
    expect(
      tmLearnEntries({
        enabled: true,
        editedFields: ['title'],
        data,
        sourceLocale: 'en',
        targetLocale: 'en',
      }),
    ).toEqual([]);
  });
});
