import type { RichTextBlock, RichTextDocument, RichTextInline, RichTextMark, RichTextRef, RichTextTable } from './model';
import { collectRichTextBlocks, type RichTextBlockDefinition } from './plugins';
import type { RichTextRenderOptions } from './to-html';
import { safeHref } from './url';

/** Info string of the fenced block that carries a custom block losslessly. */
export const RICHTEXT_MD_CUSTOM_FENCE = 'lumibase-block';

const MD_MARK: Partial<Record<RichTextMark, [string, string]>> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strike: ['~~', '~~'],
  underline: ['<u>', '</u>'],
  superscript: ['<sup>', '</sup>'],
  subscript: ['<sub>', '</sub>'],
};

/** Backslash-escape everything that could start Markdown syntax inside a text run. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/([\\`*_[\]<>|~&!^])/g, '\\$1')
    .split('\n')
    .map(escapeLineStart)
    .join('\n');
}

/** Characters that only mean something at the start of a line. */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)([#>+=-])/, '$1\\$2')
    .replace(/^(\s*\d{1,9})([.)])/, '$1\\$2');
}

function fenceFor(text: string, char: '`' | '~' = '`'): string {
  let longest = 0;
  const re = char === '`' ? /`+/g : /~+/g;
  for (const m of text.matchAll(re)) longest = Math.max(longest, m[0].length);
  return char.repeat(Math.max(3, longest + 1));
}

function codeSpan(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const ticks = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function destination(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/([<>\\])/g, '\\$1')}>` : url.replace(/\\/g, '\\\\');
}

export function richTextRefUrl(ref: RichTextRef): string {
  return ref.kind === 'file'
    ? `lumibase://file/${encodeURIComponent(ref.id)}`
    : `lumibase://item/${encodeURIComponent(ref.collection ?? '')}/${encodeURIComponent(ref.id)}`;
}

class MarkdownRenderer {
  private readonly blocks: Map<string, RichTextBlockDefinition>;
  constructor(private readonly opts: RichTextRenderOptions) {
    this.blocks = collectRichTextBlocks(opts.plugins);
  }

  refUrl(ref: RichTextRef): string {
    const resolved = this.opts.resolveRef?.(ref);
    const safe = resolved ? safeHref(resolved) : null;
    return safe ?? richTextRefUrl(ref);
  }

  inline(nodes: RichTextInline[]): string {
    return nodes.map((n) => this.inlineNode(n)).join('');
  }

  inlineNode(n: RichTextInline): string {
    switch (n.type) {
      case 'text': {
        const marks = n.marks ?? [];
        let body = marks.includes('code') ? codeSpan(n.text) : escapeMarkdown(n.text);
        // Delimiters must hug non-space text: move edge spaces outside them.
        const lead = marks.includes('code') ? '' : (/^\s+/.exec(body)?.[0] ?? '');
        const trail = marks.includes('code') ? '' : (/\s+$/.exec(body.slice(lead.length))?.[0] ?? '');
        body = body.slice(lead.length, body.length - trail.length);
        if (body === '') return lead + trail;
        for (const mark of marks) {
          const wrap = MD_MARK[mark];
          if (wrap) body = `${wrap[0]}${body}${wrap[1]}`;
        }
        return `${lead}${body}${trail}`;
      }
      case 'link': {
        const href = safeHref(n.href);
        const inner = this.inline(n.content);
        return href ? `[${inner}](${destination(href)})` : inner;
      }
      case 'ref':
        return `[${this.inline(n.content)}](${destination(this.refUrl(n.ref))})`;
      case 'embed':
        return n.ref.kind === 'file'
          ? `![${escapeMarkdown(n.alt ?? '')}](${destination(this.refUrl(n.ref))})`
          : `[](${destination(this.refUrl(n.ref))})`;
      case 'break':
        return '\\\n';
      case 'footnote':
        return `[^${n.label}]`;
    }
  }

  /** Blocks separated by blank lines; nested content is indented by the caller. */
  blockList(blocks: RichTextBlock[]): string {
    return blocks
      .map((b) => this.block(b))
      .filter((s) => s !== null)
      .join('\n\n');
  }

  table(b: RichTextTable): string {
    const cols = Math.max(1, ...b.rows.map((r) => r.cells.length));
    const line = (cells: string[]) => `| ${Array.from({ length: cols }, (_, i) => cells[i] ?? '').join(' | ')} |`;
    const cell = (blocks: RichTextBlock[]) => tableCell(this.blockList(blocks));
    const hasHeader = b.rows[0]?.header === true;
    const head = hasHeader ? line(b.rows[0]!.cells.map(cell)) : line([]);
    const sep = `|${Array.from({ length: cols }, (_, i) => {
      const a = b.align?.[i];
      return a === 'center' ? ' :---: |' : a === 'left' ? ' :--- |' : a === 'right' ? ' ---: |' : ' --- |';
    }).join('')}`;
    const body = (hasHeader ? b.rows.slice(1) : b.rows).map((r) => line(r.cells.map(cell)));
    let out = [head, sep, ...body].join('\n');
    const attrs = b.headerColumn ? ' {.header-column}' : '';
    if (b.caption || attrs) out += `\n\nTable: ${b.caption ? escapeMarkdown(b.caption).replace(/\n/g, ' ') : ''}${attrs}`;
    return out;
  }

  block(b: RichTextBlock): string | null {
    switch (b.type) {
      case 'paragraph': {
        const md = this.inline(b.content);
        return md === '' ? null : md;
      }
      case 'heading':
        return `${'#'.repeat(b.level)} ${this.inline(b.content).replace(/\n/g, ' ')}`.trimEnd();
      case 'quote': {
        const inner = this.blockList(b.content);
        return inner
          .split('\n')
          .map((l) => `> ${l}`.trimEnd())
          .join('\n');
      }
      case 'list': {
        const start = b.ordered ? (b.start ?? 1) : 0;
        const loose = b.items.some((item) => item.filter((x) => x.type !== 'list').length > 1);
        return b.items
          .map((item, i) => {
            const bullet = b.ordered ? `${start + i}. ` : '- ';
            const body = this.blockList(item);
            const pad = ' '.repeat(bullet.length);
            const lines = body.split('\n').map((l, j) => (j === 0 ? l : l === '' ? '' : pad + l));
            return `${bullet}${lines.join('\n')}`.trimEnd();
          })
          .join(loose ? '\n\n' : '\n');
      }
      case 'code': {
        const fence = fenceFor(b.text);
        return `${fence}${b.language ?? ''}\n${b.text}\n${fence}`;
      }
      case 'rule':
        return '---';
      case 'embed':
        return b.ref.kind === 'file'
          ? `![${escapeMarkdown(b.alt ?? '')}](${destination(this.refUrl(b.ref))})`
          : `[](${destination(this.refUrl(b.ref))})`;
      case 'table':
        return this.table(b);
      case 'footnote': {
        const body = this.blockList(b.content);
        const lines = body.split('\n').map((l, j) => (j === 0 || l === '' ? l : `    ${l}`));
        return `[^${b.label}]: ${lines.join('\n')}`.trimEnd();
      }
      case 'custom': {
        const def = this.blocks.get(b.name);
        if (def?.toMarkdown) {
          try {
            return def.toMarkdown(b.data);
          } catch {
            /* fall through to the lossless form */
          }
        }
        const json = JSON.stringify(b.data, null, 2);
        const fence = fenceFor(json);
        return `${fence}${RICHTEXT_MD_CUSTOM_FENCE} ${b.name}\n${json}\n${fence}`;
      }
    }
  }
}

/**
 * One table cell on one line. Inline text is already escaped by
 * `escapeMarkdown`, so only pipes that are still unescaped (preceded by an even
 * run of backslashes, e.g. from a code span) get a backslash. Escaping every
 * pipe again would turn an escaped pipe (backslash, pipe) into backslash,
 * backslash, pipe: a literal backslash followed by a column break.
 */
function tableCell(md: string): string {
  // One linear pass (a regex over backslash runs backtracks quadratically).
  let out = '';
  let run = 0;
  for (const ch of md) {
    if (ch === '\n' || ch === '\r') {
      // A hard break (`\` + newline) becomes `<br>`; other newlines a space.
      if (run % 2 === 1) {
        out = `${out.slice(0, -1)}<br>`;
      } else if (!out.endsWith(' ')) {
        out += ' ';
      }
      run = 0;
      continue;
    }
    if (ch === '|' && run % 2 === 0) out += '\\';
    out += ch;
    run = ch === '\\' ? run + 1 : 0;
  }
  return out.trim();
}

/**
 * Render a document to Markdown (CommonMark + GFM tables, strikethrough and
 * footnotes). Custom blocks without a Markdown renderer become a fenced
 * `lumibase-block` JSON block, so {@link markdownToRichText} restores them.
 */
export function richTextToMarkdown(doc: RichTextDocument, opts: RichTextRenderOptions = {}): string {
  return new MarkdownRenderer(opts).blockList(doc.content);
}
