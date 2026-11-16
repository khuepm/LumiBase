import { describe, expect, it } from 'vitest';
import {
  collectRichTextRefs,
  htmlToRichText,
  markdownToRichText,
  richTextToHtml,
  richTextToMarkdown,
  richTextToPlainText,
  sanitizeRichTextDocument,
  type RichTextBlock,
  type RichTextDocument,
} from '../index';

const doc = (...content: RichTextBlock[]): RichTextDocument => ({ type: 'doc', version: 1, content });
const p = (text: string): RichTextBlock => ({ type: 'paragraph', content: [{ type: 'text', text }] });

/** A document exercising every core block and mark. */
const KITCHEN_SINK = doc(
  { type: 'heading', level: 1, content: [{ type: 'text', text: 'Title <with> "quotes" & stuff' }] },
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Plain, ' },
      { type: 'text', text: 'bold', marks: ['bold'] },
      { type: 'text', text: ', ' },
      { type: 'text', text: 'italic', marks: ['italic'] },
      { type: 'text', text: ', ' },
      { type: 'text', text: 'both', marks: ['bold', 'italic'] },
      { type: 'text', text: ', ' },
      { type: 'text', text: 'under', marks: ['underline'] },
      { type: 'text', text: ', ' },
      { type: 'text', text: 'struck', marks: ['strike'] },
      { type: 'text', text: ', ' },
      { type: 'text', text: 'a `tick` code', marks: ['code'] },
      { type: 'text', text: ', H' },
      { type: 'text', text: '2', marks: ['subscript'] },
      { type: 'text', text: 'O, x' },
      { type: 'text', text: '2', marks: ['superscript'] },
      { type: 'text', text: ' and ' },
      { type: 'link', href: 'https://example.com/a_(b)?c=1&d=2', content: [{ type: 'text', text: 'a link' }] },
      { type: 'text', text: ' then ' },
      {
        type: 'ref',
        ref: { kind: 'item', collection: 'authors', id: 'a1' },
        content: [{ type: 'text', text: 'an author', marks: ['bold'] }],
      },
      { type: 'break' },
      { type: 'text', text: 'after a break: 1. not a list * not em _ nor _ # nor heading [nor](link) | pipe ~~ \\ end' },
      { type: 'footnote', label: 'n1' },
    ],
  },
  { type: 'heading', level: 3, content: [{ type: 'text', text: 'Lists' }] },
  {
    type: 'list',
    ordered: false,
    items: [
      [p('one')],
      [p('two'), { type: 'list', ordered: true, start: 3, items: [[p('three')], [p('four')]] }],
    ],
  },
  { type: 'list', ordered: true, items: [[p('first para'), p('second para')], [p('next')]] },
  { type: 'quote', content: [p('Quoted'), { type: 'quote', content: [p('nested')] }] },
  { type: 'code', language: 'ts', text: 'const a = 1 < 2;\n```\nfence inside' },
  { type: 'rule' },
  { type: 'embed', ref: { kind: 'file', id: 'hero' }, alt: 'A hero image' },
  { type: 'embed', ref: { kind: 'item', collection: 'cards', id: 'c1' } },
  {
    type: 'table',
    caption: 'Prices by plan',
    headerColumn: true,
    align: ['left', 'right'],
    rows: [
      { header: true, cells: [[p('Plan')], [p('Price')]] },
      { cells: [[p('Free')], [p('0')]] },
      { cells: [[p('Pro')], [{ type: 'paragraph', content: [{ type: 'text', text: '10', marks: ['bold'] }] }]] },
    ],
  },
  { type: 'footnote', label: 'n1', content: [p('The footnote text.')] },
);

describe('JSON → HTML → JSON', () => {
  it('is lossless for core blocks and marks', () => {
    const html = richTextToHtml(KITCHEN_SINK);
    expect(htmlToRichText(html)).toEqual(sanitizeRichTextDocument(KITCHEN_SINK).doc);
  });

  it('keeps refs as data attributes', () => {
    const html = richTextToHtml(KITCHEN_SINK, { resolveRef: (r) => (r.kind === 'file' ? `/assets/${r.id}` : null) });
    expect(html).toContain('<figure data-ref-kind="file" data-ref-id="hero"><img src="/assets/hero" alt="A hero image"></figure>');
    expect(htmlToRichText(html)).toEqual(sanitizeRichTextDocument(KITCHEN_SINK).doc);
  });
});

describe('JSON → Markdown → JSON', () => {
  it('is lossless for core blocks and marks', () => {
    const md = richTextToMarkdown(KITCHEN_SINK);
    expect(markdownToRichText(md)).toEqual(sanitizeRichTextDocument(KITCHEN_SINK).doc);
  });

  it('round-trips custom blocks through the fenced form', () => {
    const d = doc({ type: 'custom', name: 'callout', data: { tone: 'warn', text: 'Use ``` carefully' } });
    const md = richTextToMarkdown(d);
    expect(md).toMatch(/^````lumibase-block callout\n/);
    expect(markdownToRichText(md)).toEqual(d);
  });

  it('round-trips a header-less table and a table cell with a pipe and break', () => {
    const d = doc({
      type: 'table',
      rows: [
        { cells: [[p('a|b')], [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }, { type: 'break' }, { type: 'text', text: 'y' }] }]] },
        { cells: [[p('c')], []] },
      ],
    });
    expect(markdownToRichText(richTextToMarkdown(d))).toEqual(d);
  });
});

describe('Markdown import (GFM)', () => {
  it('parses tables with alignment and a header row', () => {
    const d = markdownToRichText('| Name | Qty |\n|:-----|----:|\n| Apple | 3 |\n| *Pear* | 5 |');
    expect(d.content).toEqual([
      {
        type: 'table',
        align: ['left', 'right'],
        rows: [
          { header: true, cells: [[p('Name')], [p('Qty')]] },
          { cells: [[p('Apple')], [p('3')]] },
          { cells: [[{ type: 'paragraph', content: [{ type: 'text', text: 'Pear', marks: ['italic'] }] }], [p('5')]] },
        ],
      },
    ]);
  });

  it('parses footnotes', () => {
    const d = markdownToRichText('Text[^1] and more[^note].\n\n[^1]: First.\n[^note]: Second\n    with a second paragraph line.');
    expect(d.content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Text' },
          { type: 'footnote', label: '1' },
          { type: 'text', text: ' and more' },
          { type: 'footnote', label: 'note' },
          { type: 'text', text: '.' },
        ],
      },
      { type: 'footnote', label: '1', content: [p('First.')] },
      { type: 'footnote', label: 'note', content: [p('Second\nwith a second paragraph line.')] },
    ]);
  });

  it('parses common CommonMark shapes', () => {
    const d = markdownToRichText(
      [
        'Setext',
        '======',
        '',
        '* a',
        '* b',
        '  continued',
        '',
        '1) x',
        '2) y',
        '',
        '> quote',
        'lazy',
        '',
        '    indented code',
        '',
        '***',
        '',
        '__strong__ and _em_ and snake_case_word and <https://auto.example> and ~~gone~~',
      ].join('\n'),
    );
    expect(d.content).toEqual([
      { type: 'heading', level: 1, content: [{ type: 'text', text: 'Setext' }] },
      { type: 'list', ordered: false, items: [[p('a')], [p('b\ncontinued')]] },
      { type: 'list', ordered: true, items: [[p('x')], [p('y')]] },
      { type: 'quote', content: [p('quote\nlazy')] },
      { type: 'code', text: 'indented code' },
      { type: 'rule' },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'strong', marks: ['bold'] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'em', marks: ['italic'] },
          { type: 'text', text: ' and snake_case_word and ' },
          { type: 'link', href: 'https://auto.example', content: [{ type: 'text', text: 'https://auto.example' }] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'gone', marks: ['strike'] },
        ],
      },
    ]);
  });

  it('drops unsafe links and external images, keeps text', () => {
    const d = markdownToRichText('[x](javascript:alert(1)) ![pic](https://evil.example/p.png) <javascript:alert(1)>');
    expect(JSON.stringify(d)).not.toMatch(/"href":"javascript|evil/);
    // The unsafe autolink stays as inert text.
    expect(d.content).toEqual([p('x  javascript:alert(1)')]);
  });

  it('runs plugin import hooks', () => {
    const d = markdownToRichText('!!! note\n\nhello', {
      plugins: [
        {
          name: 'admonition',
          transformMarkdownImport: (blocks) =>
            blocks.map((b) =>
              b.type === 'paragraph' && b.content[0]?.type === 'text' && b.content[0].text === '!!! note'
                ? { type: 'custom', name: 'callout', data: { tone: 'note' } }
                : b,
            ),
        },
      ],
    });
    expect(d.content[0]).toEqual({ type: 'custom', name: 'callout', data: { tone: 'note' } });
  });
});

describe('paste from Word / Google Docs', () => {
  it('reads Google Docs styles and ignores its font-weight:normal wrapper', () => {
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:700;">Bold</span><span style="font-weight:400;"> and </span><span style="font-style:italic;">italic</span><span style="text-decoration:underline;"> under</span></p><ul><li><p>one</p></li><ul><li><p>nested</p></li></ul><li><p>two</p></li></ul></b>';
    expect(htmlToRichText(html).content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Bold', marks: ['bold'] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'italic', marks: ['italic'] },
          { type: 'text', text: ' under', marks: ['underline'] },
        ],
      },
      {
        type: 'list',
        ordered: false,
        items: [[p('one'), { type: 'list', ordered: false, items: [[p('nested')]] }], [p('two')]],
      },
    ]);
  });

  it('turns Word list paragraphs into nested lists and drops Office markup', () => {
    const html = [
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{margin:0}</style></head><body>',
      '<p class=MsoNormal>Intro<o:p></o:p></p>',
      '<p class=MsoListParagraphCxSpFirst style="mso-list:l0 level1 lfo1"><![if !supportLists]><span style="mso-list:Ignore">1.<span style="font:7.0pt">&nbsp;&nbsp; </span></span><![endif]>First</p>',
      '<p class=MsoListParagraphCxSpMiddle style="mso-list:l0 level2 lfo1"><span style="mso-list:Ignore">a.<span>&nbsp;</span></span>Sub</p>',
      '<p class=MsoListParagraphCxSpLast style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">2.<span>&nbsp;</span></span>Second</p>',
      '<p class=MsoNormal><o:p>&nbsp;</o:p></p>',
      '<!--[if gte mso 9]><xml><w:WordDocument></w:WordDocument></xml><![endif]-->',
      '</body></html>',
    ].join('');
    expect(htmlToRichText(html).content).toEqual([
      p('Intro'),
      {
        type: 'list',
        ordered: true,
        items: [[p('First'), { type: 'list', ordered: true, items: [[p('Sub')]] }], [p('Second')]],
      },
    ]);
  });

  it('builds a semantic table from a pasted one', () => {
    const html =
      '<table><caption> Sales </caption><thead><tr><th>Region</th><th style="text-align:right">Total</th></tr></thead><tbody><tr><th>North</th><td>1</td></tr><tr><th>South</th><td>2</td></tr></tbody></table>';
    expect(htmlToRichText(html).content).toEqual([
      {
        type: 'table',
        caption: 'Sales',
        headerColumn: true,
        align: [null, 'right'],
        rows: [
          { header: true, cells: [[p('Region')], [p('Total')]] },
          { cells: [[p('North')], [p('1')]] },
          { cells: [[p('South')], [p('2')]] },
        ],
      },
    ]);
  });

  it('collapses whitespace like a browser', () => {
    expect(htmlToRichText('<p>  a \n  <b> b </b>  c  </p><div>loose <i>text</i></div>').content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a ' },
          { type: 'text', text: 'b ', marks: ['bold'] },
          { type: 'text', text: 'c' },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'loose ' }, { type: 'text', text: 'text', marks: ['italic'] }] },
    ]);
  });

  it('keeps <pre> text verbatim', () => {
    expect(htmlToRichText('<pre><code class="language-py">def f():\n    return  1\n</code></pre>').content).toEqual([
      { type: 'code', language: 'py', text: 'def f():\n    return  1' },
    ]);
  });
});

describe('semantic tables (#699)', () => {
  it('emits caption, thead, th scope=col / scope=row and alignment hooks', () => {
    const html = richTextToHtml(
      doc({
        type: 'table',
        caption: 'Prices',
        headerColumn: true,
        align: [null, 'right'],
        rows: [
          { header: true, cells: [[p('Plan')], [p('Price')]] },
          { cells: [[p('Free')], [p('0')]] },
        ],
      }),
    );
    expect(html).toBe(
      '<table><caption>Prices</caption><thead><tr><th scope="col">Plan</th><th scope="col" data-align="right">Price</th></tr></thead>' +
        '<tbody><tr><th scope="row">Free</th><td data-align="right">0</td></tr></tbody></table>',
    );
  });

  it('has no thead without a header row', () => {
    expect(richTextToHtml(doc({ type: 'table', rows: [{ cells: [[p('a')]] }] }))).toBe('<table><tbody><tr><td>a</td></tr></tbody></table>');
  });
});

describe('footnotes', () => {
  it('renders numbered references and an endnotes section with back-links', () => {
    const html = richTextToHtml(
      doc(
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'footnote', label: 'x' }, { type: 'footnote', label: 'x' }] },
        { type: 'footnote', label: 'x', content: [p('note')] },
      ),
    );
    expect(html).toContain('<sup id="fnref-x"><a href="#fn-x" class="footnote-ref" aria-describedby="footnotes-label">1</a></sup>');
    expect(html).toContain('<sup><a href="#fn-x" class="footnote-ref" aria-describedby="footnotes-label">1</a></sup>');
    expect(html).toContain('<li id="fn-x"><p>note</p> <a href="#fnref-x" class="footnote-backref" aria-label="Back to reference">');
  });
});

describe('plain text and refs', () => {
  it('flattens to one block per line', () => {
    expect(richTextToPlainText(doc(p('a'), { type: 'embed', ref: { kind: 'file', id: 'f' }, alt: 'cat' }))).toBe('a\ncat');
  });

  it('collects every reference once', () => {
    expect(collectRichTextRefs(KITCHEN_SINK)).toEqual([
      { kind: 'item', collection: 'authors', id: 'a1' },
      { kind: 'file', id: 'hero' },
      { kind: 'item', collection: 'cards', id: 'c1' },
    ]);
    expect(
      collectRichTextRefs(doc({ type: 'custom', name: 'gallery', data: { refs: [{ kind: 'file', id: 'g1' }, { kind: 'bad' }] } })),
    ).toEqual([{ kind: 'file', id: 'g1' }]);
  });
});

describe('Markdown import hooks are untrusted', () => {
  it('ignores a hook that returns an invalid document or throws', () => {
    const bad = markdownToRichText('hello', {
      plugins: [
        { name: 'bad', transformMarkdownImport: () => [{ type: 'script' } as unknown as RichTextBlock] },
        {
          name: 'throws',
          transformMarkdownImport: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    expect(bad.content).toEqual([p('hello')]);
  });
});
