import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { deriveTitle, toTitleCase } from '../vite-plugin-docs-loader';

/**
 * Feature: lumibase-docs-viewer, Property 2: Title derivation correctness
 *
 * For any Doc File, if it contains a front matter `title` field, the display title
 * SHALL equal that field's value. If it does not contain a front matter `title` field,
 * the display title SHALL equal the filename with hyphens replaced by spaces and title case applied.
 *
 * **Validates: Requirements 2.3, 2.4**
 */
describe('Feature: lumibase-docs-viewer, Property 2: Title derivation correctness', () => {
  it('should return front matter title as-is when provided', () => {
    fc.assert(
      fc.property(
        // Generate non-empty front matter title strings
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        // Generate a filename for the filePath
        fc.stringMatching(/^[a-z][a-z0-9-]*$/).filter((s) => s.length >= 1),
        (frontMatterTitle, filename) => {
          const filePath = `${filename}.md`;
          const result = deriveTitle(frontMatterTitle, filePath);
          expect(result).toBe(frontMatterTitle);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should derive title from filename when no front matter title is provided', () => {
    fc.assert(
      fc.property(
        // Generate filenames: words separated by hyphens (simulating real doc filenames)
        fc
          .array(fc.stringMatching(/^[a-z][a-z0-9]*$/), {
            minLength: 1,
            maxLength: 5,
          })
          .map((parts) => parts.join('-')),
        (filename) => {
          const filePath = `${filename}.md`;
          const result = deriveTitle(undefined, filePath);

          // Expected: hyphens replaced by spaces, first letter of each word capitalized
          const expected = filename
            .replace(/-/g, ' ')
            .replace(/\b\w/g, (char) => char.toUpperCase());

          expect(result).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should apply toTitleCase correctly: hyphens become spaces, each word capitalized', () => {
    fc.assert(
      fc.property(
        // Generate hyphen-separated lowercase words
        fc
          .array(fc.stringMatching(/^[a-z][a-z0-9]*$/), {
            minLength: 1,
            maxLength: 5,
          })
          .map((parts) => parts.join('-')),
        (filename) => {
          const result = toTitleCase(filename);

          // No hyphens should remain
          expect(result).not.toContain('-');

          // Each word should start with an uppercase letter
          const words = result.split(' ');
          for (const word of words) {
            if (word.length > 0) {
              expect(word[0]).toBe(word[0]!.toUpperCase());
            }
          }

          // The number of spaces should equal the number of hyphens in the original
          const hyphenCount = (filename.match(/-/g) || []).length;
          const spaceCount = (result.match(/ /g) || []).length;
          expect(spaceCount).toBe(hyphenCount);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should handle filenames in subdirectories correctly', () => {
    fc.assert(
      fc.property(
        // Generate a directory path
        fc
          .array(fc.stringMatching(/^[a-z][a-z0-9]*$/), {
            minLength: 1,
            maxLength: 3,
          })
          .map((parts) => parts.join('/')),
        // Generate a filename
        fc
          .array(fc.stringMatching(/^[a-z][a-z0-9]*$/), {
            minLength: 1,
            maxLength: 3,
          })
          .map((parts) => parts.join('-'))
          // `index` is a special case (titled after its directory), covered
          // by its own test below — exclude it here.
          .filter((filename) => filename !== 'index'),
        (dirPath, filename) => {
          const filePath = `${dirPath}/${filename}.md`;
          const result = deriveTitle(undefined, filePath);

          // deriveTitle uses path.basename to extract filename, so only the filename part matters
          const expected = toTitleCase(filename);
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should title an index.md after its parent directory, not "Index"', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9-]*$/).filter((s) => s.length >= 1),
        (dir) => {
          const result = deriveTitle(undefined, `${dir}/index.md`);
          expect(result).toBe(toTitleCase(dir));
        },
      ),
      { numRuns: 100 },
    );
  });
});
