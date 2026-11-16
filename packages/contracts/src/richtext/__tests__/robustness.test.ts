import { describe, expect, it } from 'vitest';
import { htmlToRichText, isRichTextDocument, markdownToRichText, richTextToHtml, richTextToMarkdown, sanitizeHtml } from '../index';

/** Hostile shapes that make naive parsers quadratic or blow the stack. */
const PATHOLOGICAL: Record<string, string> = {
  'many <': '<'.repeat(50_000),
  'many unclosed tags': '<a '.repeat(20_000),
  'deep nesting': '<b>'.repeat(20_000) + 'x',
  'many [': '['.repeat(20_000),
  'unmatched *': '*a '.repeat(20_000),
  'many **': '**'.repeat(20_000),
  'many backticks': '` '.repeat(20_000),
  'unclosed link dests': '[x]('.repeat(10_000),
  'deep quotes': '> '.repeat(5_000) + 'x',
  'deep lists': Array.from({ length: 2_000 }, (_, i) => `${' '.repeat(i * 2)}- x`).join('\n'),
  'nested links': '['.repeat(5_000) + 'a' + '](b)'.repeat(5_000),
  'long table': '|a|\n|-|\n' + '|x|\n'.repeat(20_000),
  'many entities': '&#'.repeat(20_000),
  'tabs before a mark': `*a${'\t'.repeat(50_000)}x*`,
  'spaces mid-line': `a${' '.repeat(100_000)}b\nc`,
  'spaces mid-paragraph html': `<p>a${' '.repeat(100_000)}<b>b</b></p>`,
};

describe('robustness', () => {
  it.each(Object.entries(PATHOLOGICAL))('handles %s quickly', (_name, input) => {
    const started = Date.now();
    expect(typeof sanitizeHtml(input)).toBe('string');
    expect(Array.isArray(htmlToRichText(input).content)).toBe(true);
    expect(Array.isArray(markdownToRichText(input).content)).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('exports text with long whitespace runs inside marks in linear time', () => {
    const text = `a${'\t'.repeat(200_000)}x${' '.repeat(200_000)}`;
    const started = Date.now();
    const md = richTextToMarkdown({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: ['bold'] }] }] });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(md.startsWith('**a')).toBe(true);
    expect(md.trimEnd().endsWith('x**')).toBe(true);
  });

  it('survives random markup-ish noise (seeded fuzz)', () => {
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const atoms = ['<', '>', '/', '"', "'", '=', ' ', 'a', 'p', 'img', 'script', 'on', 'error', 'href', 'src', 'javascript', ':', '&', '#', ';', '*', '_', '[', ']', '(', ')', '`', '|', '-', '\n', '!', '\\', 'style', 'svg', '<!--', '-->', '--!>', '\t'];
    for (let n = 0; n < 400; n++) {
      let s = '';
      const len = 5 + Math.floor(rand() * 60);
      for (let i = 0; i < len; i++) s += atoms[Math.floor(rand() * atoms.length)];
      const clean = sanitizeHtml(s);
      expect(clean).not.toMatch(/<(script|svg|style|iframe)|\son[a-z]+=|href="\s*javascript:/i);
      expect(sanitizeHtml(clean)).toBe(clean);
      const fromHtml = htmlToRichText(s);
      const fromMd = markdownToRichText(s);
      expect(isRichTextDocument(fromHtml)).toBe(true);
      expect(isRichTextDocument(fromMd)).toBe(true);
      expect(richTextToHtml(fromHtml)).not.toMatch(/<script|(href|src)="\s*javascript:/i);
      expect(richTextToHtml(fromMd)).not.toMatch(/<script|href="javascript:/i);
    }
  });
});
