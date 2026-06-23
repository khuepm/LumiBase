import { SEARCH_META_ATTRS } from '@lumibase/runtime';

/**
 * Normalized search document shape. The reserved `_collection` / `_title` /
 * `_updatedAt` attributes let the Studio UI render a meaningful result list
 * (title + which collection it lives in) without re-fetching each item, while
 * the spread item `data` keeps every field searchable.
 */
export type SearchDocument = Record<string, unknown> & {
  id: string;
  [SEARCH_META_ATTRS.collection]: string;
  [SEARCH_META_ATTRS.title]: string;
  [SEARCH_META_ATTRS.updatedAt]?: string | number;
};

/** Field names we prefer, in order, when deriving a human-readable `_title`. */
const TITLE_FIELD_CANDIDATES = ['title', 'name', 'label', 'heading', 'slug'] as const;

/**
 * Derive a display title from an item's data. Prefers well-known field names;
 * otherwise falls back to the first non-empty string field, then the id.
 */
function deriveTitle(id: string, data: Record<string, unknown>): string {
  for (const key of TITLE_FIELD_CANDIDATES) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  for (const v of Object.values(data)) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return id;
}

/**
 * Build the enriched document indexed into the search engine. Used by both the
 * `content-indexing` worker and ItemService's direct (no-queue) fallback so
 * the two paths always produce identical documents.
 */
export function buildSearchDocument(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): SearchDocument {
  const updatedAt = data.updated_at ?? data.updatedAt;
  return {
    ...data,
    id,
    [SEARCH_META_ATTRS.collection]: collection,
    [SEARCH_META_ATTRS.title]: deriveTitle(id, data),
    ...(typeof updatedAt === 'string' || typeof updatedAt === 'number'
      ? { [SEARCH_META_ATTRS.updatedAt]: updatedAt }
      : {}),
  };
}
