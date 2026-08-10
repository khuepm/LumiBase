import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import path from 'node:path';
import { buildDocTree, type DocEntry, type DocNode } from '../vite-plugin-docs-loader';

/**
 * Feature: lumibase-docs-viewer, Property 1: Doc Tree structure and sorting invariant
 *
 * For any set of file paths under docs/, the built Doc Tree SHALL contain exactly
 * one node per file, nested according to directory structure, with directories
 * sorted alphabetically before files (also sorted alphabetically) at every level.
 *
 * Validates: Requirements 2.2, 2.5
 */

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Generate a valid path segment (directory or file name without extension).
 * Constrained to lowercase alphanumeric + hyphens to avoid OS-specific issues.
 */
const pathSegment = fc.string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), minLength: 1, maxLength: 12 }).filter((s) => !s.startsWith('-') && !s.endsWith('-') && !s.includes('--'));

/**
 * Generate a relative file path like "dir1/dir2/file.md".
 * Uses 0-3 directory levels and a filename.
 */
const relativeFilePath = fc.tuple(
  fc.array(pathSegment, { minLength: 0, maxLength: 3 }),
  pathSegment,
).map(([dirs, file]) => {
  const parts = [...dirs, `${file}.md`];
  return parts.join(path.sep);
});

/**
 * Generate a unique set of relative file paths (no duplicates).
 */
const uniqueFilePaths = fc.uniqueArray(relativeFilePath, {
  minLength: 1,
  maxLength: 20,
  comparator: (a, b) => a === b,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build DocEntry objects from a list of relative file paths.
 */
function buildDocEntries(filePaths: string[]): DocEntry[] {
  return filePaths.map((filePath) => {
    const slug = filePath.replace(/\.md$/, '').split(path.sep).join('/');
    return {
      slug,
      locale: 'en',
      title: path.basename(filePath, '.md'),
      filePath,
      content: '',
    };
  });
}

/**
 * Collect all file nodes from the tree (flattened).
 */
function collectFileNodes(nodes: DocNode[]): DocNode[] {
  const result: DocNode[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      result.push(node);
    } else if (node.children) {
      result.push(...collectFileNodes(node.children));
    }
  }
  return result;
}

/**
 * Verify sorting invariant at every level:
 * - All directory nodes come before file nodes
 * - Directories are sorted alphabetically by name
 * - Files are sorted alphabetically by name
 */
function verifySortingAtAllLevels(nodes: DocNode[]): boolean {
  // Find the boundary between directories and files
  let seenFile = false;
  const dirNames: string[] = [];
  const fileNames: string[] = [];

  for (const node of nodes) {
    if (node.type === 'directory') {
      if (seenFile) {
        // A directory appears after a file — violation
        return false;
      }
      dirNames.push(node.name);
    } else {
      seenFile = true;
      fileNames.push(node.name);
    }
  }

  // Check alphabetical sorting within directories
  for (let i = 1; i < dirNames.length; i++) {
    if (dirNames[i]!.localeCompare(dirNames[i - 1]!) < 0) {
      return false;
    }
  }

  // Check alphabetical sorting within files
  for (let i = 1; i < fileNames.length; i++) {
    if (fileNames[i]!.localeCompare(fileNames[i - 1]!) < 0) {
      return false;
    }
  }

  // Recurse into directory children
  for (const node of nodes) {
    if (node.type === 'directory' && node.children) {
      if (!verifySortingAtAllLevels(node.children)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Verify that a file path is correctly nested in the tree.
 * Walks the tree following directory segments and checks the file is at the leaf.
 */
function verifyNesting(tree: DocNode[], filePath: string, slug: string): boolean {
  const parts = filePath.split(path.sep);
  let currentLevel = tree;

  // Navigate through directory segments
  for (let i = 0; i < parts.length - 1; i++) {
    const dirName = parts[i]!;
    const dirNode = currentLevel.find(
      (n) => n.type === 'directory' && n.name === dirName,
    );
    if (!dirNode || !dirNode.children) {
      return false;
    }
    currentLevel = dirNode.children;
  }

  // Check the file node exists at the correct level
  const fileNode = currentLevel.find(
    (n) => n.type === 'file' && n.slug === slug,
  );
  return fileNode !== undefined;
}

// ─── Property Test ───────────────────────────────────────────────────────────

describe('Feature: lumibase-docs-viewer, Property 1: Doc Tree structure and sorting invariant', () => {
  it('should produce a tree with one node per file, correct nesting, and proper sorting', () => {
    fc.assert(
      fc.property(uniqueFilePaths, (filePaths) => {
        const entries = buildDocEntries(filePaths);
        const tree = buildDocTree(entries, '/fake/docs');

        // 1. Every file has exactly one corresponding node in the tree
        const fileNodes = collectFileNodes(tree);
        expect(fileNodes.length).toBe(filePaths.length);

        // Verify each slug appears exactly once
        const slugs = fileNodes.map((n) => n.slug).sort();
        const expectedSlugs = entries.map((e) => e.slug).sort();
        expect(slugs).toEqual(expectedSlugs);

        // 2. Files are nested according to their directory structure
        for (const entry of entries) {
          expect(verifyNesting(tree, entry.filePath, entry.slug)).toBe(true);
        }

        // 3 & 4. At every level, directories come before files,
        // and both are sorted alphabetically
        expect(verifySortingAtAllLevels(tree)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
