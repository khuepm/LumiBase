import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  extractVariables,
  htmlToText,
  renderTemplate,
} from '../render';

/**
 * Render engine coverage:
 *   1. Escaped vs raw substitution.
 *   2. Layout {{content}} composition + layout-level vars.
 *   3. Missing-variable collection (no literal {{x}} left in output).
 *   4. Text fallback derived from HTML when bodyText absent.
 *   5. extractVariables helper.
 */

describe('renderTemplate', () => {
  it('HTML-escapes double-brace vars by default', () => {
    const out = renderTemplate(
      { subject: 'Hi {{name}}', bodyHtml: '<p>{{msg}}</p>' },
      null,
      { name: 'A&B', msg: '<script>x</script>' },
    );
    expect(out.subject).toBe('Hi A&amp;B');
    expect(out.html).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>');
    expect(out.missing).toEqual([]);
  });

  it('does not escape triple-brace (raw) vars', () => {
    const out = renderTemplate(
      { subject: 's', bodyHtml: '<div>{{{block}}}</div>' },
      null,
      { block: '<b>bold</b>' },
    );
    expect(out.html).toBe('<div><b>bold</b></div>');
  });

  it('composes the template body into the layout content slot', () => {
    const out = renderTemplate(
      { subject: 'Welcome', bodyHtml: '<p>Hello {{name}}</p>' },
      { html: '<html><body><h1>{{siteName}}</h1>{{content}}</body></html>' },
      { name: 'Sam', siteName: 'LumiBase' },
    );
    expect(out.html).toBe(
      '<html><body><h1>LumiBase</h1><p>Hello Sam</p></body></html>',
    );
  });

  it('collects missing variables and never leaves a literal placeholder', () => {
    const out = renderTemplate(
      { subject: '{{a}}', bodyHtml: '<p>{{b}} {{c}}</p>' },
      null,
      { a: 'x' },
    );
    expect(out.html).toBe('<p> </p>');
    expect(out.missing.sort()).toEqual(['b', 'c']);
  });

  it('derives a text fallback from HTML when bodyText is absent', () => {
    const out = renderTemplate(
      { subject: 's', bodyHtml: '<h1>Title</h1><p>Line one</p><p>Line two</p>' },
      null,
      {},
    );
    expect(out.text).toBe('Title\nLine one\nLine two');
  });

  it('uses an explicit bodyText (substituted) when provided', () => {
    const out = renderTemplate(
      { subject: 's', bodyHtml: '<p>{{x}}</p>', bodyText: 'plain {{x}}' },
      null,
      { x: 'V' },
    );
    expect(out.text).toBe('plain V');
  });
});

describe('extractVariables', () => {
  it('finds both double- and triple-brace names, excluding content', () => {
    const vars = extractVariables('{{a}} and {{{b}}}', '{{content}} {{a}} {{c}}');
    expect(vars.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('escapeHtml / htmlToText', () => {
  it('escapes the five sensitive chars', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('strips script/style and collapses block boundaries', () => {
    const text = htmlToText('<style>.x{}</style><p>A</p><p>B</p>');
    expect(text).toBe('A\nB');
  });
});
