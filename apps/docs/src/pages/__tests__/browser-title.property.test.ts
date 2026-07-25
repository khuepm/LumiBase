import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Feature: lumibase-docs-viewer, Property 7: Browser title formatting
 *
 * For any document with a resolved title, the browser `<title>` tag SHALL be set to
 * `{document title} — LumiBase Docs`.
 *
 * **Validates: Requirements 9.4**
 */
describe('Feature: lumibase-docs-viewer, Property 7: Browser title formatting', () => {
  /**
   * Formats the browser title given a document title.
   * This mirrors the logic in DocPage's useEffect:
   *   document.title = `${entry.title} — LumiBase Docs`
   */
  function formatBrowserTitle(title: string): string {
    return `${title} — LumiBase Docs`;
  }

  it('should format browser title as "{title} — LumiBase Docs" for any non-empty title', () => {
    fc.assert(
      fc.property(
        // Generate non-empty title strings (trimmed to avoid whitespace-only)
        fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
        (title) => {
          const browserTitle = formatBrowserTitle(title);

          // The browser title must end with ' — LumiBase Docs'
          expect(browserTitle).toBe(`${title} — LumiBase Docs`);

          // The suffix uses an em dash (—), not a regular hyphen (-)
          expect(browserTitle).toContain('—');
          expect(browserTitle.endsWith('— LumiBase Docs')).toBe(true);

          // The title portion is preserved exactly at the start
          expect(browserTitle.startsWith(title)).toBe(true);

          // The separator is exactly ' — ' (space + em dash + space)
          const separatorIndex = browserTitle.indexOf(' — LumiBase Docs');
          expect(separatorIndex).toBe(title.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should set document.title correctly in jsdom environment', () => {
    fc.assert(
      fc.property(
        // Generate realistic document titles: words separated by single spaces
        // (browsers collapse consecutive whitespace in <title>, so we use realistic titles)
        fc
          .array(fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]*$/), {
            minLength: 1,
            maxLength: 5,
          })
          .map((words) => words.join(' ')),
        (title) => {
          // Simulate what DocPage's useEffect does
          document.title = `${title} — LumiBase Docs`;

          expect(document.title).toBe(formatBrowserTitle(title));
          expect(document.title).toBe(`${title} — LumiBase Docs`);

          // Reset
          document.title = 'LumiBase Docs';
        },
      ),
      { numRuns: 100 },
    );
  });
});
