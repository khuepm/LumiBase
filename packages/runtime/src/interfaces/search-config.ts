import type { SearchIndexSettings } from './search';

/**
 * Vietnamese stop words — common function words (hư từ) that carry little
 * search signal. Dropping them improves relevance ranking. MeiliSearch already
 * handles diacritics-insensitive matching out of the box (gõ "ha noi" khớp
 * "Hà Nội"), so this list is about relevance, not about Vietnamese matching.
 */
export const VIETNAMESE_STOP_WORDS: readonly string[] = [
  'và',
  'của',
  'là',
  'các',
  'những',
  'cho',
  'với',
  'một',
  'được',
  'để',
  'có',
  'trong',
  'này',
  'đó',
  'khi',
  'thì',
  'mà',
  'ở',
  'từ',
  'theo',
  'như',
  'về',
  'đã',
  'sẽ',
  'cũng',
  'nếu',
  'hoặc',
  'bị',
];

/**
 * Reserved metadata attributes LumiBase adds to every indexed document so the
 * UI can render meaningful results without re-fetching each item.
 */
export const SEARCH_META_ATTRS = {
  collection: '_collection',
  title: '_title',
  updatedAt: '_updatedAt',
} as const;

/**
 * Build the default index settings for a collection. `searchableFields` are the
 * collection's own fields flagged `searchable`; the normalized `_title` is
 * boosted ahead of them by appearing first.
 *
 * Diacritics-insensitivity is a MeiliSearch built-in and needs no setting here.
 * We raise the typo-tolerance word-size thresholds because Vietnamese has many
 * short tokens where aggressive fuzzy matching produces noise (e.g. "bo"
 * matching "náo").
 */
export function defaultIndexSettings(searchableFields: string[] = []): SearchIndexSettings {
  return {
    searchableAttributes: [SEARCH_META_ATTRS.title, ...searchableFields],
    filterableAttributes: [SEARCH_META_ATTRS.collection],
    sortableAttributes: [SEARCH_META_ATTRS.updatedAt],
    stopWords: [...VIETNAMESE_STOP_WORDS],
    typoTolerance: {
      enabled: true,
      minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 },
    },
  };
}
