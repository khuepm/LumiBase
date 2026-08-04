import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildRegistry, type DocNode } from '../vite-plugin-docs-loader';

/**
 * Feature: lumibase-docs-i18n, Property 3: Sidebar union completeness
 *
 * For any set of (locale, slug) pairs, the docTreeUnion built by buildRegistry
 * satisfies the bidirectional invariant:
 *   s ∈ docTreeUnion ⇔ ∃ L : s ∈ docSlugsByLocale[L]
 *
 * That is:
 * - Every slug in docTreeUnion exists in at least one locale's docSlugsByLocale
 * - Every slug in any docSlugsByLocale[L] appears in docTreeUnion
 *
 * Validates: Requirements 4.4, 4.5
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Recursively collect all file slugs from a DocNode tree.
 */
function collectSlugsFromTree(nodes: DocNode[]): Set<string> {
  const slugs = new Set<string>();
  for (const node of nodes) {
    if (node.type === 'file' && node.slug) {
      slugs.add(node.slug);
    }
    if (node.type === 'directory' && node.children) {
      for (const s of collectSlugsFromTree(node.children)) {
        slugs.add(s);
      }
    }
  }
  return slugs;
}

/**
 * Create a temporary fixture directory with markdown files for given locale/slug pairs.
 * Returns the path to the temp docs root directory.
 */
function createFixture(localeSlugPairs: Array<{ locale: string; slug: string }>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-union-pbt-'));

  for (const { locale, slug } of localeSlugPairs) {
    const filePath = path.join(tmpDir, locale, `${slug}.md`);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, `# ${slug}\n\nContent for ${locale}/${slug}\n`);
  }

  return tmpDir;
}

// Track temp dirs for cleanup
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  tempDirs.length = 0;
});

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Generate a valid slug segment (directory or file name).
 * Constrained to lowercase alphanumeric + hyphens.
 */
const slugSegment = fc.string({
  unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  minLength: 1,
  maxLength: 8,
});

/**
 * Generate a valid slug (1-3 segments joined by '/').
 */
const slugArb = fc.tuple(
  fc.array(slugSegment, { minLength: 0, maxLength: 2 }),
  slugSegment,
).map(([dirs, file]) => [...dirs, file].join('/'));

/**
 * Generate a locale identifier (2-3 lowercase letters).
 */
const localeArb = fc.string({
  unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
  minLength: 2,
  maxLength: 3,
});

/**
 * Generate a set of locales (at least 2, at most 4) with a guaranteed default locale.
 */
const localesArb = fc.uniqueArray(localeArb, { minLength: 2, maxLength: 4 });

/**
 * Generate a set of (locale, slug) pairs for multiple locales.
 * Each locale gets 0-5 slugs, with possible overlap between locales.
 */
const localeSlugPairsArb = localesArb.chain((locales) => {
  const defaultLocale = locales[0]!;
  // Generate a pool of slugs, then assign subsets to each locale
  return fc.uniqueArray(slugArb, { minLength: 1, maxLength: 10 }).map((slugPool) => {
    const pairs: Array<{ locale: string; slug: string }> = [];
    // Ensure at least one slug exists in some locale
    for (const locale of locales) {
      // Each locale gets a random subset of the slug pool
      for (const slug of slugPool) {
        // Use a deterministic-ish selection: include slug if hash is even
        const hash = (locale.charCodeAt(0) + slug.charCodeAt(0)) % 3;
        if (hash !== 0) {
          pairs.push({ locale, slug });
        }
      }
    }
    // Ensure at least one pair exists
    if (pairs.length === 0) {
      pairs.push({ locale: defaultLocale, slug: slugPool[0]! });
    }
    return { locales, defaultLocale, pairs };
  });
});

// ─── Property Test ───────────────────────────────────────────────────────────

describe('Feature: lumibase-docs-i18n, Property 3: Sidebar union completeness', () => {
  it('docTreeUnion contains exactly the union of all slugs across all locales', () => {
    fc.assert(
      fc.property(localeSlugPairsArb, ({ locales, defaultLocale, pairs }) => {
        // Create fixture
        const tmpDir = createFixture(pairs);
        tempDirs.push(tmpDir);

        // Build registry
        const registry = buildRegistry(tmpDir, {
          i18n: { locales, defaultLocale },
        });

        // Collect slugs from docTreeUnion
        const treeSlugs = collectSlugsFromTree(registry.docTreeUnion);

        // Collect union of all slugs from docSlugsByLocale
        const allLocaleSlugs = new Set<string>();
        for (const locale of locales) {
          const localeSlugs = registry.docSlugsByLocale[locale] ?? [];
          for (const s of localeSlugs) {
            allLocaleSlugs.add(s);
          }
        }

        // Property 3 (forward): every slug in docTreeUnion exists in at least one locale
        for (const slug of treeSlugs) {
          expect(allLocaleSlugs.has(slug)).toBe(true);
        }

        // Property 3 (reverse): every slug in any docSlugsByLocale[L] appears in docTreeUnion
        for (const slug of allLocaleSlugs) {
          expect(treeSlugs.has(slug)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});
