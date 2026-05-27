/**
 * Mock for the virtual:docs-registry module used in tests.
 * Provides empty defaults so components that import from the virtual module
 * can be loaded in test environments without the Vite plugin.
 */

export interface DocEntry {
  slug: string;
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

export const locales: string[] = ['en', 'vi'];
export const defaultLocale: string = 'en';
export const localeNames: Record<string, string> = { en: 'English', vi: 'Tiếng Việt' };

export const docTree: DocNode[] = [];
export const docIndex: Record<string, DocEntry> = {};
export const docList: DocEntry[] = [];
export const docIndexByLocale: Record<string, Record<string, DocEntry>> = { en: {}, vi: {} };
export const docTreeByLocale: Record<string, DocNode[]> = { en: [], vi: [] };
export const docTreeUnion: DocNode[] = [];
export const docSlugsByLocale: Record<string, string[]> = { en: [], vi: [] };
