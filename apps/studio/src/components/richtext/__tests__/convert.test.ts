import { describe, expect, it } from 'vitest';
import { sanitizeRichTextDocument, type RichTextBlock, type RichTextDocument } from '@lumibase/contracts/richtext';
import { editorJsonToRichText, richTextToEditorJson } from '../convert';
import { blockCommands, filterCommands, resolveFeatures } from '../commands';
import { clipboardToRichText, looksLikeMarkdown } from '../paste';

const p = (text: string): RichTextBlock => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: RichTextBlock[]): RichTextDocument => ({ type: 'doc', version: 1, content });

const SAMPLE = doc(
  { type: 'heading', level: 2, content: [{ type: 'text', text: 'Title' }] },
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'a ' },
      { type: 'text', text: 'bold link', marks: ['bold'] },
      { type: 'link', href: 'https://example.com', content: [{ type: 'text', text: 'site', marks: ['italic'] }, { type: 'text', text: ' x' }] },
      { type: 'ref', ref: { kind: 'item', collection: 'authors', id: 'a1' }, content: [{ type: 'text', text: 'Lan' }] },
      { type: 'break' },
      { type: 'embed', ref: { kind: 'file', id: 'f1' }, alt: 'inline' },
      { type: 'footnote', label: '1' },
    ],
  },
  { type: 'list', ordered: true, start: 4, items: [[p('one')], [p('two'), { type: 'list', ordered: false, items: [[p('nested')]] }]] },
  { type: 'quote', content: [p('q')] },
  { type: 'code', language: 'ts', text: 'let a = 1;\nlet b = 2;' },
  { type: 'rule' },
  { type: 'embed', ref: { kind: 'file', id: 'f2' }, alt: 'A cat' },
  {
    type: 'table',
    caption: 'Prices',
    headerColumn: true,
    align: [null, 'right'],
    rows: [
      { header: true, cells: [[p('Plan')], [p('Price')]] },
      { cells: [[p('Free')], [p('0')]] },
      { cells: [[p('Pro')], []] },
    ],
  },
  { type: 'footnote', label: '1', content: [p('Note.')] },
  { type: 'custom', name: 'callout', data: { tone: 'info' } },
);

describe('editor JSON ⇄ portable document', () => {
  it('round-trips every node the editor supports', () => {
    expect(editorJsonToRichText(richTextToEditorJson(SAMPLE))).toEqual(sanitizeRichTextDocument(SAMPLE).doc);
  });

  it('maps an empty value to one empty paragraph and back to an empty document', () => {
    const json = richTextToEditorJson(null);
    expect(json).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(editorJsonToRichText(json).content).toEqual([]);
  });

  it('marks header rows and the header column with tableHeader cells', () => {
    const table = richTextToEditorJson(SAMPLE).content!.find((n) => n.type === 'table')!;
    expect(table.content!.map((r) => r.content!.map((c) => c.type))).toEqual([
      ['tableHeader', 'tableHeader'],
      ['tableHeader', 'tableCell'],
      ['tableHeader', 'tableCell'],
    ]);
  });

  it('sanitises what the editor produces (unsafe links lose their href)', () => {
    const out = editorJsonToRichText({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }],
    });
    expect(out.content).toEqual([p('x')]);
  });
});

describe('commands', () => {
  it('only offers what the field allows', () => {
    const f = resolveFeatures({ headingLevels: [2, 3], blocks: ['heading', 'list'] });
    const ids = blockCommands(f, {}, new Map()).map((c) => c.id);
    expect(ids).toEqual(['paragraph', 'heading-2', 'heading-3', 'bullet-list', 'ordered-list']);
    expect(blockCommands(resolveFeatures({ blocks: [] }), {}, new Map()).map((c) => c.id)).toEqual(['paragraph']);
  });

  it('filters the slash menu by label and keywords', () => {
    const all = blockCommands(resolveFeatures({}), { insertEmbed: () => undefined, insertFootnote: () => undefined, insertItemRef: () => undefined }, new Map([['callout', { label: 'Callout' }]]));
    expect(filterCommands(all, 'tab').map((c) => c.id)).toEqual(['table']);
    expect(filterCommands(all, 'h2').map((c) => c.id)).toEqual(['heading-2']);
    expect(filterCommands(all, 'image').map((c) => c.id)).toEqual(['embed']);
    expect(filterCommands(all, 'call').map((c) => c.id)).toEqual(['custom:callout']);
    expect(filterCommands(all, 'zzz')).toEqual([]);
  });
});

describe('paste', () => {
  it('parses HTML into the model', () => {
    const d = clipboardToRichText({ html: '<p>a<script>alert(1)</script><a href="javascript:x">b</a></p>' });
    expect(d?.content).toEqual([p('ab')]);
  });

  it('imports Markdown-looking text and leaves other text to the editor', () => {
    expect(looksLikeMarkdown('# Title\n\ntext')).toBe(true);
    expect(looksLikeMarkdown('- a\n- b')).toBe(true);
    expect(looksLikeMarkdown('just a sentence. with - dashes')).toBe(false);
    expect(clipboardToRichText({ text: '## Hi' })?.content).toEqual([{ type: 'heading', level: 2, content: [{ type: 'text', text: 'Hi' }] }]);
    expect(clipboardToRichText({ text: 'plain' })).toBeNull();
    expect(clipboardToRichText({ text: '# not a heading in code', inCode: true })).toBeNull();
  });
});
