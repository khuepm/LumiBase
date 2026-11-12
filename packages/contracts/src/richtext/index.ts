/**
 * Portable rich-text document model (v1).
 *
 * Structured JSON, not HTML: blocks hold inline nodes, inline text carries
 * marks, and references to items or files are typed nodes rather than URLs.
 * Content migrated from other CMSs (#728) is stored in this shape today; the
 * `richtext` field type and editor of epic #669 (R01/R02) adopt the same model.
 *
 * Serializers (HTML, Markdown, plain text) escape every text node, and links
 * only keep safe URL schemes, so a document from an untrusted source cannot
 * inject markup or `javascript:` URLs when rendered.
 */

export const RICHTEXT_VERSION = 1 as const;

/** Field interface id for a `json` field that stores a {@link RichTextDocument}. */
export const RICHTEXT_INTERFACE = 'richtext';

export type RichTextMark = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'superscript' | 'subscript';

export const RICHTEXT_MARKS: readonly RichTextMark[] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'superscript',
  'subscript',
];

/** A typed pointer to another item (by collection + id) or a file (by storage key). */
export interface RichTextRef {
  kind: 'item' | 'file';
  /** Required for `item`; the target collection. */
  collection?: string;
  id: string;
}

export type RichTextInline =
  | { type: 'text'; text: string; marks?: RichTextMark[] }
  | { type: 'link'; href: string; content: RichTextInline[] }
  /** A hyperlink whose target is an item or file instead of a URL. */
  | { type: 'ref'; ref: RichTextRef; content: RichTextInline[] }
  /** An inline embed of an item or file (e.g. an inline entry card). */
  | { type: 'embed'; ref: RichTextRef }
  | { type: 'break' };

export interface RichTextTableRow {
  header?: boolean;
  /** Each cell is a list of blocks. */
  cells: RichTextBlock[][];
}

export type RichTextBlock =
  | { type: 'paragraph'; content: RichTextInline[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; content: RichTextInline[] }
  | { type: 'quote'; content: RichTextBlock[] }
  /** Each list item is a list of blocks (so items can hold nested lists). */
  | { type: 'list'; ordered: boolean; items: RichTextBlock[][] }
  | { type: 'code'; language?: string; text: string }
  | { type: 'rule' }
  /** A block-level embed of an item or file (image, entry card…). */
  | { type: 'embed'; ref: RichTextRef }
  | { type: 'table'; rows: RichTextTableRow[] }
  /** Extension point for blocks this version does not model; rendered as data only. */
  | { type: 'custom'; name: string; data: Record<string, unknown> };

export interface RichTextDocument {
  type: 'doc';
  version: typeof RICHTEXT_VERSION;
  content: RichTextBlock[];
}

// ── Construction ─────────────────────────────────────────────────────────────

export function emptyRichTextDocument(): RichTextDocument {
  return { type: 'doc', version: RICHTEXT_VERSION, content: [] };
}

// ── Validation ───────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isRef(v: unknown): v is RichTextRef {
  if (!isObj(v) || typeof v.id !== 'string' || v.id.length === 0) return false;
  if (v.kind === 'file') return v.collection === undefined || typeof v.collection === 'string';
  return v.kind === 'item' && typeof v.collection === 'string' && v.collection.length > 0;
}

function isInline(v: unknown, depth: number): boolean {
  if (!isObj(v) || depth > 32) return false;
  switch (v.type) {
    case 'text':
      return (
        typeof v.text === 'string' &&
        (v.marks === undefined ||
          (Array.isArray(v.marks) && v.marks.every((m) => (RICHTEXT_MARKS as readonly unknown[]).includes(m))))
      );
    case 'link':
      return typeof v.href === 'string' && Array.isArray(v.content) && v.content.every((c) => isInline(c, depth + 1));
    case 'ref':
      return isRef(v.ref) && Array.isArray(v.content) && v.content.every((c) => isInline(c, depth + 1));
    case 'embed':
      return isRef(v.ref);
    case 'break':
      return true;
    default:
      return false;
  }
}

function isBlock(v: unknown, depth: number): boolean {
  if (!isObj(v) || depth > 32) return false;
  const inlines = (c: unknown) => Array.isArray(c) && c.every((n) => isInline(n, depth + 1));
  const blocks = (c: unknown) => Array.isArray(c) && c.every((n) => isBlock(n, depth + 1));
  switch (v.type) {
    case 'paragraph':
      return inlines(v.content);
    case 'heading':
      return typeof v.level === 'number' && [1, 2, 3, 4, 5, 6].includes(v.level) && inlines(v.content);
    case 'quote':
      return blocks(v.content);
    case 'list':
      return typeof v.ordered === 'boolean' && Array.isArray(v.items) && v.items.every(blocks);
    case 'code':
      return typeof v.text === 'string' && (v.language === undefined || typeof v.language === 'string');
    case 'rule':
      return true;
    case 'embed':
      return isRef(v.ref);
    case 'table':
      return (
        Array.isArray(v.rows) &&
        v.rows.every(
          (r) => isObj(r) && (r.header === undefined || typeof r.header === 'boolean') && Array.isArray(r.cells) && r.cells.every(blocks),
        )
      );
    case 'custom':
      return typeof v.name === 'string' && isObj(v.data);
    default:
      return false;
  }
}

/** Structural check: is `value` a well-formed v1 document? */
export function isRichTextDocument(value: unknown): value is RichTextDocument {
  return (
    isObj(value) &&
    value.type === 'doc' &&
    value.version === RICHTEXT_VERSION &&
    Array.isArray(value.content) &&
    value.content.every((b) => isBlock(b, 0))
  );
}

// ── Serialisation ────────────────────────────────────────────────────────────

/** Resolve a reference to a URL (or `null` to render it without a link). */
export type RichTextRefResolver = (ref: RichTextRef) => string | null;

export interface RichTextRenderOptions {
  resolveRef?: RichTextRefResolver;
}

const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;

/**
 * Keep http(s), mailto, tel and relative URLs (`/`, `./`, `#`, `?`); drop
 * everything else (`javascript:`, `data:`, `vbscript:`…). Control characters
 * and whitespace that browsers strip before parsing the scheme are removed
 * first, so `java\tscript:` is caught too.
 */
export function safeHref(href: string): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = href.replace(/[\u0000-\u001F\u007F\s]+/g, '');
  if (!cleaned) return null;
  if (SAFE_SCHEME.test(cleaned)) return href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return null;
  return href.trim();
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MARK_TAG: Record<RichTextMark, string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strike: 's',
  code: 'code',
  superscript: 'sup',
  subscript: 'sub',
};

function refAttrs(ref: RichTextRef): string {
  return (
    ` data-ref-kind="${escapeHtml(ref.kind)}"` +
    (ref.collection ? ` data-ref-collection="${escapeHtml(ref.collection)}"` : '') +
    ` data-ref-id="${escapeHtml(ref.id)}"`
  );
}

function inlineToHtml(nodes: RichTextInline[], opts: RichTextRenderOptions): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text': {
          let html = escapeHtml(n.text);
          for (const mark of n.marks ?? []) html = `<${MARK_TAG[mark]}>${html}</${MARK_TAG[mark]}>`;
          return html;
        }
        case 'link': {
          const href = safeHref(n.href);
          const inner = inlineToHtml(n.content, opts);
          return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
        }
        case 'ref': {
          const url = opts.resolveRef?.(n.ref);
          const href = url ? safeHref(url) : null;
          return `<a${href ? ` href="${escapeHtml(href)}"` : ''}${refAttrs(n.ref)}>${inlineToHtml(n.content, opts)}</a>`;
        }
        case 'embed': {
          const url = opts.resolveRef?.(n.ref);
          const href = url ? safeHref(url) : null;
          return n.ref.kind === 'file' && href
            ? `<img src="${escapeHtml(href)}" alt=""${refAttrs(n.ref)}>`
            : `<span${refAttrs(n.ref)}></span>`;
        }
        case 'break':
          return '<br>';
      }
    })
    .join('');
}

function blocksToHtml(blocks: RichTextBlock[], opts: RichTextRenderOptions): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'paragraph':
          return `<p>${inlineToHtml(b.content, opts)}</p>`;
        case 'heading':
          return `<h${b.level}>${inlineToHtml(b.content, opts)}</h${b.level}>`;
        case 'quote':
          return `<blockquote>${blocksToHtml(b.content, opts)}</blockquote>`;
        case 'list': {
          const tag = b.ordered ? 'ol' : 'ul';
          return `<${tag}>${b.items.map((item) => `<li>${blocksToHtml(item, opts)}</li>`).join('')}</${tag}>`;
        }
        case 'code':
          return `<pre><code${b.language ? ` class="language-${escapeHtml(b.language)}"` : ''}>${escapeHtml(b.text)}</code></pre>`;
        case 'rule':
          return '<hr>';
        case 'embed': {
          const url = opts.resolveRef?.(b.ref);
          const href = url ? safeHref(url) : null;
          if (b.ref.kind === 'file' && href) return `<figure${refAttrs(b.ref)}><img src="${escapeHtml(href)}" alt=""></figure>`;
          return `<div${refAttrs(b.ref)}></div>`;
        }
        case 'table':
          return `<table><tbody>${b.rows
            .map((row) => {
              const cell = row.header ? 'th' : 'td';
              return `<tr>${row.cells.map((c) => `<${cell}>${blocksToHtml(c, opts)}</${cell}>`).join('')}</tr>`;
            })
            .join('')}</tbody></table>`;
        case 'custom':
          return `<div data-block="${escapeHtml(b.name)}"></div>`;
      }
    })
    .join('');
}

/** Render a document to safe HTML. */
export function richTextToHtml(doc: RichTextDocument, opts: RichTextRenderOptions = {}): string {
  return blocksToHtml(doc.content, opts);
}

const MD_MARK: Partial<Record<RichTextMark, [string, string]>> = {
  bold: ['**', '**'],
  italic: ['_', '_'],
  strike: ['~~', '~~'],
  code: ['`', '`'],
  underline: ['<u>', '</u>'],
  superscript: ['<sup>', '</sup>'],
  subscript: ['<sub>', '</sub>'],
};

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]#<>|])/g, '\\$1');
}

/**
 * One table cell on one line. Inline text is already escaped by
 * `escapeMarkdown`, so only pipes that are still unescaped (preceded by an even
 * run of backslashes, e.g. from a code block) get a backslash. Escaping every
 * pipe again would turn an escaped pipe (backslash, pipe) into backslash,
 * backslash, pipe: a literal backslash followed by a column break.
 */
function tableCell(md: string): string {
  return md.replace(/\n+/g, ' ').replace(/(\\*)\|/g, (m, bs: string) => (bs.length % 2 === 0 ? `${bs}\\|` : m));
}

function refUrl(ref: RichTextRef, opts: RichTextRenderOptions): string {
  const resolved = opts.resolveRef?.(ref);
  const safe = resolved ? safeHref(resolved) : null;
  if (safe) return safe;
  return ref.kind === 'file' ? `lumibase://file/${ref.id}` : `lumibase://item/${ref.collection}/${ref.id}`;
}

function inlineToMarkdown(nodes: RichTextInline[], opts: RichTextRenderOptions): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text': {
          if (n.marks?.includes('code')) return `\`${n.text.replace(/`/g, "'")}\``;
          let md = escapeMarkdown(n.text);
          for (const mark of n.marks ?? []) {
            const wrap = MD_MARK[mark];
            if (wrap) md = `${wrap[0]}${md}${wrap[1]}`;
          }
          return md;
        }
        case 'link': {
          const href = safeHref(n.href);
          const inner = inlineToMarkdown(n.content, opts);
          return href ? `[${inner}](${href.replace(/\)/g, '%29')})` : inner;
        }
        case 'ref':
          return `[${inlineToMarkdown(n.content, opts)}](${refUrl(n.ref, opts)})`;
        case 'embed':
          return n.ref.kind === 'file' ? `![](${refUrl(n.ref, opts)})` : `[](${refUrl(n.ref, opts)})`;
        case 'break':
          return '  \n';
      }
    })
    .join('');
}

function blocksToMarkdown(blocks: RichTextBlock[], opts: RichTextRenderOptions, indent = ''): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'paragraph':
          return indent + inlineToMarkdown(b.content, opts);
        case 'heading':
          return `${indent}${'#'.repeat(b.level)} ${inlineToMarkdown(b.content, opts)}`;
        case 'quote':
          return blocksToMarkdown(b.content, opts)
            .split('\n')
            .map((l) => `${indent}> ${l}`.trimEnd())
            .join('\n');
        case 'list':
          return b.items
            .map((item, i) => {
              const bullet = b.ordered ? `${i + 1}. ` : '- ';
              const body = blocksToMarkdown(item, opts, indent + ' '.repeat(bullet.length)).trimStart();
              return `${indent}${bullet}${body}`;
            })
            .join('\n');
        case 'code':
          return `${indent}\`\`\`${b.language ?? ''}\n${b.text}\n${indent}\`\`\``;
        case 'rule':
          return `${indent}---`;
        case 'embed':
          return indent + (b.ref.kind === 'file' ? `![](${refUrl(b.ref, opts)})` : `[](${refUrl(b.ref, opts)})`);
        case 'table': {
          const lines = b.rows.map(
            (row) => `| ${row.cells.map((c) => tableCell(blocksToMarkdown(c, opts))).join(' | ')} |`,
          );
          if (lines.length) {
            const cols = b.rows[0]!.cells.length;
            lines.splice(1, 0, `|${' --- |'.repeat(cols)}`);
          }
          return lines.map((l) => indent + l).join('\n');
        }
        case 'custom':
          return '';
      }
    })
    .filter((s) => s !== '')
    .join('\n\n');
}

/** Render a document to Markdown (CommonMark + GFM tables/strike). */
export function richTextToMarkdown(doc: RichTextDocument, opts: RichTextRenderOptions = {}): string {
  return blocksToMarkdown(doc.content, opts);
}

function inlineToText(nodes: RichTextInline[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'text') return n.text;
      if (n.type === 'link' || n.type === 'ref') return inlineToText(n.content);
      if (n.type === 'break') return '\n';
      return '';
    })
    .join('');
}

function blocksToText(blocks: RichTextBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
      case 'heading':
        out.push(inlineToText(b.content));
        break;
      case 'quote':
        out.push(...blocksToText(b.content));
        break;
      case 'list':
        for (const item of b.items) out.push(...blocksToText(item));
        break;
      case 'code':
        out.push(b.text);
        break;
      case 'table':
        for (const row of b.rows) out.push(row.cells.map((c) => blocksToText(c).join(' ')).join('\t'));
        break;
      default:
        break;
    }
  }
  return out;
}

/** Plain text, one block per line — for search indexing and previews. */
export function richTextToPlainText(doc: RichTextDocument): string {
  return blocksToText(doc.content).join('\n');
}
