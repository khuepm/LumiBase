import fs from 'node:fs';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import matter from 'gray-matter';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface DocEntry {
  slug: string;
  locale: string;
  title: string;
  filePath: string; // relative to docsRootDir, e.g. "en/features/ai-copilot.md"
  content: string;
  lastModified?: string;
}

export interface DocNode {
  type: 'file' | 'directory';
  name: string;
  slug?: string;
  children?: DocNode[];
}

export interface VitePluginDocsLoaderOptions {
  docsDir?: string; // absolute path to docs root directory (contains locale folders)
  config?: { i18n: { locales: string[]; defaultLocale: string } };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a filename (without extension) to title case.
 * Replaces hyphens with spaces and capitalizes each word.
 */
export function toTitleCase(filename: string): string {
  return filename
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Derive the slug from a file path relative to the docs directory.
 * Removes the .md extension and uses forward slashes.
 */
export function deriveSlug(relativePath: string): string {
  return relativePath.replace(/\.md$/, '').split(path.sep).join('/');
}

/**
 * Derive the display title for a doc file.
 * Uses front matter title if present, otherwise derives from filename.
 */
export function deriveTitle(
  frontMatterTitle: string | undefined,
  filePath: string,
): string {
  if (frontMatterTitle) return frontMatterTitle;
  const basename = path.basename(filePath, '.md');
  return toTitleCase(basename);
}

/**
 * Discover all .md files for a single locale under docsDir/{locale}/ and return entries.
 */
export function discoverLocaleEntries(
  docsDir: string,
  locale: string,
): DocEntry[] {
  const localeDir = path.join(docsDir, locale);
  const entries: DocEntry[] = [];

  // If locale directory doesn't exist, return empty (valid per spec)
  if (!fs.existsSync(localeDir)) {
    return entries;
  }

  // Discover all .md files under docsDir/{locale}/
  const pattern = path.join(localeDir, '**/*.md');
  let mdFiles: string[];
  try {
    mdFiles = fs.globSync(pattern);
  } catch {
    // Fallback: recursive readdir
    mdFiles = findMdFiles(localeDir);
  }

  for (const absPath of mdFiles) {
    // Path relative to the locale folder → used for slug derivation
    const relativeToLocale = path.relative(localeDir, absPath);
    const slug = deriveSlug(relativeToLocale);
    // Path relative to docsDir root → includes locale prefix, e.g. "en/features/ai-copilot.md"
    const filePath = path.relative(docsDir, absPath).split(path.sep).join('/');

    try {
      const raw = fs.readFileSync(absPath, 'utf-8');
      const { data: frontMatter, content } = matter(raw);
      const title = deriveTitle(frontMatter.title, relativeToLocale);

      let lastModified: string | undefined;
      try {
        const stat = fs.statSync(absPath);
        lastModified = stat.mtime.toISOString();
      } catch {
        // ignore stat errors
      }

      const entry: DocEntry = {
        slug,
        locale,
        title,
        filePath,
        content,
        lastModified,
      };

      entries.push(entry);
    } catch (err) {
      console.warn(
        `[vite-plugin-docs-loader] Failed to parse ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
      // Exclude file from registry on parse error
    }
  }

  return entries;
}

/**
 * Discover all .md files across all locales and build the multi-locale registry.
 * Validates that defaultLocale is in locales array.
 */
export function buildRegistry(
  docsDir: string,
  config?: { i18n: { locales: string[]; defaultLocale: string } },
): {
  docTree: DocNode[];
  docIndex: Record<string, DocEntry>;
  docList: DocEntry[];
  docIndexByLocale: Record<string, Record<string, DocEntry>>;
} {
  // If no i18n config provided, fall back to single-locale behavior (backward compat)
  if (!config) {
    const docIndex: Record<string, DocEntry> = {};
    const docList: DocEntry[] = [];

    const pattern = path.join(docsDir, '**/*.md');
    let mdFiles: string[];
    try {
      mdFiles = fs.globSync(pattern);
    } catch {
      mdFiles = findMdFiles(docsDir);
    }

    for (const absPath of mdFiles) {
      const relativePath = path.relative(docsDir, absPath);
      const slug = deriveSlug(relativePath);

      try {
        const raw = fs.readFileSync(absPath, 'utf-8');
        const { data: frontMatter, content } = matter(raw);
        const title = deriveTitle(frontMatter.title, relativePath);

        let lastModified: string | undefined;
        try {
          const stat = fs.statSync(absPath);
          lastModified = stat.mtime.toISOString();
        } catch {
          // ignore stat errors
        }

        const entry: DocEntry = {
          slug,
          locale: '',
          title,
          filePath: relativePath,
          content,
          lastModified,
        };

        docIndex[slug] = entry;
        docList.push(entry);
      } catch (err) {
        console.warn(
          `[vite-plugin-docs-loader] Failed to parse ${relativePath}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const docTree = buildDocTree(docList, docsDir);
    return { docTree, docIndex, docList, docIndexByLocale: { '': docIndex } };
  }

  const { locales, defaultLocale } = config.i18n;

  // Validate: defaultLocale must be in locales
  if (!locales.includes(defaultLocale)) {
    throw new Error(
      `[vite-plugin-docs-loader] defaultLocale "${defaultLocale}" is not in locales [${locales.join(', ')}]. ` +
        `Please ensure defaultLocale is included in the locales array in docs.config.json.`,
    );
  }

  const docList: DocEntry[] = [];
  const docIndexByLocale: Record<string, Record<string, DocEntry>> = {};

  // Discover entries for each locale
  for (const locale of locales) {
    const entries = discoverLocaleEntries(docsDir, locale);
    const localeIndex: Record<string, DocEntry> = {};

    for (const entry of entries) {
      localeIndex[entry.slug] = entry;
      docList.push(entry);
    }

    docIndexByLocale[locale] = localeIndex;
  }

  // Build docIndex as alias for default locale (backward compat)
  const docIndex = docIndexByLocale[defaultLocale] ?? {};

  // Build tree from default locale entries (backward compat)
  const defaultLocaleEntries = Object.values(docIndex);
  const docTree = buildDocTree(defaultLocaleEntries, docsDir);

  return { docTree, docIndex, docList, docIndexByLocale };
}

/**
 * Fallback: recursively find all .md files using fs.readdirSync.
 */
function findMdFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMdFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Build a DocTree from the flat list of doc entries.
 * Sorted: directories first (alphabetically), then files (alphabetically).
 */
export function buildDocTree(
  docList: DocEntry[],
  _docsDir: string,
): DocNode[] {
  // Build a nested map structure
  const root: Map<string, unknown> = new Map();

  for (const entry of docList) {
    const parts = entry.filePath.split(path.sep);
    let current = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i]!;
      if (!current.has(dirName)) {
        current.set(dirName, new Map());
      }
      current = current.get(dirName) as Map<string, unknown>;
    }

    // Set the file entry at the leaf
    const fileName = parts[parts.length - 1]!;
    current.set(fileName, entry);
  }

  return mapToDocNodes(root);
}

/**
 * Convert the nested map structure to DocNode array with proper sorting.
 */
function mapToDocNodes(map: Map<string, unknown>): DocNode[] {
  const directories: DocNode[] = [];
  const files: DocNode[] = [];

  for (const [key, value] of map) {
    if (value instanceof Map) {
      // Directory node
      directories.push({
        type: 'directory',
        name: key,
        children: mapToDocNodes(value),
      });
    } else {
      // File node
      const entry = value as DocEntry;
      files.push({
        type: 'file',
        name: entry.title,
        slug: entry.slug,
      });
    }
  }

  // Sort: directories first alphabetically, then files alphabetically
  directories.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return [...directories, ...files];
}

// ─── Virtual Module ID ───────────────────────────────────────────────────────

const VIRTUAL_MODULE_ID = 'virtual:docs-registry';
const RESOLVED_VIRTUAL_MODULE_ID = '\0' + VIRTUAL_MODULE_ID;

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default function vitePluginDocsLoader(
  options: VitePluginDocsLoaderOptions = {},
): Plugin {
  const docsDir = options.docsDir ?? path.resolve(process.cwd(), '../../docs');
  const config = options.config;

  return {
    name: 'vite-plugin-docs-loader',

    resolveId(id: string) {
      if (id === VIRTUAL_MODULE_ID) {
        return RESOLVED_VIRTUAL_MODULE_ID;
      }
    },

    load(id: string) {
      if (id === RESOLVED_VIRTUAL_MODULE_ID) {
        const { docTree, docIndex, docList, docIndexByLocale } = buildRegistry(
          docsDir,
          config,
        );

        const code = `
export const docTree = ${JSON.stringify(docTree, null, 2)};
export const docIndex = ${JSON.stringify(docIndex, null, 2)};
export const docList = ${JSON.stringify(docList, null, 2)};
export const docIndexByLocale = ${JSON.stringify(docIndexByLocale, null, 2)};
`;
        return code;
      }
    },

    configureServer(server: ViteDevServer) {
      // Watch the docs directory for changes in dev mode
      server.watcher.add(docsDir);

      server.watcher.on('change', (filePath: string) => {
        if (filePath.startsWith(docsDir) && filePath.endsWith('.md')) {
          // Invalidate the virtual module to trigger HMR
          const mod = server.moduleGraph.getModuleById(
            RESOLVED_VIRTUAL_MODULE_ID,
          );
          if (mod) {
            server.moduleGraph.invalidateModule(mod);
            server.ws.send({ type: 'full-reload' });
          }
        }
      });

      server.watcher.on('add', (filePath: string) => {
        if (filePath.startsWith(docsDir) && filePath.endsWith('.md')) {
          const mod = server.moduleGraph.getModuleById(
            RESOLVED_VIRTUAL_MODULE_ID,
          );
          if (mod) {
            server.moduleGraph.invalidateModule(mod);
            server.ws.send({ type: 'full-reload' });
          }
        }
      });

      server.watcher.on('unlink', (filePath: string) => {
        if (filePath.startsWith(docsDir) && filePath.endsWith('.md')) {
          const mod = server.moduleGraph.getModuleById(
            RESOLVED_VIRTUAL_MODULE_ID,
          );
          if (mod) {
            server.moduleGraph.invalidateModule(mod);
            server.ws.send({ type: 'full-reload' });
          }
        }
      });
    },
  };
}
