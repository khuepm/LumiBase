import {
  RICHTEXT_MARKS,
  RICHTEXT_VERSION,
  sanitizeRichTextDocument,
  type RichTextAlign,
  type RichTextBlock,
  type RichTextDocument,
  type RichTextInline,
  type RichTextMark,
  type RichTextRef,
  type RichTextTableRow,
} from '@lumibase/contracts/richtext';

/**
 * Editor (ProseMirror / TipTap JSON) ⇄ portable document (#696).
 *
 * The editor works on its own node schema; what is stored is always the
 * portable `RichTextDocument`, passed through the write-path sanitiser. Node
 * names follow TipTap's StarterKit plus the `lb*` nodes defined in
 * `extensions.ts` for references, embeds, footnotes and custom blocks.
 */

export interface PmMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  marks?: PmMark[];
  text?: string;
}

const PM_MARK: Record<RichTextMark, string> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strike: 'strike',
  code: 'code',
  superscript: 'superscript',
  subscript: 'subscript',
};
const FROM_PM_MARK = new Map(Object.entries(PM_MARK).map(([k, v]) => [v, k as RichTextMark]));

// ── document → editor ────────────────────────────────────────────────────────

function refAttrs(ref: RichTextRef): Record<string, unknown> {
  return { kind: ref.kind, collection: ref.collection ?? null, id: ref.id };
}

function inlineToPm(nodes: RichTextInline[], outer: PmMark[] = []): PmNode[] {
  const out: PmNode[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'text': {
        const marks = [...outer, ...(n.marks ?? []).map((m) => ({ type: PM_MARK[m] }))];
        if (n.text) out.push(marks.length ? { type: 'text', text: n.text, marks } : { type: 'text', text: n.text });
        break;
      }
      case 'link':
        out.push(...inlineToPm(n.content, [...outer, { type: 'link', attrs: { href: n.href } }]));
        break;
      case 'ref':
        out.push(...inlineToPm(n.content, [...outer, { type: 'lbRef', attrs: refAttrs(n.ref) }]));
        break;
      case 'embed':
        out.push({ type: 'lbInlineEmbed', attrs: { ...refAttrs(n.ref), alt: n.alt ?? '' } });
        break;
      case 'break':
        out.push({ type: 'hardBreak' });
        break;
      case 'footnote':
        out.push({ type: 'lbFootnoteRef', attrs: { label: n.label } });
        break;
    }
  }
  return out;
}

function blocksToPm(blocks: RichTextBlock[]): PmNode[] {
  return blocks.map(blockToPm);
}

/** Block containers in the editor need at least one child. */
function nonEmpty(nodes: PmNode[]): PmNode[] {
  return nodes.length ? nodes : [{ type: 'paragraph' }];
}

function blockToPm(b: RichTextBlock): PmNode {
  switch (b.type) {
    case 'paragraph':
      return { type: 'paragraph', content: inlineToPm(b.content) };
    case 'heading':
      return { type: 'heading', attrs: { level: b.level }, content: inlineToPm(b.content) };
    case 'quote':
      return { type: 'blockquote', content: nonEmpty(blocksToPm(b.content)) };
    case 'list':
      return {
        type: b.ordered ? 'orderedList' : 'bulletList',
        ...(b.ordered ? { attrs: { start: b.start ?? 1 } } : {}),
        content: b.items.map((item) => ({ type: 'listItem', content: nonEmpty(blocksToPm(item)) })),
      };
    case 'code':
      return { type: 'codeBlock', attrs: { language: b.language ?? null }, content: b.text ? [{ type: 'text', text: b.text }] : [] };
    case 'rule':
      return { type: 'horizontalRule' };
    case 'embed':
      return { type: 'lbEmbed', attrs: { ...refAttrs(b.ref), alt: b.alt ?? '' } };
    case 'table': {
      const leading = (() => {
        let n = 0;
        while (n < b.rows.length && b.rows[n]!.header) n++;
        return n;
      })();
      return {
        type: 'table',
        attrs: { caption: b.caption ?? '', headerColumn: !!b.headerColumn, align: b.align ?? null },
        content: b.rows.map((row, r) => ({
          type: 'tableRow',
          content: row.cells.map((cell, c) => ({
            type: row.header || (r >= leading && c === 0 && b.headerColumn) ? 'tableHeader' : 'tableCell',
            content: nonEmpty(blocksToPm(cell)),
          })),
        })),
      };
    }
    case 'footnote':
      return { type: 'lbFootnote', attrs: { label: b.label }, content: nonEmpty(blocksToPm(b.content)) };
    case 'custom':
      return { type: 'lbCustom', attrs: { name: b.name, data: b.data } };
  }
}

/** Portable document → editor JSON. */
export function richTextToEditorJson(doc: RichTextDocument | null | undefined): PmNode {
  const content = doc ? blocksToPm(doc.content) : [];
  return { type: 'doc', content: nonEmpty(content) };
}

// ── editor → document ────────────────────────────────────────────────────────

function readRef(attrs: Record<string, unknown> | undefined): RichTextRef | null {
  const kind = attrs?.kind;
  const id = attrs?.id;
  if ((kind !== 'item' && kind !== 'file') || typeof id !== 'string' || !id) return null;
  const collection = typeof attrs?.collection === 'string' && attrs.collection ? attrs.collection : undefined;
  if (kind === 'item' && !collection) return null;
  return collection ? { kind, collection, id } : { kind, id };
}

type Wrapper = { key: string; make: (content: RichTextInline[]) => RichTextInline };

function wrapperOf(m: PmMark): Wrapper | null {
  if (m.type === 'link' && typeof m.attrs?.href === 'string') {
    const href = m.attrs.href;
    return { key: `link:${href}`, make: (content) => ({ type: 'link', href, content }) };
  }
  if (m.type === 'lbRef') {
    const ref = readRef(m.attrs);
    if (ref) return { key: `ref:${ref.kind}:${ref.collection ?? ''}:${ref.id}`, make: (content) => ({ type: 'ref', ref, content }) };
  }
  return null;
}

/** Inline editor nodes → portable inlines, regrouping link/ref marks into wrapper nodes. */
function inlineFromPm(nodes: PmNode[] = []): RichTextInline[] {
  const out: RichTextInline[] = [];
  let group: { key: string; wrapper: Wrapper; items: PmNode[] } | null = null;
  const flush = () => {
    if (group) out.push(group.wrapper.make(inlineFromPm(group.items.map(stripWrapper(group.key)))));
    group = null;
  };
  for (const n of nodes) {
    const wrapper = (n.marks ?? []).map(wrapperOf).find((w): w is Wrapper => w !== null) ?? null;
    if (wrapper) {
      if (group && group.key === wrapper.key) {
        group.items.push(n);
      } else {
        flush();
        group = { key: wrapper.key, wrapper, items: [n] };
      }
      continue;
    }
    flush();
    out.push(...leafFromPm(n));
  }
  flush();
  return out;
}

function stripWrapper(key: string) {
  return (n: PmNode): PmNode => ({ ...n, marks: (n.marks ?? []).filter((m) => wrapperOf(m)?.key !== key) });
}

function leafFromPm(n: PmNode): RichTextInline[] {
  switch (n.type) {
    case 'text': {
      const marks = RICHTEXT_MARKS.filter((m) => (n.marks ?? []).some((pm) => FROM_PM_MARK.get(pm.type) === m));
      return n.text ? [marks.length ? { type: 'text', text: n.text, marks } : { type: 'text', text: n.text }] : [];
    }
    case 'hardBreak':
      return [{ type: 'break' }];
    case 'lbInlineEmbed': {
      const ref = readRef(n.attrs);
      const alt = typeof n.attrs?.alt === 'string' ? n.attrs.alt : '';
      return ref ? [{ type: 'embed', ref, ...(alt ? { alt } : {}) }] : [];
    }
    case 'lbFootnoteRef':
      return typeof n.attrs?.label === 'string' ? [{ type: 'footnote', label: n.attrs.label }] : [];
    default:
      return [];
  }
}

function blocksFromPm(nodes: PmNode[] = []): RichTextBlock[] {
  const out: RichTextBlock[] = [];
  for (const n of nodes) {
    const b = blockFromPm(n);
    if (b) out.push(b);
  }
  return out;
}

/** An editor cell/item that only holds one empty paragraph is empty. */
function trimEmpty(blocks: RichTextBlock[]): RichTextBlock[] {
  return blocks.length === 1 && blocks[0]!.type === 'paragraph' && blocks[0]!.content.length === 0 ? [] : blocks;
}

function blockFromPm(n: PmNode): RichTextBlock | null {
  switch (n.type) {
    case 'paragraph':
      return { type: 'paragraph', content: inlineFromPm(n.content) };
    case 'heading': {
      const level = Number(n.attrs?.level ?? 1);
      return { type: 'heading', level: ([1, 2, 3, 4, 5, 6].includes(level) ? level : 1) as 1 | 2 | 3 | 4 | 5 | 6, content: inlineFromPm(n.content) };
    }
    case 'blockquote':
      return { type: 'quote', content: blocksFromPm(n.content) };
    case 'bulletList':
    case 'orderedList': {
      const ordered = n.type === 'orderedList';
      const start = Number(n.attrs?.start ?? 1);
      return {
        type: 'list',
        ordered,
        ...(ordered && Number.isInteger(start) && start >= 0 && start !== 1 ? { start } : {}),
        items: (n.content ?? []).filter((i) => i.type === 'listItem').map((i) => blocksFromPm(i.content)),
      };
    }
    case 'codeBlock': {
      const text = (n.content ?? []).map((t) => t.text ?? '').join('');
      const language = typeof n.attrs?.language === 'string' && n.attrs.language ? n.attrs.language : undefined;
      return language ? { type: 'code', language, text } : { type: 'code', text };
    }
    case 'horizontalRule':
      return { type: 'rule' };
    case 'lbEmbed': {
      const ref = readRef(n.attrs);
      const alt = typeof n.attrs?.alt === 'string' ? n.attrs.alt : '';
      return ref ? { type: 'embed', ref, ...(alt ? { alt } : {}) } : null;
    }
    case 'table': {
      const rows = (n.content ?? []).filter((r) => r.type === 'tableRow');
      const cellsOf = (r: PmNode) => (r.content ?? []).filter((c) => c.type === 'tableCell' || c.type === 'tableHeader');
      let leading = 0;
      while (leading < rows.length && cellsOf(rows[leading]!).every((c) => c.type === 'tableHeader') && cellsOf(rows[leading]!).length) leading++;
      const body = rows.slice(leading);
      const headerColumn =
        n.attrs?.headerColumn === true ||
        (body.length > 0 && body.every((r) => cellsOf(r)[0]?.type === 'tableHeader' && cellsOf(r).length > 1));
      const tableRows: RichTextTableRow[] = rows.map((r, i) => ({
        ...(i < leading ? { header: true } : {}),
        cells: cellsOf(r).map((c) => trimEmpty(blocksFromPm(c.content))),
      }));
      const caption = typeof n.attrs?.caption === 'string' ? n.attrs.caption.trim() : '';
      const align = Array.isArray(n.attrs?.align)
        ? (n.attrs.align as unknown[]).map((a): RichTextAlign | null => (a === 'left' || a === 'center' || a === 'right' ? a : null))
        : null;
      return {
        type: 'table',
        rows: tableRows,
        ...(caption ? { caption } : {}),
        ...(headerColumn ? { headerColumn: true } : {}),
        ...(align && align.some((a) => a) ? { align } : {}),
      };
    }
    case 'lbFootnote':
      return typeof n.attrs?.label === 'string' ? { type: 'footnote', label: n.attrs.label, content: blocksFromPm(n.content) } : null;
    case 'lbCustom': {
      const name = n.attrs?.name;
      const data = n.attrs?.data;
      if (typeof name !== 'string') return null;
      return { type: 'custom', name, data: data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {} };
    }
    default:
      return null;
  }
}

/**
 * Editor JSON → sanitised portable document. Empty paragraphs at the end are
 * editor scaffolding (the trailing node that keeps the caret placeable after
 * a table or embed) and are not stored; a document holding nothing else is empty.
 */
export function editorJsonToRichText(json: PmNode): RichTextDocument {
  const content = blocksFromPm(json.content);
  while (content.length) {
    const last = content[content.length - 1]!;
    if (last.type === 'paragraph' && last.content.length === 0) content.pop();
    else break;
  }
  return sanitizeRichTextDocument({ type: 'doc', version: RICHTEXT_VERSION, content }).doc;
}
