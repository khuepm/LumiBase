declare module 'virtual:docs-registry' {
  export interface DocEntry {
    slug: string;
    locale: string;
    title: string;
    filePath: string;
    content: string;
    lastModified?: string;
  }

  export interface DocNode {
    type: 'file' | 'directory';
    name: string;
    slug?: string;
    children?: DocNode[];
  }

  /** Supported locales from docs.config.json */
  export const locales: string[];
  /** Default locale from docs.config.json */
  export const defaultLocale: string;
  /** Display names for each locale, e.g. { en: "English", vi: "Tiếng Việt" } */
  export const localeNames: Record<string, string>;

  /** All doc entries across all locales (flat list) */
  export const docList: DocEntry[];
  /** Index per locale: Record<locale, Record<slug, DocEntry>> */
  export const docIndexByLocale: Record<string, Record<string, DocEntry>>;
  /** Tree per locale — only contains slugs that have a file in that locale */
  export const docTreeByLocale: Record<string, DocNode[]>;
  /** Union tree — all slugs from all locales, used for Sidebar UI */
  export const docTreeUnion: DocNode[];
  /** Slugs available per locale (serialized as arrays) */
  export const docSlugsByLocale: Record<string, string[]>;

  // Backward-compat aliases (default locale view)
  /** @deprecated Use docIndexByLocale[defaultLocale] instead */
  export const docIndex: Record<string, DocEntry>;
  /** @deprecated Use docTreeUnion instead */
  export const docTree: DocNode[];
}
