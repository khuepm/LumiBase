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
  config?: {
    i18n: {
      locales: string[];
      defaultLocale: string;
      localeNames?: Record<string, string>;
    };
  };
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
 *
 * An `index.md` is the landing page for its directory, so the trailing
 * `index` segment is collapsed to the parent path (e.g. `sdk/index.md` →
 * `sdk`, served at `/…/docs/sdk/`). This is deliberate: Cloudflare Pages
 * treats `index` as a directory-index segment and 308-redirects any request
 * for `/…/docs/sdk/index` to `/…/docs/sdk/`. If the slug kept the `index`
 * segment the page would be prerendered at `…/sdk/index/index.html` and the
 * redirect target `…/sdk/` would have no static file — a hard 404 on every
 * direct load / refresh of a section landing page.
 *
 * The match is case-sensitive **on purpose**: Cloudflare only collapses the
 * lowercase `index` segment (it mirrors `index.html`). A file named
 * `Index.md` is served fine as `…/sdk/Index/` and must NOT be rewritten —
 * making this case-insensitive would break URLs that already work.
 */
export function deriveSlug(relativePath: string): string {
  const withoutExt = relativePath.replace(/\.md$/, '').split(path.sep).join('/');
  const collapsed = withoutExt.replace(/(^|\/)index$/, '');
  // A top-level `index.md` collapses to '' — keep the literal `index` so the
  // entry still has a routable, non-empty slug.
  return collapsed === '' ? withoutExt : collapsed;
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
  // `index.md` has no meaningful filename — it is the landing page for its
  // directory, so title it after the directory (e.g. agent-setup/index.md →
  // "Agent Setup") instead of the literal, useless "Index".
  if (basename === 'index') {
    const dir = path.basename(path.dirname(filePath));
    if (dir && dir !== '.' && dir !== '..') return toTitleCase(dir);
  }
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
    // Path Traversal mitigation: ensure resolved absolute path is actually inside docsDir
    const safeAbsPath = path.resolve(docsDir, absPath);
    if (!safeAbsPath.startsWith(path.resolve(docsDir))) {
      console.warn(`[vite-plugin-docs-loader] Path traversal detected, ignoring: ${absPath}`);
      continue;
    }

    // Path relative to the locale folder → used for slug derivation
    const relativeToLocale = path.relative(localeDir, safeAbsPath);
    const slug = deriveSlug(relativeToLocale);
    // Path relative to docsDir root → includes locale prefix, e.g. "en/features/ai-copilot.md"
    const filePath = path.relative(docsDir, safeAbsPath).split(path.sep).join('/');

    try {
      const raw = fs.readFileSync(safeAbsPath, 'utf-8');
      const { data: frontMatter, content } = matter(raw);
      const title = deriveTitle(frontMatter.title, relativeToLocale);

      // Prefer the curated `lastUpdated` front-matter stamp (written by the docs
      // i18n sync tooling) so the displayed date tracks content versions rather
      // than incidental filesystem mtime. Fall back to mtime when absent.
      let lastModified: string | undefined;
      if (typeof frontMatter.lastUpdated === 'string' && frontMatter.lastUpdated.trim()) {
        lastModified = frontMatter.lastUpdated;
      } else {
        try {
          const stat = fs.statSync(safeAbsPath);
          lastModified = stat.mtime.toISOString();
        } catch {
          // ignore stat errors
        }
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
  config?: { i18n: { locales: string[]; defaultLocale: string; localeNames?: Record<string, string> } },
): {
  locales: string[];
  defaultLocale: string;
  localeNames: Record<string, string>;
  docTree: DocNode[];
  docIndex: Record<string, DocEntry>;
  docList: DocEntry[];
  docIndexByLocale: Record<string, Record<string, DocEntry>>;
  docTreeByLocale: Record<string, DocNode[]>;
  docTreeUnion: DocNode[];
  docSlugsByLocale: Record<string, string[]>;
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
    return {
      locales: [''],
      defaultLocale: '',
      localeNames: {},
      docTree,
      docIndex,
      docList,
      docIndexByLocale: { '': docIndex },
      docTreeByLocale: { '': docTree },
      docTreeUnion: docTree,
      docSlugsByLocale: { '': Object.keys(docIndex) },
    };
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

  // Build docTreeByLocale — tree per locale using only that locale's entries
  const docTreeByLocale: Record<string, DocNode[]> = {};
  for (const locale of locales) {
    const localeEntries = Object.values(docIndexByLocale[locale] ?? {});
    docTreeByLocale[locale] = buildDocTreeBySlug(localeEntries);
  }

  // Build docSlugsByLocale — array of slugs per locale
  const docSlugsByLocale: Record<string, string[]> = {};
  for (const locale of locales) {
    docSlugsByLocale[locale] = Object.keys(docIndexByLocale[locale] ?? {});
  }

  // Build docTreeUnion — tree from union of all entries across all locales
  // Deduplicate by slug, preferring default locale entry
  const unionMap: Record<string, DocEntry> = {};
  for (const locale of locales) {
    const localeIndex = docIndexByLocale[locale] ?? {};
    for (const [slug, entry] of Object.entries(localeIndex)) {
      // Prefer default locale entry if slug already exists
      if (!unionMap[slug] || locale === defaultLocale) {
        unionMap[slug] = entry;
      }
    }
  }
  const unionEntries = Object.values(unionMap);
  const docTreeUnion = buildDocTreeBySlug(unionEntries);

  // Backward-compat alias: docTree = docTreeUnion
  const docTree = docTreeUnion;

  return {
    locales,
    defaultLocale,
    localeNames: config.i18n.localeNames ?? {},
    docTree,
    docIndex,
    docList,
    docIndexByLocale,
    docTreeByLocale,
    docTreeUnion,
    docSlugsByLocale,
  };
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
 * Build a DocTree from entries using their slug (locale-independent path).
 * This produces a tree without the locale prefix in the hierarchy.
 * Sorted: directories first (alphabetically), then files (alphabetically).
 */
export function buildDocTreeBySlug(entries: DocEntry[]): DocNode[] {
  const root: Map<string, unknown> = new Map();

  for (const entry of entries) {
    const parts = entry.slug.split('/');
    let current = root;

    // Navigate/create directory nodes for all parts except the last
    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i]!;
      if (!current.has(dirName)) {
        current.set(dirName, new Map());
      }
      const next = current.get(dirName);
      // If a file entry already occupies this key, promote it to a directory Map
      // and preserve the file entry under a special '__file__' key
      if (!(next instanceof Map)) {
        const dirMap = new Map<string, unknown>();
        dirMap.set('__file__', next); // preserve the existing file entry
        current.set(dirName, dirMap);
        current = dirMap;
      } else {
        current = next as Map<string, unknown>;
      }
    }

    // Set the file entry at the leaf (only if not already a directory Map)
    const fileName = parts[parts.length - 1]!;
    const existing = current.get(fileName);
    if (existing instanceof Map) {
      // A directory already exists at this key; store the file entry as a special __file__ key
      existing.set('__file__', entry);
    } else {
      current.set(fileName, entry);
    }
  }

  return mapToDocNodes(root);
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
    if (key === '__file__') {
      // A file entry stored alongside directory children (slug is both file and dir prefix)
      const entry = value as DocEntry;
      files.push({
        type: 'file',
        name: entry.title,
        slug: entry.slug,
      });
    } else if (value instanceof Map) {
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
        const {
          locales: registryLocales,
          defaultLocale: registryDefaultLocale,
          localeNames: registryLocaleNames,
          docTree,
          docIndex,
          docList,
          docIndexByLocale,
          docTreeByLocale,
          docTreeUnion,
          docSlugsByLocale,
        } = buildRegistry(docsDir, config);

        const code = `
export const locales = ${JSON.stringify(registryLocales)};
export const defaultLocale = ${JSON.stringify(registryDefaultLocale)};
export const localeNames = ${JSON.stringify(registryLocaleNames)};
export const docTree = ${JSON.stringify(docTree, null, 2)};
export const docIndex = ${JSON.stringify(docIndex, null, 2)};
export const docList = ${JSON.stringify(docList, null, 2)};
export const docIndexByLocale = ${JSON.stringify(docIndexByLocale, null, 2)};
export const docTreeByLocale = ${JSON.stringify(docTreeByLocale, null, 2)};
export const docTreeUnion = ${JSON.stringify(docTreeUnion, null, 2)};
export const docSlugsByLocale = ${JSON.stringify(docSlugsByLocale, null, 2)};
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
