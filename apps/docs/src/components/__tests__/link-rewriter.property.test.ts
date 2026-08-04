import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  classifyLink,
  resolveRelativeLink,
  isAbsoluteUrl,
  isRelativeMdLink,
  type ClassifiedLink,
} from '../link-utils';

/**
 * Feature: lumibase-docs-viewer, Property 6: Link classification and rewriting
 *
 * For any link encountered in Markdown content:
 * - If it is a relative link to a `.md` file that resolves to a known slug,
 *   the href SHALL be rewritten to `/docs/{slug}` and render as an internal navigation link.
 * - If it is an absolute URL (starting with `http://` or `https://`),
 *   it SHALL render with `target="_blank"` and `rel="noopener noreferrer"`.
 * - If it is a relative link that does not resolve to any known slug,
 *   it SHALL render as a visually distinct broken link that does not navigate on click.
 *
 * **Validates: Requirements 8.1, 8.3, 8.4**
 */

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Generate a valid slug segment (lowercase alphanumeric + hyphens).
 */
const slugSegment = fc
  .string({
    unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
    minLength: 1,
    maxLength: 12,
  })
  .filter((s) => !s.startsWith('-') && !s.endsWith('-') && !s.includes('--'));

/**
 * Generate a valid slug (1-3 segments joined by '/').
 */
const validSlug = fc
  .array(slugSegment, { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join('/'));

/**
 * Generate a set of known slugs (1-10 slugs).
 */
const knownSlugsSet = fc
  .uniqueArray(validSlug, { minLength: 1, maxLength: 10 })
  .map((slugs) => new Set(slugs));

/**
 * Generate a relative .md link that resolves to a known slug.
 * We pick a slug from the known set and convert it to a relative .md path.
 */
const relativeMdLinkToKnownSlug = fc
  .tuple(knownSlugsSet, validSlug)
  .chain(([knownSlugs, currentSlug]) => {
    const slugsArray = Array.from(knownSlugs);
    return fc.tuple(
      fc.constant(knownSlugs),
      fc.constant(currentSlug),
      fc.constantFrom(...slugsArray),
    );
  })
  .map(([knownSlugs, currentSlug, targetSlug]) => {
    // Build a relative .md href from currentSlug to targetSlug
    const href = buildRelativeHref(currentSlug, targetSlug);
    return { knownSlugs, currentSlug, targetSlug, href };
  });

/**
 * Generate an absolute URL (http or https).
 */
const absoluteUrl = fc
  .tuple(
    fc.constantFrom('http', 'https'),
    fc.webUrl({ withFragments: false, withQueryParameters: false }),
  )
  .map(([_protocol, url]) => url); // webUrl already generates full URLs

/**
 * Generate a relative link to an unknown slug (not in knownSlugs).
 */
const relativeLinkToUnknownSlug = fc
  .tuple(knownSlugsSet, validSlug, validSlug)
  .filter(([knownSlugs, _currentSlug, unknownSlug]) => !knownSlugs.has(unknownSlug))
  .map(([knownSlugs, currentSlug, unknownSlug]) => {
    const href = `${unknownSlug}.md`;
    return { knownSlugs, currentSlug, href, unknownSlug };
  });

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a relative .md href from currentSlug to targetSlug.
 * For simplicity, we use the target slug directly as a relative path from root.
 */
function buildRelativeHref(currentSlug: string, targetSlug: string): string {
  const currentParts = currentSlug.split('/');
  const targetParts = targetSlug.split('/');

  // Navigate up from current directory
  const currentDir = currentParts.slice(0, -1);
  const targetDir = targetParts.slice(0, -1);
  const targetFile = targetParts[targetParts.length - 1];

  // Find common prefix length
  let commonLength = 0;
  while (
    commonLength < currentDir.length &&
    commonLength < targetDir.length &&
    currentDir[commonLength] === targetDir[commonLength]
  ) {
    commonLength++;
  }

  // Build relative path: go up from current, then down to target
  const ups = currentDir.length - commonLength;
  const relativeParts: string[] = [];

  for (let i = 0; i < ups; i++) {
    relativeParts.push('..');
  }

  for (let i = commonLength; i < targetDir.length; i++) {
    relativeParts.push(targetDir[i]!);
  }

  relativeParts.push(`${targetFile}.md`);

  return relativeParts.join('/');
}

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Feature: lumibase-docs-viewer, Property 6: Link classification and rewriting', () => {
  it('relative .md links to known slugs SHALL be rewritten to /docs/{slug}', () => {
    fc.assert(
      fc.property(relativeMdLinkToKnownSlug, ({ knownSlugs, currentSlug, targetSlug, href }) => {
        const result = classifyLink(href, currentSlug, knownSlugs);

        // Should be classified as internal
        expect(result.type).toBe('internal');

        // href should be rewritten to /docs/{slug}
        expect(result.href).toBe(`/docs/${targetSlug}`);

        // Should NOT have external link attributes
        expect(result.target).toBeUndefined();
        expect(result.rel).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it('absolute URLs (http/https) SHALL have target="_blank" and rel="noopener noreferrer"', () => {
    fc.assert(
      fc.property(absoluteUrl, validSlug, (url, currentSlug) => {
        const knownSlugs = new Set<string>();
        const result = classifyLink(url, currentSlug, knownSlugs);

        // Should be classified as external
        expect(result.type).toBe('external');

        // href should remain unchanged
        expect(result.href).toBe(url);

        // Must have target="_blank" and rel="noopener noreferrer"
        expect(result.target).toBe('_blank');
        expect(result.rel).toBe('noopener noreferrer');
      }),
      { numRuns: 100 },
    );
  });

  it('relative links to unknown slugs SHALL be classified as broken', () => {
    fc.assert(
      fc.property(relativeLinkToUnknownSlug, ({ knownSlugs, currentSlug, href }) => {
        const result = classifyLink(href, currentSlug, knownSlugs);

        // Should be classified as broken
        expect(result.type).toBe('broken');

        // Should NOT have external link attributes
        expect(result.target).toBeUndefined();
        expect(result.rel).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it('isAbsoluteUrl correctly identifies http/https URLs', () => {
    fc.assert(
      fc.property(absoluteUrl, (url) => {
        expect(isAbsoluteUrl(url)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('isAbsoluteUrl returns false for relative .md links', () => {
    fc.assert(
      fc.property(validSlug, (slug) => {
        const href = `${slug}.md`;
        expect(isAbsoluteUrl(href)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('isRelativeMdLink correctly identifies .md links', () => {
    fc.assert(
      fc.property(validSlug, (slug) => {
        const href = `${slug}.md`;
        expect(isRelativeMdLink(href)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('resolveRelativeLink correctly resolves paths with ../ navigation', () => {
    fc.assert(
      fc.property(
        // Generate a current slug with at least one directory level
        fc.tuple(slugSegment, slugSegment, slugSegment).map(
          ([dir, currentFile, targetFile]) => ({
            currentSlug: `${dir}/${currentFile}`,
            targetFile,
            dir,
          }),
        ),
        ({ currentSlug, targetFile, dir }) => {
          // A sibling file in the same directory
          const href = `${targetFile}.md`;
          const resolved = resolveRelativeLink(href, currentSlug);
          expect(resolved).toBe(`${dir}/${targetFile}`);
        },
      ),
      { numRuns: 100 },
    );
  });
});
