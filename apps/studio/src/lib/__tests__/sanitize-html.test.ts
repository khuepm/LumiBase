// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from '@/lib/sanitize-html';

/**
 * XSS regression tests for the Studio HTML sanitiser.
 *
 * Covers the Stored XSS vectors that reach the DOM via the WYSIWYG editor
 * (innerHTML) and the markdown preview (dangerouslySetInnerHTML).
 */
describe('sanitizeHtml', () => {
  it('strips <script> tags', () => {
    const out = sanitizeHtml('<p>hi</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).toContain('<p>hi</p>');
  });

  it('strips inline event handlers (onerror, onclick)', () => {
    const out = sanitizeHtml('<img src=x onerror="alert(1)"><b onclick="x()">b</b>');
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/onclick/i);
  });

  it('neutralises javascript: URLs in links', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toMatch(/javascript:/i);
  });

  it('neutralises javascript: URLs in image src', () => {
    const out = sanitizeHtml('<img src="javascript:alert(1)">');
    expect(out).not.toMatch(/javascript:/i);
  });

  it('keeps safe rich-text markup intact', () => {
    const out = sanitizeHtml(
      '<p><strong>bold</strong> <em>italic</em> <a href="https://example.com">link</a></p>',
    );
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('href="https://example.com"');
  });

  it('hardens target=_blank links against tabnabbing', () => {
    const out = sanitizeHtml('<a href="https://example.com" target="_blank">x</a>');
    expect(out).toMatch(/rel="[^"]*noopener/);
    expect(out).toMatch(/rel="[^"]*noreferrer/);
  });

  it('drops disallowed tags but keeps their text', () => {
    const out = sanitizeHtml('<iframe src="https://evil.test"></iframe><p>safe</p>');
    expect(out).not.toContain('<iframe');
    expect(out).toContain('<p>safe</p>');
  });

  it('handles empty / nullish input', () => {
    expect(sanitizeHtml('')).toBe('');
  });
});
