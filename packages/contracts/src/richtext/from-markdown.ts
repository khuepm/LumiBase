import {
  RICHTEXT_VERSION,
  type RichTextAlign,
  type RichTextBlock,
  type RichTextDocument,
  type RichTextInline,
  type RichTextMark,
  type RichTextRef,
  type RichTextTableRow,
} from './model';
import { decodeEntities } from './html-tokenizer';
import type { RichTextPlugin } from './plugins';
import { sanitizeRichTextDocument } from './sanitize';
import { validateRichTextDocument } from './validate';
import { RICHTEXT_MD_CUSTOM_FENCE } from './to-markdown';
import { safeHref } from './url';
import { countTrailing, trimEndChars } from './trim';

/**
 * Markdown → document (#698): CommonMark blocks and inlines plus the GFM
 * extensions the model can hold (tables with alignment, strikethrough,
 * footnotes), `lumibase://` references and the fenced `lumibase-block` form
 * of custom blocks. It is the inverse of {@link richTextToMarkdown}: a
 * document exported to Markdown and parsed back compares equal for every
 * core block and mark.
 *
 * Raw HTML is not interpreted, except the inline tags the exporter itself
 * writes (`<u>`, `<sup>`, `<sub>`, `<br>`) and their common siblings; any
 * other markup stays literal text. Images without a LumiBase file reference
 * are dropped (keep media in the media library).
 */

export interface MarkdownImportOptions {
  /** `transformMarkdownImport` hooks run in order on the parsed blocks. */
  plugins?: readonly RichTextPlugin[];
}

// ── Block level ───────────────────────────────────────────────────────────────

const RE_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RE_HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RE_QUOTE = /^ {0,3}> ?/;
const RE_ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*)|$)/;
const RE_FOOTDEF = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?(.*)$/;
const RE_TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_CAPTION = /^ {0,3}Table:[ \t]*(.*?)[ \t]*$/;

function isBlank(l: string): boolean {
  for (let k = 0; k < l.length; k++) {
    const c = l.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Remove up to `n` columns of leading indentation (tabs count as 4). */
function dedent(line: string, n: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    if (line[i] === ' ') col += 1;
    else if (line[i] === '\t') col += 4;
    else break;
    i++;
  }
  return line.slice(i);
}

/** Whether `line` starts with at least `n` columns of indentation (tabs count as 4); reads at most `n` characters. */
function indentedBy(line: string, n: number): boolean {
  let col = 0;
  for (let k = 0; k < line.length && col < n; k++) {
    const c = line.charCodeAt(k);
    if (c === 32) col += 1;
    else if (c === 9) col += 4;
    else return false;
  }
  return col >= n;
}

function indentOf(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col += 1;
    else if (ch === '\t') col += 4;
    else break;
  }
  return col;
}

function startsBlock(line: string): boolean {
  if (RE_FENCE.test(line) || RE_ATX.test(line) || RE_HR.test(line) || RE_QUOTE.test(line)) return true;
  const item = RE_ITEM.exec(line);
  // An empty item, or an ordered item not starting at 1, does not interrupt a paragraph.
  if (item && item[4] !== undefined && item[4] !== '' && (!/\d/.test(item[2]!) || /^1[.)]$/.test(item[2]!))) return true;
  return false;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  const cells: string[] = [];
  let cur = '';
  let ticks = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length) {
      // Keep the escape for the inline parser, except an escaped pipe.
      cur += s[i + 1] === '|' ? '|' : ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === '`') ticks ^= 1;
    if (ch === '|' && ticks === 0) {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '' || !line.trim().endsWith('|')) cells.push(cur);
  return cells.map((c) => c.trim());
}

/** Container nesting past this is read as plain paragraphs (stack safety). */
const MAX_NESTING = 32;

class BlockParser {
  constructor(
    private readonly lines: string[],
    private readonly depth = 0,
  ) {}

  parse(): RichTextBlock[] {
    const out: RichTextBlock[] = [];
    const L = this.lines;
    let i = 0;
    while (i < L.length) {
      const line = L[i]!;
      if (isBlank(line)) {
        i++;
        continue;
      }

      // Fenced code / custom block.
      const fence = RE_FENCE.exec(line);
      if (fence && !(fence[2]![0] === '`' && fence[3]!.includes('`'))) {
        const [, ind, marker, info] = fence;
        const body: string[] = [];
        i++;
        while (i < L.length) {
          const close = new RegExp(`^ {0,3}${marker![0] === '`' ? '`' : '~'}{${marker!.length},}[ \\t]*$`);
          if (close.test(L[i]!)) {
            i++;
            break;
          }
          body.push(dedent(L[i]!, ind!.length));
          i++;
        }
        out.push(this.fenced(info!.trim(), body.join('\n')));
        continue;
      }

      const atx = RE_ATX.exec(line);
      if (atx) {
        out.push({
          type: 'heading',
          level: atx[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
          content: parseInline((atx[2] ?? '').trim()),
        });
        i++;
        continue;
      }

      if (RE_HR.test(line)) {
        out.push({ type: 'rule' });
        i++;
        continue;
      }

      if (this.depth < MAX_NESTING && RE_QUOTE.test(line)) {
        const body: string[] = [];
        while (i < L.length && !isBlank(L[i]!)) {
          if (RE_QUOTE.test(L[i]!)) body.push(L[i]!.replace(RE_QUOTE, ''));
          else if (body.length && !startsBlock(L[i]!)) body.push(L[i]!); // lazy continuation
          else break;
          i++;
        }
        out.push({ type: 'quote', content: new BlockParser(body, this.depth + 1).parse() });
        continue;
      }

      const foot = RE_FOOTDEF.exec(line);
      if (foot && this.depth < MAX_NESTING) {
        const body = [foot[2]!];
        i++;
        while (i < L.length) {
          const l = L[i]!;
          if (isBlank(l)) {
            // A blank line continues the note only if indented content follows.
            let j = i;
            while (j < L.length && isBlank(L[j]!)) j++;
            if (j < L.length && indentOf(L[j]!) >= 4) {
              for (; i < j; i++) body.push('');
              continue;
            }
            break;
          }
          if (indentOf(l) >= 4) body.push(dedent(l, 4));
          else if (!startsBlock(l) && !RE_FOOTDEF.test(l) && !isBlank(body[body.length - 1]!)) body.push(l);
          else break;
          i++;
        }
        out.push({ type: 'footnote', label: foot[1]!, content: new BlockParser(body, this.depth + 1).parse() });
        continue;
      }

      if (this.depth < MAX_NESTING && RE_ITEM.test(line)) {
        i = this.list(i, out);
        continue;
      }

      // Table: a row followed by a delimiter row with the same column count.
      if (line.includes('|') && i + 1 < L.length && RE_TABLE_DELIM.test(L[i + 1]!)) {
        const header = splitRow(line);
        const delim = splitRow(L[i + 1]!);
        if (header.length === delim.length) {
          i = this.table(i, header, delim, out);
          continue;
        }
      }

      // Indented code block.
      if (indentOf(line) >= 4) {
        const body: string[] = [];
        while (i < L.length && (isBlank(L[i]!) || indentOf(L[i]!) >= 4)) {
          body.push(dedent(L[i]!, 4));
          i++;
        }
        while (body.length && isBlank(body[body.length - 1]!)) body.pop();
        out.push({ type: 'code', text: body.join('\n') });
        continue;
      }

      // Paragraph (maybe a setext heading).
      const para: string[] = [];
      let setext: 1 | 2 | 0 = 0;
      while (i < L.length && !isBlank(L[i]!)) {
        const l = L[i]!;
        if (para.length) {
          const s = RE_SETEXT.exec(l);
          if (s) {
            setext = s[1]![0] === '=' ? 1 : 2;
            i++;
            break;
          }
          if (startsBlock(l) || RE_FOOTDEF.test(l)) break;
          if (l.includes('|') && i + 1 < L.length && RE_TABLE_DELIM.test(L[i + 1]!)) break;
        }
        para.push(l.replace(/^[ \t]+/, ''));
        i++;
      }
      const text = para.join('\n');
      const content = parseInline(trimEndChars(text, ' \t'));
      if (setext) out.push({ type: 'heading', level: setext, content });
      else out.push(paragraphOrEmbed(content));
    }
    return out;
  }

  fenced(info: string, body: string): RichTextBlock {
    const [word, ...rest] = info.split(/\s+/);
    if (word === RICHTEXT_MD_CUSTOM_FENCE && rest[0]) {
      try {
        const data: unknown = JSON.parse(body);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          return { type: 'custom', name: rest[0], data: data as Record<string, unknown> };
        }
      } catch {
        /* not ours after all: keep it as code */
      }
    }
    const language = word ? decodeEntities(word.replace(/\\(.)/g, '$1')) : '';
    return language ? { type: 'code', language, text: body } : { type: 'code', text: body };
  }

  list(start: number, out: RichTextBlock[]): number {
    const L = this.lines;
    const first = RE_ITEM.exec(L[start]!)!;
    const ordered = /\d/.test(first[2]!);
    const kind = ordered ? first[2]!.slice(-1) : first[2]!;
    const items: RichTextBlock[][] = [];
    let i = start;
    while (i < L.length) {
      const m = RE_ITEM.exec(L[i]!);
      if (!m) break;
      const isOrdered = /\d/.test(m[2]!);
      if (isOrdered !== ordered || (ordered ? m[2]!.slice(-1) : m[2]!) !== kind) break;
      const spaces = (m[3] ?? ' ').length;
      const pad = m[1]!.length + m[2]!.length + (spaces > 4 || m[4] === undefined ? 1 : spaces);
      const body: string[] = [m[4] ?? ''];
      i++;
      while (i < L.length) {
        const l = L[i]!;
        // Only the first `pad` columns decide membership; scanning the whole
        // indentation made deeply nested lists O(depth × input size) in scans.
        // An indented blank line joins the body: it yields no block, and a
        // following unindented line still ends the item (no lazy continuation
        // after a blank line).
        if (indentedBy(l, pad)) {
          body.push(dedent(l, pad));
          i++;
          continue;
        }
        if (isBlank(l)) {
          let j = i;
          while (j < L.length && isBlank(L[j]!)) j++;
          if (j < L.length && indentedBy(L[j]!, pad)) {
            for (; i < j; i++) body.push('');
            continue;
          }
          break;
        }
        if (!startsBlock(l) && !RE_ITEM.test(l) && !isBlank(body[body.length - 1]!)) {
          body.push(l); // lazy continuation of the item's paragraph
        } else {
          break;
        }
        i++;
      }
      items.push(new BlockParser(body, this.depth + 1).parse());
      // Blank lines between items keep the list going.
      let j = i;
      while (j < L.length && isBlank(L[j]!)) j++;
      if (j < L.length && RE_ITEM.test(L[j]!) && indentOf(L[j]!) < pad) i = j;
      else break;
    }
    const startNum = ordered ? Number.parseInt(first[2]!, 10) : 1;
    out.push({ type: 'list', ordered, ...(ordered && startNum !== 1 ? { start: startNum } : {}), items });
    return i;
  }

  table(start: number, header: string[], delim: string[], out: RichTextBlock[]): number {
    const L = this.lines;
    const align: Array<RichTextAlign | null> = delim.map((d) => {
      const l = d.startsWith(':');
      const r = d.endsWith(':');
      return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
    });
    const cols = header.length;
    const cell = (src: string): RichTextBlock[] => {
      const content = parseInline(src);
      return content.length ? [paragraphOrEmbed(content)] : [];
    };
    const row = (cells: string[], isHeader: boolean): RichTextTableRow => ({
      ...(isHeader ? { header: true } : {}),
      cells: Array.from({ length: cols }, (_, k) => cell(cells[k] ?? '')),
    });
    const rows: RichTextTableRow[] = [];
    // An all-empty header row is the exporter's stand-in for "no header row".
    if (header.some((h) => h !== '')) rows.push(row(header, true));
    let i = start + 2;
    while (i < L.length && !isBlank(L[i]!) && L[i]!.includes('|') && !startsBlock(L[i]!)) {
      rows.push(row(splitRow(L[i]!), false));
      i++;
    }
    const table: Extract<RichTextBlock, { type: 'table' }> = { type: 'table', rows };
    if (align.some((a) => a !== null)) table.align = align;
    // Pandoc-style caption line: `Table: caption {.header-column}`.
    let j = i;
    while (j < L.length && isBlank(L[j]!)) j++;
    const cap = j < L.length ? RE_CAPTION.exec(L[j]!) : null;
    if (cap) {
      let text = cap[1]!;
      if (/\{\.header-column\}$/.test(text)) {
        table.headerColumn = true;
        text = text.replace(/[ \t]*\{\.header-column\}$/, '');
      }
      const caption = inlineText(parseInline(text));
      if (caption) table.caption = caption;
      i = j + 1;
    }
    out.push(table);
    return i;
  }
}

function inlineText(nodes: RichTextInline[]): string {
  return nodes.map((n) => (n.type === 'text' ? n.text : n.type === 'link' || n.type === 'ref' ? inlineText(n.content) : '')).join('');
}

function paragraphOrEmbed(content: RichTextInline[]): RichTextBlock {
  if (content.length === 1 && content[0]!.type === 'embed') {
    const e = content[0] as Extract<RichTextInline, { type: 'embed' }>;
    return { type: 'embed', ref: e.ref, ...(e.alt ? { alt: e.alt } : {}) };
  }
  return { type: 'paragraph', content };
}

// ── Inline level ──────────────────────────────────────────────────────────────

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const HTML_MARK: Record<string, RichTextMark> = {
  u: 'underline',
  ins: 'underline',
  sup: 'superscript',
  sub: 'subscript',
  s: 'strike',
  del: 'strike',
  strike: 'strike',
  em: 'italic',
  i: 'italic',
  strong: 'bold',
  b: 'bold',
  code: 'code',
};

function parseRef(url: string): RichTextRef | null {
  const file = /^lumibase:\/\/file\/([^/?#]+)$/.exec(url);
  if (file) return { kind: 'file', id: decodeURIComponent(file[1]!) };
  const item = /^lumibase:\/\/item\/([^/?#]+)\/([^/?#]+)$/.exec(url);
  if (item) return { kind: 'item', collection: decodeURIComponent(item[1]!), id: decodeURIComponent(item[2]!) };
  return null;
}

/**
 * Per-string scan caches, so pathological input (thousands of unmatched `*`,
 * `[` or backticks) stays linear instead of rescanning the rest of the string
 * for every opener. A failed search from index `i` also fails from any later
 * index, so only the smallest failing start is remembered.
 */
interface ScanCache {
  codeFail: Map<number, number>;
  brackets: Map<number, number> | null;
  dest: Map<number, { url: string; end: number } | null>;
  closerFail: Map<string, number>;
  /** Inline HTML tag → smallest start index from which no matching close tag exists. */
  htmlCloseFail: Map<string, number>;
}
let scanCaches: Map<string, ScanCache> | null = null;

function cacheFor(s: string): ScanCache {
  const fresh = (): ScanCache => ({ codeFail: new Map(), brackets: null, dest: new Map(), closerFail: new Map(), htmlCloseFail: new Map() });
  if (!scanCaches) return fresh();
  let c = scanCaches.get(s);
  if (!c) {
    c = fresh();
    scanCaches.set(s, c);
  }
  return c;
}

const MAX_DEST = 2048;

/** The code span opening at `i`: its text and the index just past it, or null. */
function codeSpanEnd(s: string, i: number): { end: number; text: string } | null {
  let n = 0;
  while (s[i + n] === '`') n++;
  const cache = cacheFor(s);
  const failed = cache.codeFail.get(n);
  if (failed !== undefined && failed <= i) return null;
  let j = i + n;
  while (j < s.length) {
    const k = s.indexOf('`', j);
    if (k === -1) break;
    let m = 0;
    while (s[k + m] === '`') m++;
    if (m === n) {
      let text = s.slice(i + n, k).replace(/\n/g, ' ');
      if (text.length >= 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') text = text.slice(1, -1);
      return { end: k + m, text };
    }
    j = k + m;
  }
  cache.codeFail.set(n, Math.min(i, failed ?? i));
  return null;
}

/** Find the `]` matching the `[` at `i` (escapes and code spans respected). */
function closeBracket(s: string, i: number): number {
  const cache = cacheFor(s);
  if (!cache.brackets) {
    const matches = new Map<number, number>();
    const stack: number[] = [];
    for (let j = 0; j < s.length; j++) {
      const ch = s[j];
      if (ch === '\\') {
        j++;
        continue;
      }
      if (ch === '`') {
        const span = codeSpanEnd(s, j);
        if (span) {
          j = span.end - 1;
          continue;
        }
        while (s[j + 1] === '`') j++;
        continue;
      }
      if (ch === '[') stack.push(j);
      else if (ch === ']' && stack.length) matches.set(stack.pop()!, j);
    }
    cache.brackets = matches;
  }
  return cache.brackets.get(i) ?? -1;
}

/** Parse `(dest)` at `i`; returns the destination and the index after `)`. */
function linkDest(s: string, i: number): { url: string; end: number } | null {
  const cache = cacheFor(s);
  if (cache.dest.has(i)) return cache.dest.get(i)!;
  const result = parseDest(s, i);
  cache.dest.set(i, result);
  return result;
}

function parseDest(s: string, i: number): { url: string; end: number } | null {
  if (s[i] !== '(') return null;
  const limit = Math.min(s.length, i + MAX_DEST);
  let j = i + 1;
  while (s[j] === ' ') j++;
  // Scan indices only and slice once: building the URL char by char made
  // thousands of unclosed `(` quadratic in string concatenation.
  let raw: string;
  if (s[j] === '<') {
    const start = ++j;
    while (j < limit && s[j] !== '>') {
      const c = s.charCodeAt(j);
      if (c === 10 || c === 60) return null; // newline, `<`
      j += c === 92 && j + 1 < s.length ? 2 : 1; // backslash escape
    }
    if (s[j] !== '>') return null;
    raw = s.slice(start, j);
    j++;
  } else {
    const start = j;
    let depth = 0;
    while (j < limit) {
      const c = s.charCodeAt(j);
      if (c <= 32) break; // ASCII whitespace / controls end a bare destination
      if (c === 92 && j + 1 < s.length) {
        j += 2;
        continue;
      }
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    raw = s.slice(start, j);
  }
  const url = raw.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
  while (s[j] === ' ') j++;
  // Optional title: "…", '…' or (…) — parsed and discarded (the model has no link titles).
  if (s[j] === '"' || s[j] === "'" || (s[j] === '(' && url !== '')) {
    const close = s[j] === '(' ? ')' : s[j]!;
    const k = s.slice(j + 1, j + 1 + MAX_DEST).indexOf(close);
    if (k === -1) return null;
    j = j + 1 + k + 1;
    while (s[j] === ' ') j++;
  }
  if (s[j] !== ')') return null;
  return { url: decodeEntities(url), end: j + 1 };
}

const isWs = (c: string | undefined) => c === undefined || /\s/.test(c);
const isAlnum = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Find a closing delimiter run for `ch` × `n` starting the search at `from`. */
function findCloser(s: string, from: number, ch: string, n: number): number {
  const cache = cacheFor(s);
  const key = ch + n;
  const failed = cache.closerFail.get(key);
  if (failed !== undefined && failed <= from) return -1;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '`') {
      const span = codeSpanEnd(s, j);
      if (span) {
        j = span.end - 1;
        continue;
      }
      while (s[j + 1] === '`') j++;
      continue;
    }
    if (c === '[') {
      // Skip a whole link so a delimiter inside its URL is not taken.
      const close = closeBracket(s, j);
      if (close !== -1) {
        const dest = linkDest(s, close + 1);
        if (dest) {
          j = dest.end - 1;
          continue;
        }
      }
      continue;
    }
    if (c !== ch) continue;
    let run = 0;
    while (s[j + run] === ch) run++;
    const before = s[j - 1];
    const after = s[j + run];
    const rightFlanking = !isWs(before);
    const ok = rightFlanking && (ch !== '_' || !isAlnum(after)) && (ch === '~' ? run === n : run === n || (run >= 3 && run > n));
    if (ok && j > from) return j + run - n;
    j += run - 1;
  }
  cache.closerFail.set(key, Math.min(from, failed ?? from));
  return -1;
}

const INLINE_TAG = /^<(\/?)([a-z]+)\s*(\/?)>/i;

function findHtmlClose(s: string, from: number, tag: string): number {
  // No close tag after `from` means none after any later start either.
  const cache = cacheFor(s);
  const failed = cache.htmlCloseFail.get(tag);
  if (failed !== undefined && failed <= from) return -1;
  const found = scanHtmlClose(s, from, tag);
  if (found === -1) cache.htmlCloseFail.set(tag, Math.min(from, failed ?? from));
  return found;
}

function scanHtmlClose(s: string, from: number, tag: string): number {
  const open = new RegExp(`<${tag}\\s*>`, 'gi');
  const close = new RegExp(`</${tag}\\s*>`, 'gi');
  let depth = 1;
  let j = from;
  while (j < s.length) {
    close.lastIndex = j;
    open.lastIndex = j;
    const c = close.exec(s);
    if (!c) return -1;
    const o = open.exec(s);
    if (o && o.index < c.index) {
      depth++;
      j = o.index + o[0].length;
      continue;
    }
    if (--depth === 0) return c.index;
    j = c.index + c[0].length;
  }
  return -1;
}

let inlineDepth = 0;

function parseInline(src: string, marks: RichTextMark[] = []): RichTextInline[] {
  // Nested past MAX_NESTING, the rest of the run is literal text (stack safety).
  if (inlineDepth >= MAX_NESTING) return src ? [{ type: 'text', text: src, ...(marks.length ? { marks: [...marks] } : {}) }] : [];
  inlineDepth++;
  try {
    return parseInlineAt(src, marks);
  } finally {
    inlineDepth--;
  }
}

function parseInlineAt(src: string, marks: RichTextMark[]): RichTextInline[] {
  const out: RichTextInline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push(marks.length ? { type: 'text', text, marks: [...marks] } : { type: 'text', text });
    text = '';
  };
  const withMark = (m: RichTextMark[]) => [...new Set([...marks, ...m])];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    if (ch === '\\') {
      const next = src[i + 1];
      if (next === '\n') {
        flush();
        out.push({ type: 'break' });
        i += 2;
        continue;
      }
      if (next !== undefined && PUNCT.test(next)) {
        text += next;
        i += 2;
        continue;
      }
      text += ch;
      i++;
      continue;
    }

    if (ch === '\n') {
      // Two trailing spaces = hard break; otherwise keep the soft line break.
      if (countTrailing(text, ' ') >= 2) {
        text = trimEndChars(text, ' ');
        flush();
        out.push({ type: 'break' });
      } else {
        text = trimEndChars(text, ' ') + '\n';
      }
      i++;
      while (src[i] === ' ') i++;
      continue;
    }

    if (ch === '`') {
      const span = codeSpanEnd(src, i);
      if (span) {
        flush();
        out.push({ type: 'text', text: span.text, marks: withMark(['code']) });
        i = span.end;
        continue;
      }
      while (src[i] === '`') text += src[i++];
      continue;
    }

    if (ch === '&') {
      const m = /^&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,9}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(src.slice(i, i + 40));
      if (m) {
        text += decodeEntities(m[0]);
        i += m[0].length;
        continue;
      }
    }

    // Footnote reference `[^label]`.
    if (ch === '[' && src[i + 1] === '^') {
      const m = /^\[\^([^\]\s]+)\]/.exec(src.slice(i));
      if (m && src[i + m[0].length] !== ':') {
        flush();
        out.push({ type: 'footnote', label: m[1]! });
        i += m[0].length;
        continue;
      }
    }

    // Link / image.
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const image = ch === '!';
      const open = image ? i + 1 : i;
      const close = closeBracket(src, open);
      const dest = close !== -1 ? linkDest(src, close + 1) : null;
      if (dest) {
        const inner = src.slice(open + 1, close);
        const ref = parseRef(dest.url);
        flush();
        if (image) {
          const alt = inlineText(parseInline(inner));
          if (ref && ref.kind === 'file') out.push({ type: 'embed', ref, ...(alt ? { alt } : {}) });
          // External images are dropped (media lives in the library).
        } else if (ref) {
          if (inner.trim() === '') out.push({ type: 'embed', ref });
          else out.push({ type: 'ref', ref, content: parseInline(inner, marks) });
        } else {
          const content = parseInline(inner, marks);
          const href = safeHref(dest.url);
          if (href) out.push({ type: 'link', href, content });
          else out.push(...content);
        }
        i = dest.end;
        continue;
      }
    }

    // Autolink `<https://…>` / inline tags the exporter writes.
    if (ch === '<') {
      const auto = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(src.slice(i));
      if (auto) {
        const href = safeHref(auto[1]!);
        flush();
        const content: RichTextInline[] = [{ type: 'text', text: auto[1]!, ...(marks.length ? { marks: [...marks] } : {}) }];
        if (href) out.push({ type: 'link', href, content });
        else out.push(...content);
        i += auto[0].length;
        continue;
      }
      const tag = INLINE_TAG.exec(src.slice(i));
      if (tag) {
        const name = tag[2]!.toLowerCase();
        if (name === 'br' && !tag[1]) {
          flush();
          out.push({ type: 'break' });
          i += tag[0].length;
          continue;
        }
        const mark = HTML_MARK[name];
        if (mark && !tag[1] && !tag[3]) {
          const end = findHtmlClose(src, i + tag[0].length, name);
          if (end !== -1) {
            flush();
            out.push(...parseInline(src.slice(i + tag[0].length, end), withMark([mark])));
            i = end + `</${name}>`.length + (src.slice(end).match(/^<\/[a-z]+(\s*)>/i)?.[1]?.length ?? 0);
            continue;
          }
        }
      }
    }

    // Emphasis / strong / strikethrough.
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (src[i + run] === ch) run++;
      const after = src[i + run];
      const before = src[i - 1];
      const leftFlanking = !isWs(after) && (ch !== '_' || !isAlnum(before));
      if (leftFlanking) {
        const tries: Array<[number, RichTextMark[]]> =
          ch === '~'
            ? run === 2
              ? [[2, ['strike']]]
              : []
            : run >= 3
              ? [
                  [3, ['bold', 'italic']],
                  [2, ['bold']],
                  [1, ['italic']],
                ]
              : run === 2
                ? [
                    [2, ['bold']],
                    [1, ['italic']],
                  ]
                : [[1, ['italic']]];
        let matched = false;
        for (const [n, m] of tries) {
          const closer = findCloser(src, i + run, ch, n);
          if (closer !== -1) {
            // Opening delimiters beyond `n` stay literal text.
            text += ch.repeat(run - n);
            flush();
            out.push(...parseInline(src.slice(i + run, closer), withMark(m)));
            i = closer + n;
            matched = true;
            break;
          }
        }
        if (matched) continue;
      }
      text += ch.repeat(run);
      i += run;
      continue;
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

/** Parse Markdown into a sanitised document. */
export function markdownToRichText(markdown: string, opts: MarkdownImportOptions = {}): RichTextDocument {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  scanCaches = new Map();
  let content: RichTextBlock[];
  try {
    content = new BlockParser(lines).parse();
  } finally {
    scanCaches = null;
  }
  for (const p of opts.plugins ?? []) {
    if (!p.transformMarkdownImport) continue;
    // A hook is untrusted: its output is used only if it is a valid document.
    try {
      const next = p.transformMarkdownImport(content);
      if (validateRichTextDocument({ type: 'doc', version: RICHTEXT_VERSION, content: next }) === null) content = next;
    } catch {
      /* keep the content from before the failing hook */
    }
  }
  return sanitizeRichTextDocument({ type: 'doc', version: RICHTEXT_VERSION, content }).doc;
}
