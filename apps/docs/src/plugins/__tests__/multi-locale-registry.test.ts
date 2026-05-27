import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildRegistry } from '../vite-plugin-docs-loader';

/**
 * Unit tests for multi-locale plugin registry.
 *
 * Validates: Requirements 1.1, 4.5, 7.5
 */

// ─── Fixture Setup ───────────────────────────────────────────────────────────

let fixtureDir: string;

/**
 * Create a temp directory with fixture files for 2 locales:
 * - en: README.md, features/ai-copilot.md (slug overlap + non-overlap)
 * - vi: features/ai-copilot.md (slug overlap only, no README)
 */
function createFixture(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-i18n-test-'));

  // en locale — has README and features/ai-copilot
  const enDir = path.join(tmpDir, 'en');
  fs.mkdirSync(enDir, { recursive: true });
  fs.writeFileSync(
    path.join(enDir, 'README.md'),
    '---\ntitle: Welcome\n---\n# Welcome to LumiBase\n',
  );

  const enFeaturesDir = path.join(enDir, 'features');
  fs.mkdirSync(enFeaturesDir, { recursive: true });
  fs.writeFileSync(
    path.join(enFeaturesDir, 'ai-copilot.md'),
    '---\ntitle: AI Copilot\n---\n# AI Copilot\n',
  );

  // vi locale — only has features/ai-copilot (no README)
  const viDir = path.join(tmpDir, 'vi');
  const viFeaturesDir = path.join(viDir, 'features');
  fs.mkdirSync(viFeaturesDir, { recursive: true });
  fs.writeFileSync(
    path.join(viFeaturesDir, 'ai-copilot.md'),
    '---\ntitle: AI Copilot (VI)\n---\n# AI Copilot tiếng Việt\n',
  );

  return tmpDir;
}

/**
 * Create a fixture with an empty vi locale (no files at all).
 */
function createFixtureEmptyVi(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-i18n-empty-'));

  // en locale — has README
  const enDir = path.join(tmpDir, 'en');
  fs.mkdirSync(enDir, { recursive: true });
  fs.writeFileSync(
    path.join(enDir, 'README.md'),
    '---\ntitle: Welcome\n---\n# Welcome\n',
  );

  // vi locale — empty directory
  const viDir = path.join(tmpDir, 'vi');
  fs.mkdirSync(viDir, { recursive: true });

  return tmpDir;
}

function removeFixture(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Multi-locale plugin registry', () => {
  let fixtureDirOverlap: string;
  let fixtureDirEmpty: string;

  beforeAll(() => {
    fixtureDirOverlap = createFixture();
    fixtureDirEmpty = createFixtureEmptyVi();
  });

  afterAll(() => {
    removeFixture(fixtureDirOverlap);
    removeFixture(fixtureDirEmpty);
  });

  describe('docIndexByLocale with slug overlap and non-overlap', () => {
    it('should index README under en but not under vi when vi has no README', () => {
      const registry = buildRegistry(fixtureDirOverlap, {
        i18n: { locales: ['en', 'vi'], defaultLocale: 'en' },
      });

      // en has README
      expect(registry.docIndexByLocale['en']!['README']).toBeDefined();
      expect(registry.docIndexByLocale['en']!['README']!.title).toBe('Welcome');

      // vi does NOT have README
      expect(registry.docIndexByLocale['vi']!['README']).toBeUndefined();
    });

    it('should index overlapping slug in both locales', () => {
      const registry = buildRegistry(fixtureDirOverlap, {
        i18n: { locales: ['en', 'vi'], defaultLocale: 'en' },
      });

      // Both locales have features/ai-copilot
      expect(registry.docIndexByLocale['en']!['features/ai-copilot']).toBeDefined();
      expect(registry.docIndexByLocale['vi']!['features/ai-copilot']).toBeDefined();

      // Verify locale field is correct
      expect(registry.docIndexByLocale['en']!['features/ai-copilot']!.locale).toBe('en');
      expect(registry.docIndexByLocale['vi']!['features/ai-copilot']!.locale).toBe('vi');
    });

    it('should have empty index for vi when vi locale folder is empty', () => {
      const registry = buildRegistry(fixtureDirEmpty, {
        i18n: { locales: ['en', 'vi'], defaultLocale: 'en' },
      });

      // en has README
      expect(registry.docIndexByLocale['en']!['README']).toBeDefined();

      // vi has nothing
      expect(Object.keys(registry.docIndexByLocale['vi']!)).toHaveLength(0);
      expect(registry.docIndexByLocale['vi']!['README']).toBeUndefined();
    });
  });

  describe('docTreeUnion contains slugs from all locales', () => {
    it('should include slugs that only exist in en', () => {
      const registry = buildRegistry(fixtureDirOverlap, {
        i18n: { locales: ['en', 'vi'], defaultLocale: 'en' },
      });

      // docTreeUnion should contain README (only in en) and features/ai-copilot (in both)
      const allSlugs = collectSlugsFromTree(registry.docTreeUnion);

      expect(allSlugs).toContain('README');
      expect(allSlugs).toContain('features/ai-copilot');
    });

    it('should include slugs from non-default locale even if not in default', () => {
      // Create a fixture where vi has a unique slug not in en
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-i18n-unique-'));
      const enDir = path.join(tmpDir, 'en');
      fs.mkdirSync(enDir, { recursive: true });
      fs.writeFileSync(path.join(enDir, 'README.md'), '# EN README\n');

      const viDir = path.join(tmpDir, 'vi');
      fs.mkdirSync(viDir, { recursive: true });
      fs.writeFileSync(path.join(viDir, 'gioi-thieu.md'), '# Giới thiệu\n');

      try {
        const registry = buildRegistry(tmpDir, {
          i18n: { locales: ['en', 'vi'], defaultLocale: 'en' },
        });

        const allSlugs = collectSlugsFromTree(registry.docTreeUnion);

        // Union should contain both en-only and vi-only slugs
        expect(allSlugs).toContain('README');
        expect(allSlugs).toContain('gioi-thieu');
      } finally {
        removeFixture(tmpDir);
      }
    });
  });

  describe('defaultLocale validation', () => {
    it('should throw when defaultLocale is not in locales', () => {
      expect(() =>
        buildRegistry(fixtureDirOverlap, {
          i18n: { locales: ['en', 'vi'], defaultLocale: 'zz' },
        }),
      ).toThrow(/defaultLocale "zz" is not in locales/);
    });

    it('should not throw when defaultLocale is in locales', () => {
      expect(() =>
        buildRegistry(fixtureDirOverlap, {
          i18n: { locales: ['en', 'vi'], defaultLocale: 'en' },
        }),
      ).not.toThrow();
    });
  });

  describe('docSlugsByLocale correctness', () => {
    it('should list slugs per locale accurately', () => {
      const registry = buildRegistry(fixtureDirOverlap, {
        i18n: { locales: ['en', 'vi'], defaultLocale: 'en' },
      });

      expect(registry.docSlugsByLocale['en']).toContain('README');
      expect(registry.docSlugsByLocale['en']).toContain('features/ai-copilot');
      expect(registry.docSlugsByLocale['vi']).toContain('features/ai-copilot');
      expect(registry.docSlugsByLocale['vi']).not.toContain('README');
    });
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Recursively collect all slugs from a DocNode tree.
 */
function collectSlugsFromTree(nodes: { type: string; slug?: string; children?: unknown[] }[]): string[] {
  const slugs: string[] = [];
  for (const node of nodes) {
    if (node.type === 'file' && node.slug) {
      slugs.push(node.slug);
    } else if (node.type === 'directory' && node.children) {
      slugs.push(...collectSlugsFromTree(node.children as typeof nodes));
    }
  }
  return slugs;
}
