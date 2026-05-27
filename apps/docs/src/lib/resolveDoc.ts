import { docIndexByLocale, defaultLocale, type DocEntry } from 'virtual:docs-registry';

export interface ResolvedDoc {
  entry: DocEntry;
  isFallback: boolean;
}

/**
 * Resolve a document for a given locale and slug.
 * Falls back to the default locale if the document doesn't exist in the requested locale.
 * Returns null if the document doesn't exist in any locale.
 */
export function resolveDoc(locale: string, slug: string): ResolvedDoc | null {
  const localeIndex = docIndexByLocale[locale];
  if (localeIndex && localeIndex[slug]) {
    return { entry: localeIndex[slug], isFallback: false };
  }

  const defaultIndex = docIndexByLocale[defaultLocale];
  if (defaultIndex && defaultIndex[slug]) {
    return { entry: defaultIndex[slug], isFallback: true };
  }

  return null;
}
