import { docIndexByLocale, defaultLocale, type DocEntry } from 'virtual:docs-registry';

export interface ResolvedDoc {
  entry: DocEntry;
  isFallback: boolean;
}

/**
 * Pure version of resolveDoc that accepts registry data as parameters.
 * Useful for property-based testing with generated data.
 */
export function resolveDocPure(
  locale: string,
  slug: string,
  registry: Record<string, Record<string, DocEntry>>,
  defLocale: string,
): ResolvedDoc | null {
  const localeIndex = registry[locale];
  if (localeIndex && localeIndex[slug]) {
    return { entry: localeIndex[slug], isFallback: false };
  }

  const defaultIndex = registry[defLocale];
  if (defaultIndex && defaultIndex[slug]) {
    return { entry: defaultIndex[slug], isFallback: true };
  }

  return null;
}

/**
 * Resolve a document for a given locale and slug.
 * Falls back to the default locale if the document doesn't exist in the requested locale.
 * Returns null if the document doesn't exist in any locale.
 */
export function resolveDoc(locale: string, slug: string): ResolvedDoc | null {
  return resolveDocPure(locale, slug, docIndexByLocale, defaultLocale);
}
