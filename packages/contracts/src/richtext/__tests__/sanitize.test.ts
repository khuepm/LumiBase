import { describe, expect, it } from 'vitest';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import {
  DEFAULT_HTML_POLICY,
  htmlToRichText,
  isRichTextDocument,
  richTextToHtml,
  safeHref,
  safeSrc,
  sanitizeHtml,
  sanitizeRichTextDocument,
  validateRichTextDocument,
  type RichTextDocument,
} from '../index';

type P5Node = DefaultTreeAdapterMap['childNode'];
type P5Element = DefaultTreeAdapterMap['element'];

/**
 * XSS corpus (#700). Each entry is run through the sanitiser, then parsed
 * with parse5 — a spec-compliant HTML parser that builds the same tree a
 * browser does — and the tree is checked for anything executable.
 */
const XSS_CORPUS: string[] = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<img src=x onerror=alert(1)>',
  '<img src="x" onerror="alert(1)">',
  '<svg onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<svg><style><img src=x onerror=alert(1)></style></svg>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="java&#x09;script:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058alert(1)">x</a>',
  '<a href="javascript&colon;alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="\\\\evil.example/x">x</a>',
  '<a href="http://ok.example" onclick="alert(1)">x</a>',
  '<a href="https://ok.example" style="position:fixed;inset:0">x</a>',
  '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
  '<img src="javascript:alert(1)">',
  '<iframe src="https://evil.example"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<style>@import "javascript:alert(1)";</style>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '<form action="javascript:alert(1)"><button>x</button></form>',
  '<input autofocus onfocus=alert(1)>',
  '<details open ontoggle=alert(1)>',
  '<body onload=alert(1)>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<base href="javascript:/">',
  '<link rel="stylesheet" href="https://evil.example/x.css">',
  '<!--><script>alert(1)</script>-->',
  '<!---><script>alert(1)</script>',
  '<!-- x --!><script>alert(1)</script>',
  '<!-- x --!><img src=x onerror=alert(1)>',
  '<!--[if gte IE 4]><script>alert(1)</script><![endif]-->',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<<script>script>alert(1)<</script>/script>',
  '<scr<script>ipt>alert(1)</script>',
  '"><script>alert(1)</script>',
  '<img """><script>alert(1)</script>">',
  '<p onmouseover="alert(1)">hover</p>',
  '<template><script>alert(1)</script></template>',
  '<textarea><script>alert(1)</script></textarea>',
  '<title><script>alert(1)</script></title>',
  '<xmp><script>alert(1)</script></xmp>',
  '<a href="https://ok.example" formaction="javascript:alert(1)">x</a>',
  '<table><td background="javascript:alert(1)">x</td></table>',
  '<p>a</p><plaintext><script>alert(1)</script>',
  '<a/href="javascript:alert(1)">x</a>',
  '<a href=javascript:alert(1)>x</a>',
  '<img src=x:alert(1) onerror=eval(src)>',
  '<a href="&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1)">x</a>',
  '<a href="\u0001javascript:alert(1)">x</a>',
  '<a href="java\u2028script:alert(1)">x</a>',
  '<code class="language-x onload=alert(1)">x</code>',
  '<div class="x" data-ref-id="a" data-evil="1" aria-hidden="true">x</div>',
  '<sup id="a" onanimationstart="alert(1)">x</sup>',
];

const ALLOWED = new Set(Object.keys(DEFAULT_HTML_POLICY.elements));

function walk(nodes: P5Node[], visit: (el: P5Element) => void): void {
  for (const n of nodes) {
    if ('tagName' in n) {
      visit(n);
      walk(n.childNodes, visit);
    }
  }
}

/** Every reason the parsed HTML could execute script or load something unsafe. */
function dangers(html: string): string[] {
  const out: string[] = [];
  walk(parseFragment(html).childNodes, (el) => {
    if (!ALLOWED.has(el.tagName)) out.push(`element <${el.tagName}>`);
    for (const a of el.attrs) {
      if (a.name.startsWith('on')) out.push(`event handler ${a.name}`);
      if (a.name === 'style' || a.name === 'srcdoc' || a.name === 'formaction' || a.name === 'background') out.push(`attr ${a.name}`);
      if ((a.name === 'href' || a.name === 'cite') && safeHref(a.value) === null) out.push(`href ${a.value}`);
      if (a.name === 'src' && safeSrc(a.value) === null) out.push(`src ${a.value}`);
      if (a.name.includes(':')) out.push(`namespaced attr ${a.name}`);
    }
  });
  return out;
}

describe('sanitizeHtml — XSS corpus', () => {
  it.each(XSS_CORPUS)('neutralises %s', (payload) => {
    const clean = sanitizeHtml(payload);
    expect(dangers(clean)).toEqual([]);
    expect(clean.toLowerCase()).not.toMatch(/<script|javascript:|onerror=|onload=/);
  });

  it('is idempotent', () => {
    for (const payload of XSS_CORPUS) {
      const once = sanitizeHtml(payload);
      expect(sanitizeHtml(once)).toBe(once);
    }
  });

  it('keeps allowed markup and closes what it opens', () => {
    expect(sanitizeHtml('<p>Hi <strong>there<em>!</p>')).toBe('<p>Hi <strong>there<em>!</em></strong></p>');
    expect(sanitizeHtml('<p>a</b></i>b</p>')).toBe('<p>ab</p>');
    expect(sanitizeHtml('<a href="https://x.example/?a=1&amp;b=2" title=t>x</a>')).toBe(
      '<a href="https://x.example/?a=1&amp;b=2" title="t">x</a>',
    );
    expect(sanitizeHtml('<table><thead><tr><th scope="col" colspan="2">H</th></tr></thead></table>')).toBe(
      '<table><thead><tr><th scope="col" colspan="2">H</th></tr></thead></table>',
    );
    expect(sanitizeHtml('<th scope="evil">x</th>')).toBe('<th>x</th>');
    expect(sanitizeHtml('<custom-el>kept text</custom-el>')).toBe('kept text');
  });

  it('ends comments where a browser does (`-->`, `--!>`, `<!-->`)', () => {
    expect(sanitizeHtml('<p>a<!-- c --!>b</p>')).toBe('<p>ab</p>');
    expect(sanitizeHtml('<p>a<!-->b</p>')).toBe('<p>ab</p>');
    expect(sanitizeHtml('<p>a<!--->b</p>')).toBe('<p>ab</p>');
    expect(sanitizeHtml('<p>a<!-- unterminated')).toBe('<p>a</p>');
  });

  it('drops the content of script-like elements, keeps the text of unknown ones', () => {
    expect(sanitizeHtml('<p>a<script>b</script>c</p>')).toBe('<p>ac</p>');
    expect(sanitizeHtml('<p>a<font color=red>b</font>c</p>')).toBe('<p>abc</p>');
  });
});

describe('URL allowlist', () => {
  it.each([
    ['https://example.com', 'https://example.com'],
    ['  http://example.com/x  ', 'http://example.com/x'],
    ['mailto:a@example.com', 'mailto:a@example.com'],
    ['tel:+84123', 'tel:+84123'],
    ['/relative/path', '/relative/path'],
    ['#anchor', '#anchor'],
    ['?q=1', '?q=1'],
    ['page.html', 'page.html'],
    ['//cdn.example/x', '//cdn.example/x'],
  ])('allows %s', (input, expected) => {
    expect(safeHref(input)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',
    'java\nscript:alert(1)',
    'java\u0000script:alert(1)',
    '\u00ADjavascript:alert(1)',
    'jav\u200Bascript:alert(1)',
    'vbscript:x',
    'data:text/html,x',
    'file:///etc/passwd',
    'blob:https://x/y',
    '\\\\evil.example',
    'javascript%3Aalert(1)',
    '',
    '   ',
  ])('refuses %j', (input) => {
    expect(safeHref(input)).toBeNull();
  });

  it('only allows http(s) and relative URLs for media', () => {
    expect(safeSrc('https://cdn.example/a.png')).toBe('https://cdn.example/a.png');
    expect(safeSrc('/assets/a.png')).toBe('/assets/a.png');
    expect(safeSrc('mailto:a@example.com')).toBeNull();
    expect(safeSrc('data:image/png;base64,AAAA')).toBeNull();
  });
});

describe('write-path document sanitisation', () => {
  const doc = (content: unknown): RichTextDocument => ({ type: 'doc', version: 1, content }) as RichTextDocument;

  it('unwraps unsafe links but keeps their text', () => {
    const { doc: out, changes } = sanitizeRichTextDocument(
      doc([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a ' },
            { type: 'link', href: 'javascript:alert(1)', content: [{ type: 'text', text: 'click' }] },
            { type: 'link', href: 'https://ok.example', content: [{ type: 'text', text: ' ok' }] },
          ],
        },
      ]),
    );
    expect(out.content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a click' },
          { type: 'link', href: 'https://ok.example', content: [{ type: 'text', text: ' ok' }] },
        ],
      },
    ]);
    expect(changes.map((c) => c.reason)).toContain('unsafe-link');
  });

  it('strips control characters and normalises marks', () => {
    const { doc: out } = sanitizeRichTextDocument(
      doc([{ type: 'paragraph', content: [{ type: 'text', text: 'a\u0000b\r\nc', marks: ['italic', 'bold', 'italic'] }] }]),
    );
    expect(out.content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'ab\nc', marks: ['bold', 'italic'] }] });
  });

  it('drops malformed code languages, custom block names and footnote labels', () => {
    const { doc: out } = sanitizeRichTextDocument(
      doc([
        { type: 'code', language: 'js" onload="x', text: 'x' },
        { type: 'custom', name: '<img>', data: {} },
        { type: 'custom', name: 'callout', data: { tone: 'info' } },
        { type: 'footnote', label: 'a b', content: [] },
      ]),
    );
    expect(out.content).toEqual([
      { type: 'code', text: 'x' },
      { type: 'custom', name: 'callout', data: { tone: 'info' } },
    ]);
  });

  it('is idempotent', () => {
    const once = sanitizeRichTextDocument(htmlToRichText('<p>a <b>b</b><b>c</b> <a href="javascript:x">d</a></p>')).doc;
    expect(sanitizeRichTextDocument(once).doc).toEqual(once);
    expect(sanitizeRichTextDocument(once).changes).toEqual([]);
  });
});

describe('validateRichTextDocument', () => {
  it('reports the path of the first problem', () => {
    expect(
      validateRichTextDocument({
        type: 'doc',
        version: 1,
        content: [{ type: 'list', ordered: false, items: [[{ type: 'paragraph', content: [{ type: 'text', text: 1 }] }]] }],
      }),
    ).toEqual({ path: ['content', 0, 'items', 0, 0, 'content', 0], message: '`text` must be a string.' });
    expect(validateRichTextDocument({ type: 'doc', version: 2, content: [] })?.path).toEqual(['version']);
    expect(validateRichTextDocument('<p>x</p>')?.path).toEqual([]);
  });

  it('enforces depth, node and text limits', () => {
    let deep: unknown = { type: 'paragraph', content: [] };
    for (let i = 0; i < 40; i++) deep = { type: 'quote', content: [deep] };
    expect(validateRichTextDocument({ type: 'doc', version: 1, content: [deep] })?.message).toMatch(/Nesting deeper/);

    const many = Array.from({ length: 10 }, () => ({ type: 'rule' }));
    const limits = { maxDepth: 32, maxNodes: 5, maxTextLength: 100 };
    expect(validateRichTextDocument({ type: 'doc', version: 1, content: many }, limits)?.message).toMatch(/more than 5 nodes/);
    const long = [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(101) }] }];
    expect(validateRichTextDocument({ type: 'doc', version: 1, content: long }, limits)?.message).toMatch(/longer than 100/);
  });

  it('accepts the additive v1 nodes', () => {
    expect(
      isRichTextDocument({
        type: 'doc',
        version: 1,
        content: [
          { type: 'table', caption: 'c', headerColumn: true, align: ['left', null], rows: [{ header: true, cells: [[], []] }] },
          { type: 'list', ordered: true, start: 3, items: [] },
          { type: 'paragraph', content: [{ type: 'footnote', label: '1' }] },
          { type: 'footnote', label: '1', content: [] },
          { type: 'embed', ref: { kind: 'file', id: 'f' }, alt: 'A cat' },
        ],
      }),
    ).toBe(true);
  });
});

describe('richTextToHtml — sanitised output', () => {
  it('passes plugin renderer output through the allowlist', () => {
    const html = richTextToHtml(
      { type: 'doc', version: 1, content: [{ type: 'custom', name: 'evil', data: { x: '<img src=x onerror=alert(1)>' } }] },
      {
        plugins: [
          {
            name: 'evil',
            blocks: {
              evil: { toHtml: (data) => `<p onclick="x">${String(data.x)}</p><script>alert(1)</script>` },
            },
          },
        ],
      },
    );
    expect(dangers(html)).toEqual([]);
    // The `<img>` survives (relative src) — its handler and the script do not.
    expect(html).toBe('<div data-block="evil"><p><img src="x"></p></div>');
  });

  it('a renderer that escapes keeps its markup', () => {
    const html = richTextToHtml(
      { type: 'doc', version: 1, content: [{ type: 'custom', name: 'callout', data: { text: '<b>hi</b>' } }] },
      {
        plugins: [
          { name: 'p', blocks: { callout: { toHtml: (data, ctx) => `<aside><p>${ctx.escape(String(data.text))}</p></aside>` } } },
        ],
      },
    );
    expect(html).toBe('<div data-block="callout"><aside><p>&lt;b&gt;hi&lt;/b&gt;</p></aside></div>');
  });

  it('never resolves a reference to an unsafe URL', () => {
    const html = richTextToHtml(
      {
        type: 'doc',
        version: 1,
        content: [
          { type: 'embed', ref: { kind: 'file', id: 'f' } },
          { type: 'paragraph', content: [{ type: 'ref', ref: { kind: 'item', collection: 'a', id: 'b' }, content: [{ type: 'text', text: 'x' }] }] },
        ],
      },
      { resolveRef: () => 'javascript:alert(1)' },
    );
    expect(dangers(html)).toEqual([]);
    expect(html).not.toContain('javascript');
  });
});

describe('htmlToRichText — paste is parsed, never stored as HTML', () => {
  it.each(XSS_CORPUS)('yields a safe document for %s', (payload) => {
    const doc = htmlToRichText(payload);
    expect(isRichTextDocument(doc)).toBe(true);
    const html = richTextToHtml(doc);
    expect(dangers(html)).toEqual([]);
    expect(JSON.stringify(doc)).not.toMatch(/javascript:|onerror/i);
  });
});

describe('sanitizeHtml — Object.prototype names are not allowlisted elements', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf'])('unwraps <%s> and does not throw on its attributes', (name) => {
    expect(sanitizeHtml(`<${name} a="b">text</${name}>`)).toBe('text');
  });
});
