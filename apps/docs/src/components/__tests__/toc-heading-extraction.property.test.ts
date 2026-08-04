import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { extractHeadings, TocList } from '../TableOfContents';

/**
 * Feature: lumibase-docs-viewer, Property 4: ToC heading extraction
 *
 * For any rendered document, the Table of Contents SHALL contain exactly the H2
 * and H3 headings present in the document (in order), and SHALL NOT be rendered
 * when fewer than 2 such headings exist.
 *
 * **Validates: Requirements 6.1, 6.5**
 */

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Generate a valid heading ID (simulating rehype-slug output).
 * Lowercase alphanumeric + hyphens, non-empty.
 */
const headingId = fc
  .string({
    unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
    minLength: 1,
    maxLength: 20,
  })
  .filter((s) => !s.startsWith('-') && !s.endsWith('-') && !s.includes('--'));

/**
 * Generate heading text content (non-empty, trimmed).
 */
const headingText = fc
  .string({
    unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
    minLength: 1,
    maxLength: 30,
  })
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/**
 * A heading level from H1 to H6.
 */
const headingLevel = fc.integer({ min: 1, max: 6 });

/**
 * A single heading descriptor with level, id, and text.
 */
interface HeadingDescriptor {
  level: number;
  id: string;
  text: string;
}

const headingDescriptor: fc.Arbitrary<HeadingDescriptor> = fc.record({
  level: headingLevel,
  id: headingId,
  text: headingText,
});

/**
 * Generate a list of heading descriptors (0-20 headings with various levels).
 * IDs are made unique by appending an index suffix.
 */
const headingList = fc
  .array(headingDescriptor, { minLength: 0, maxLength: 20 })
  .map((headings) =>
    headings.map((h, i) => ({ ...h, id: `${h.id}-${i}` })),
  );

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a DOM container element with headings matching the descriptors.
 * Headings with level 2 or 3 get an `id` attribute (simulating rehype-slug).
 * Other heading levels (H1, H4, H5, H6) also get `id` attributes to verify
 * they are NOT extracted.
 */
function buildContainer(headings: HeadingDescriptor[]): Element {
  const container = document.createElement('div');

  for (const heading of headings) {
    const el = document.createElement(`h${heading.level}`);
    el.setAttribute('id', heading.id);
    el.textContent = heading.text;
    container.appendChild(el);

    // Add some paragraph content between headings (realistic document structure)
    const p = document.createElement('p');
    p.textContent = 'Some paragraph content.';
    container.appendChild(p);
  }

  return container;
}

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Feature: lumibase-docs-viewer, Property 4: ToC heading extraction', () => {
  it('SHALL extract exactly H2 and H3 headings in document order', () => {
    fc.assert(
      fc.property(headingList, (headings) => {
        const container = buildContainer(headings);
        const entries = extractHeadings(container);

        // Filter expected: only H2 and H3 headings
        const expectedHeadings = headings.filter((h) => h.level === 2 || h.level === 3);

        // Should have exactly the same count
        expect(entries.length).toBe(expectedHeadings.length);

        // Each entry should match the expected heading in order
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]!;
          const expected = expectedHeadings[i]!;

          expect(entry.id).toBe(expected.id);
          expect(entry.text).toBe(expected.text);
          expect(entry.level).toBe(expected.level);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('SHALL NOT include H1, H4, H5, or H6 headings', () => {
    fc.assert(
      fc.property(headingList, (headings) => {
        const container = buildContainer(headings);
        const entries = extractHeadings(container);

        // Every extracted entry must be level 2 or 3
        for (const entry of entries) {
          expect(entry.level === 2 || entry.level === 3).toBe(true);
        }

        // No entry should have an id from a non-H2/H3 heading
        const nonTocIds = new Set(
          headings.filter((h) => h.level !== 2 && h.level !== 3).map((h) => h.id),
        );
        for (const entry of entries) {
          expect(nonTocIds.has(entry.id)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('TocList SHALL return null when fewer than 2 headings exist', () => {
    fc.assert(
      fc.property(
        headingList.filter((headings) => {
          const tocHeadings = headings.filter((h) => h.level === 2 || h.level === 3);
          return tocHeadings.length < 2;
        }),
        (headings) => {
          const container = buildContainer(headings);
          const entries = extractHeadings(container);

          // Fewer than 2 entries means TocList should return null
          expect(entries.length).toBeLessThan(2);

          // Verify TocList returns null
          const result = TocList({ entries, activeId: null });
          expect(result).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('TocList SHALL render when 2 or more headings exist', () => {
    fc.assert(
      fc.property(
        headingList.filter((headings) => {
          const tocHeadings = headings.filter((h) => h.level === 2 || h.level === 3);
          return tocHeadings.length >= 2;
        }),
        (headings) => {
          const container = buildContainer(headings);
          const entries = extractHeadings(container);

          // 2 or more entries means TocList should NOT return null
          expect(entries.length).toBeGreaterThanOrEqual(2);

          // Verify TocList does not return null
          const result = TocList({ entries, activeId: null });
          expect(result).not.toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});
