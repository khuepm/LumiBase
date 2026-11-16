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
import { tokenizeHtml } from './html-tokenizer';
import { sanitizeRichTextDocument } from './sanitize';
import { safeHref } from './url';
import { trimEndChars } from './trim';

/**
 * HTML → document (#700 / #696): the paste path (Word, Google Docs, web
 * pages) and HTML import. HTML is never stored: it is parsed into the
 * document model, which keeps only what the model can express — so styles,
 * scripts, event handlers, forms and unknown elements cannot survive — and the
 * result goes through {@link sanitizeRichTextDocument}.
 *
 * Images without a LumiBase reference (`data-ref-*`) are dropped: the model
 * only embeds files that live in the media library.
 */

interface El {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = El | { text: string };

const isEl = (n: Node): n is El => 'name' in n;

const MAX_TREE_DEPTH = 64;

const VOID = new Set(['br', 'hr', 'img', 'wbr', 'col', 'meta', 'link', 'input', 'source', 'base', 'area', 'param', 'track', 'embed']);
const DROP = new Set(['script', 'style', 'template', 'iframe', 'object', 'noscript', 'noembed', 'noframes', 'textarea', 'title', 'xmp', 'plaintext', 'svg', 'math', 'select', 'button', 'head', 'canvas', 'audio', 'video']);
const BLOCK = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'table', 'hr', 'figure',
  'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'dl', 'dt', 'dd', 'address', 'details', 'summary',
  'center', 'body', 'html', 'form', 'fieldset', 'caption', 'figcaption', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot',
]);
const CLOSES_P = new Set([...BLOCK].filter((n) => !['td', 'th', 'tr', 'thead', 'tbody', 'tfoot', 'caption', 'li', 'dt', 'dd'].includes(n)));

function buildTree(html: string): El {
  const root: El = { name: '#root', attrs: {}, children: [] };
  const stack: El[] = [root];
  const top = () => stack[stack.length - 1]!;
  const popTo = (i: number) => {
    stack.length = i;
  };
  let drop: string | null = null;
  let dropDepth = 0;

  for (const t of tokenizeHtml(html)) {
    if (drop) {
      if (t.kind === 'start' && t.name === drop && !t.selfClosing) dropDepth++;
      else if (t.kind === 'end' && t.name === drop && --dropDepth === 0) drop = null;
      continue;
    }
    if (t.kind === 'text') {
      top().children.push({ text: t.text });
      continue;
    }
    if (t.kind === 'start') {
      if (DROP.has(t.name)) {
        if (!t.selfClosing) {
          drop = t.name;
          dropDepth = 1;
        }
        continue;
      }
      // Implied end tags (the subset that matters for pasted content).
      if (CLOSES_P.has(t.name)) {
        const p = stack.map((e) => e.name).lastIndexOf('p');
        if (p > 0 && !stack.slice(p).some((e) => e.name === 'td' || e.name === 'th' || e.name === 'li')) popTo(p);
      }
      if (t.name === 'li') closeWithin(stack, 'li', ['ul', 'ol']);
      if (t.name === 'dt' || t.name === 'dd') closeWithin(stack, t.name === 'dt' ? 'dd' : 'dt', ['dl']) || closeWithin(stack, t.name, ['dl']);
      if (t.name === 'td' || t.name === 'th') closeWithin(stack, 'td', ['tr', 'table']) || closeWithin(stack, 'th', ['tr', 'table']);
      if (t.name === 'tr') closeWithin(stack, 'tr', ['table', 'thead', 'tbody', 'tfoot']);
      if (t.name === 'thead' || t.name === 'tbody' || t.name === 'tfoot') {
        closeWithin(stack, 'thead', ['table']) || closeWithin(stack, 'tbody', ['table']) || closeWithin(stack, 'tfoot', ['table']);
      }
      const el: El = { name: t.name, attrs: Object.fromEntries(t.attrs), children: [] };
      top().children.push(el);
      // Past MAX_TREE_DEPTH, elements stop nesting (their content flattens
      // into the current element) so hostile markup cannot exhaust the stack.
      if (!VOID.has(t.name) && !t.selfClosing && stack.length < MAX_TREE_DEPTH) stack.push(el);
      continue;
    }
    const at = stack.map((e) => e.name).lastIndexOf(t.name);
    if (at > 0) popTo(at);
  }
  return root;
}

/** Pop an open `name` element if it is open above the nearest `boundary`. */
function closeWithin(stack: El[], name: string, boundaries: string[]): boolean {
  for (let i = stack.length - 1; i > 0; i--) {
    const n = stack[i]!.name;
    if (n === name) {
      stack.length = i;
      return true;
    }
    if (boundaries.includes(n)) return false;
  }
  return false;
}

// ── Inline conversion ─────────────────────────────────────────────────────────

interface InlineCtx {
  marks: RichTextMark[];
  pre: boolean;
}

function styleOf(el: El): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of (el.attrs.style ?? '').split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim().toLowerCase();
  }
  return out;
}

function marksFor(el: El, current: RichTextMark[]): RichTextMark[] {
  const add = new Set(current);
  const remove = new Set<RichTextMark>();
  switch (el.name) {
    case 'strong':
    case 'b':
      add.add('bold');
      break;
    case 'em':
    case 'i':
    case 'cite':
    case 'dfn':
    case 'var':
      add.add('italic');
      break;
    case 'u':
    case 'ins':
      add.add('underline');
      break;
    case 's':
    case 'strike':
    case 'del':
      add.add('strike');
      break;
    case 'code':
    case 'kbd':
    case 'samp':
    case 'tt':
      add.add('code');
      break;
    case 'sup':
      add.add('superscript');
      break;
    case 'sub':
      add.add('subscript');
      break;
  }
  const st = styleOf(el);
  const weight = st['font-weight'];
  if (weight !== undefined) {
    if (weight === 'bold' || weight === 'bolder' || /^[6-9]00$/.test(weight)) add.add('bold');
    // Google Docs wraps a whole paste in `<b style="font-weight:normal">`.
    else if (weight === 'normal' || weight === 'lighter' || /^[1-5]00$/.test(weight)) remove.add('bold');
  }
  if (st['font-style'] === 'italic' || st['font-style'] === 'oblique') add.add('italic');
  else if (st['font-style'] === 'normal') remove.add('italic');
  const deco = `${st['text-decoration'] ?? ''} ${st['text-decoration-line'] ?? ''}`;
  if (/underline/.test(deco)) add.add('underline');
  if (/line-through/.test(deco)) add.add('strike');
  if (st['vertical-align'] === 'super') add.add('superscript');
  if (st['vertical-align'] === 'sub') add.add('subscript');
  for (const m of remove) add.delete(m);
  return [...add];
}

function refFrom(attrs: Record<string, string>): RichTextRef | null {
  const kind = attrs['data-ref-kind'];
  const id = attrs['data-ref-id'];
  if (!id || (kind !== 'item' && kind !== 'file')) return null;
  const collection = attrs['data-ref-collection'];
  if (kind === 'item') return collection ? { kind, collection, id } : null;
  return collection ? { kind, collection, id } : { kind, id };
}

function footnoteLabelFromHref(href: string | undefined): string | null {
  const m = /^#fn-(.+)$/.exec(href ?? '');
  return m ? m[1]! : null;
}

function textContent(n: Node): string {
  if (!isEl(n)) return n.text;
  if (n.name === 'br') return '\n';
  return n.children.map(textContent).join('');
}

function isWordListIgnore(el: El): boolean {
  return /mso-list\s*:\s*ignore/i.test(el.attrs.style ?? '');
}

function inlines(nodes: Node[], ctx: InlineCtx): RichTextInline[] {
  const out: RichTextInline[] = [];
  for (const n of nodes) {
    if (!isEl(n)) {
      const text = ctx.pre ? n.text : n.text.replace(/[ \t\n\r\f]+/g, ' ');
      if (text) out.push(ctx.marks.length ? { type: 'text', text, marks: [...ctx.marks] } : { type: 'text', text });
      continue;
    }
    if (isWordListIgnore(n)) continue;
    switch (n.name) {
      case 'br':
        out.push({ type: 'break' });
        continue;
      case 'img': {
        const ref = refFrom(n.attrs);
        if (ref) out.push({ type: 'embed', ref, ...(n.attrs.alt ? { alt: n.attrs.alt } : {}) });
        continue;
      }
      case 'a': {
        const ref = refFrom(n.attrs);
        const content = inlines(n.children, ctx);
        if (ref) {
          out.push({ type: 'ref', ref, content });
          continue;
        }
        const label = n.attrs.class?.split(/\s+/).includes('footnote-ref') ? footnoteLabelFromHref(n.attrs.href) : null;
        if (label) {
          out.push({ type: 'footnote', label });
          continue;
        }
        if (n.attrs.class?.split(/\s+/).includes('footnote-backref')) continue;
        const href = n.attrs.href !== undefined ? safeHref(n.attrs.href) : null;
        if (href) out.push({ type: 'link', href, content });
        else out.push(...content);
        continue;
      }
      case 'span':
      case 'div': {
        const ref = refFrom(n.attrs);
        if (ref) {
          const alt = n.attrs['data-ref-alt'];
          out.push({ type: 'embed', ref, ...(alt ? { alt } : {}) });
          continue;
        }
        break;
      }
      case 'sup': {
        if (n.attrs['data-footnote']) {
          out.push({ type: 'footnote', label: n.attrs['data-footnote'] });
          continue;
        }
        // `<sup><a class="footnote-ref">` — the sup is the footnote's wrapper, not a mark.
        const only = n.children.filter((c) => isEl(c) || c.text.trim() !== '');
        if (only.length === 1 && isEl(only[0]!) && only[0].name === 'a' && only[0].attrs.class?.split(/\s+/).includes('footnote-ref')) {
          out.push(...inlines(only, ctx));
          continue;
        }
        break;
      }
    }
    out.push(...inlines(n.children, { ...ctx, marks: marksFor(n, ctx.marks) }));
  }
  return out;
}

/** Trim the whitespace at the edges of a block's inline run and collapse seams. */
function tidy(nodes: RichTextInline[], pre: boolean): RichTextInline[] {
  if (pre) return nodes;
  const out = nodes.map((n) => ({ ...n })) as RichTextInline[];
  // Collapse a space across adjacent text nodes / after a break.
  let prevEndsSpace = true;
  for (const n of out) {
    if (n.type === 'text') {
      if (prevEndsSpace) n.text = n.text.replace(/^ +/, '');
      if (n.text !== '') prevEndsSpace = n.text.endsWith(' ');
    } else if (n.type === 'break') {
      prevEndsSpace = true;
    } else if (n.type === 'link' || n.type === 'ref') {
      n.content = tidyInner(n.content, prevEndsSpace);
      const last = lastText(n.content);
      prevEndsSpace = last ? last.endsWith(' ') : prevEndsSpace;
    } else {
      prevEndsSpace = false;
    }
  }
  // Trailing whitespace at the end of the block and before breaks.
  for (let i = out.length - 1; i >= 0; i--) {
    const n = out[i]!;
    const next = out[i + 1];
    if (n.type === 'text' && (next === undefined || next.type === 'break')) n.text = trimEndChars(n.text, ' ');
  }
  return out;
}

function tidyInner(nodes: RichTextInline[], leadingSpace: boolean): RichTextInline[] {
  let prev = leadingSpace;
  return nodes.map((n) => {
    if (n.type !== 'text') {
      prev = n.type === 'break';
      return n;
    }
    const text = prev ? n.text.replace(/^ +/, '') : n.text;
    if (text !== '') prev = text.endsWith(' ');
    return { ...n, text };
  });
}

function lastText(nodes: RichTextInline[]): string | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!;
    if (n.type === 'text' && n.text !== '') return n.text;
  }
  return null;
}

function hasVisible(nodes: RichTextInline[]): boolean {
  return nodes.some((n) =>
    n.type === 'text' ? n.text.replace(/[\s\u00A0]/g, '') !== '' : n.type === 'link' || n.type === 'ref' ? hasVisible(n.content) : true,
  );
}

// ── Block conversion ──────────────────────────────────────────────────────────

function wordListInfo(el: El): { level: number; ordered: boolean } | null {
  if (el.name !== 'p') return null;
  const style = el.attrs.style ?? '';
  const isList = /MsoListParagraph/i.test(el.attrs.class ?? '') || /mso-list\s*:\s*l\d+/i.test(style);
  if (!isList) return null;
  const level = Number(/level(\d+)/i.exec(style)?.[1] ?? '1');
  let marker = '';
  const findIgnore = (n: Node): boolean => {
    if (!isEl(n)) return false;
    if (isWordListIgnore(n)) {
      marker = textContent(n).trim();
      return true;
    }
    return n.children.some(findIgnore);
  };
  el.children.some(findIgnore);
  const ordered = /^(\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)[.)]/.test(marker);
  return { level: Math.max(1, Math.min(9, level)), ordered };
}

function buildWordList(entries: Array<{ level: number; ordered: boolean; blocks: RichTextBlock[] }>): RichTextBlock {
  const root: Extract<RichTextBlock, { type: 'list' }> = { type: 'list', ordered: entries[0]!.ordered, items: [] };
  const lists: Array<Extract<RichTextBlock, { type: 'list' }>> = [root];
  for (const e of entries) {
    while (lists.length > e.level) lists.pop();
    while (lists.length < e.level) {
      const parent = lists[lists.length - 1]!;
      if (parent.items.length === 0) parent.items.push([]);
      const nested: Extract<RichTextBlock, { type: 'list' }> = { type: 'list', ordered: e.ordered, items: [] };
      parent.items[parent.items.length - 1]!.push(nested);
      lists.push(nested);
    }
    lists[lists.length - 1]!.items.push(e.blocks);
  }
  return root;
}

function headerCell(n: Node): boolean {
  return isEl(n) && n.name === 'th';
}

function tableFrom(el: El): RichTextBlock {
  const rows: RichTextTableRow[] = [];
  let caption = '';
  const align: Array<RichTextAlign | null> = [];
  let firstColHeaders = 0;
  let bodyRows = 0;
  const visitRows = (n: El, inHead: boolean) => {
    for (const c of n.children) {
      if (!isEl(c)) continue;
      if (c.name === 'caption') caption = textContent(c).replace(/\s+/g, ' ').trim();
      else if (c.name === 'thead') visitRows(c, true);
      else if (c.name === 'tbody' || c.name === 'tfoot') visitRows(c, false);
      else if (c.name === 'tr') {
        const cellEls = c.children.filter((x): x is El => isEl(x) && (x.name === 'td' || x.name === 'th'));
        const header = inHead || (cellEls.length > 0 && cellEls.every(headerCell) && rows.every((r) => r.header));
        if (rows.length === 0 || header) {
          cellEls.forEach((cell, i) => {
            const a = (cell.attrs['data-align'] ?? cell.attrs.align ?? styleOf(cell)['text-align'] ?? '').toLowerCase();
            if (align[i] === undefined) align[i] = a === 'left' || a === 'center' || a === 'right' ? a : null;
          });
        }
        if (!header) {
          bodyRows++;
          if (cellEls[0] && headerCell(cellEls[0]) && cellEls.length > 1) firstColHeaders++;
        }
        rows.push({ ...(header ? { header: true } : {}), cells: cellEls.map((cell) => blocks(cell.children)) });
      }
    }
  };
  visitRows(el, false);
  return {
    type: 'table',
    rows,
    ...(caption ? { caption } : {}),
    ...(bodyRows > 0 && firstColHeaders === bodyRows ? { headerColumn: true } : {}),
    ...(align.some((a) => a) ? { align: align.map((a) => a ?? null) } : {}),
  };
}

function listFrom(el: El): RichTextBlock {
  const ordered = el.name === 'ol';
  const start = ordered && el.attrs.start !== undefined ? Number.parseInt(el.attrs.start, 10) : undefined;
  const items: RichTextBlock[][] = [];
  let loose: Node[] = [];
  const flushLoose = () => {
    if (loose.length === 0) return;
    const b = blocks(loose);
    loose = [];
    if (b.length === 0) return;
    // A list nested directly in a list (Google Docs) belongs to the previous item.
    if (items.length > 0) items[items.length - 1]!.push(...b);
    else items.push(b);
  };
  for (const c of el.children) {
    if (isEl(c) && c.name === 'li') {
      flushLoose();
      items.push(blocks(c.children));
    } else {
      loose.push(c);
    }
  }
  flushLoose();
  return {
    type: 'list',
    ordered,
    ...(start !== undefined && Number.isInteger(start) && start >= 0 && start !== 1 ? { start } : {}),
    items,
  };
}

function codeFrom(el: El): RichTextBlock {
  const codeEl = el.children.find((c): c is El => isEl(c) && c.name === 'code');
  const cls = `${codeEl?.attrs.class ?? ''} ${el.attrs.class ?? ''}`;
  const language = /(?:^|\s)(?:language|lang)-([A-Za-z0-9_+#.-]+)/.exec(cls)?.[1];
  const text = textContent(el).replace(/\n$/, '');
  return language ? { type: 'code', language, text } : { type: 'code', text };
}

function footnotesFrom(el: El): RichTextBlock[] {
  const out: RichTextBlock[] = [];
  const visit = (n: El) => {
    for (const c of n.children) {
      if (!isEl(c)) continue;
      if (c.name === 'li' && /^fn-/.test(c.attrs.id ?? '')) {
        out.push({ type: 'footnote', label: c.attrs.id!.slice(3), content: blocks(c.children) });
      } else if (c.name !== 'h2') {
        visit(c);
      }
    }
  };
  visit(el);
  return out;
}

function blocks(nodes: Node[]): RichTextBlock[] {
  const out: RichTextBlock[] = [];
  let run: Node[] = [];
  let wordList: Array<{ level: number; ordered: boolean; blocks: RichTextBlock[] }> = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const content = tidy(inlines(run, { marks: [], pre: false }), false);
    run = [];
    if (hasVisible(content)) out.push(paragraphOrEmbed(content));
  };
  const flushWord = () => {
    if (wordList.length) out.push(buildWordList(wordList));
    wordList = [];
  };

  for (const n of nodes) {
    if (isEl(n)) {
      const word = wordListInfo(n);
      if (word) {
        flushRun();
        const content = tidy(inlines(n.children, { marks: [], pre: false }), false);
        wordList.push({ ...word, blocks: hasVisible(content) ? [{ type: 'paragraph', content }] : [] });
        continue;
      }
    }
    // An inline wrapper around blocks (Google Docs' `<b id="docs-internal-guid">`)
    // is transparent: its blocks are read as blocks.
    if (isEl(n) && !BLOCK.has(n.name) && hasBlockDescendant(n)) {
      flushRun();
      flushWord();
      out.push(...blocks(n.children));
      continue;
    }
    if (!isEl(n) || !BLOCK.has(n.name)) {
      if (!isEl(n) && n.text.trim() === '' && run.length === 0) continue;
      flushWord();
      run.push(n);
      continue;
    }
    flushRun();
    flushWord();
    const ref = refFrom(n.attrs);
    if (ref && (n.name === 'div' || n.name === 'figure')) {
      const img = n.children.find((c): c is El => isEl(c) && c.name === 'img');
      const alt = img?.attrs.alt || n.attrs['data-ref-alt'];
      out.push({ type: 'embed', ref, ...(alt ? { alt } : {}) });
      continue;
    }
    if (n.name === 'div' && n.attrs['data-block']) {
      out.push({ type: 'custom', name: n.attrs['data-block'], data: customData(n.attrs['data-lb-data']) });
      continue;
    }
    // The Studio editor's footnote definition (`<aside data-footnote>`).
    if (n.name === 'aside' && n.attrs['data-footnote']) {
      out.push({ type: 'footnote', label: n.attrs['data-footnote'], content: blocks(n.children) });
      continue;
    }
    switch (n.name) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        out.push({
          type: 'heading',
          level: Number(n.name[1]) as 1 | 2 | 3 | 4 | 5 | 6,
          content: tidy(inlines(n.children, { marks: [], pre: false }), false),
        });
        break;
      case 'p': {
        const inner = blocks(n.children);
        out.push(...inner);
        break;
      }
      case 'blockquote':
        out.push({ type: 'quote', content: blocks(n.children) });
        break;
      case 'ul':
      case 'ol':
        out.push(listFrom(n));
        break;
      case 'pre':
        out.push(codeFrom(n));
        break;
      case 'hr':
        out.push({ type: 'rule' });
        break;
      case 'table':
        out.push(tableFrom(n));
        break;
      case 'section':
        if (n.attrs.class?.split(/\s+/).includes('footnotes')) {
          out.push(...footnotesFrom(n));
          break;
        }
        out.push(...blocks(n.children));
        break;
      default:
        out.push(...blocks(n.children));
    }
  }
  flushRun();
  flushWord();
  return out;
}

function hasBlockDescendant(el: El): boolean {
  return el.children.some((c) => isEl(c) && (BLOCK.has(c.name) || wordListInfo(c) !== null || hasBlockDescendant(c)));
}

/** Custom block data carried in `data-lb-data` (editor copy/paste); anything but a JSON object is `{}`. */
function customData(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A paragraph holding only an embed is a block embed. */
function paragraphOrEmbed(content: RichTextInline[]): RichTextBlock {
  const visible = content.filter((n) => !(n.type === 'text' && n.text.trim() === ''));
  if (visible.length === 1 && visible[0]!.type === 'embed') {
    const e = visible[0] as Extract<RichTextInline, { type: 'embed' }>;
    return { type: 'embed', ref: e.ref, ...(e.alt ? { alt: e.alt } : {}) };
  }
  return { type: 'paragraph', content };
}

/** Parse an HTML fragment (pasted or imported) into a sanitised document. */
export function htmlToRichText(html: string): RichTextDocument {
  const tree = buildTree(html);
  const content = blocks(tree.children);
  return sanitizeRichTextDocument({ type: 'doc', version: RICHTEXT_VERSION, content }).doc;
}
