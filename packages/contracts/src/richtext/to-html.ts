import type { RichTextBlock, RichTextDocument, RichTextInline, RichTextMark, RichTextRef, RichTextTable } from './model';
import { collectRichTextBlocks, type RichTextBlockDefinition, type RichTextPlugin } from './plugins';
import { sanitizeHtml } from './html-sanitize';
import { escapeHtml, safeHref, safeSrc } from './url';

/** Resolve a reference to a URL (or `null` to render it without a link). */
export type RichTextRefResolver = (ref: RichTextRef) => string | null;

export interface RichTextRenderOptions {
  resolveRef?: RichTextRefResolver;
  /** Custom block renderers (#697 / #698). */
  plugins?: readonly RichTextPlugin[];
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

/** Keeps an embed's alt text when it renders without an `<img>` (no URL / not a file). */
function altAttr(alt: string | undefined): string {
  return alt ? ` data-ref-alt="${escapeHtml(alt)}"` : '';
}

class HtmlRenderer {
  private readonly blocks: Map<string, RichTextBlockDefinition>;
  /** Footnote label → number, in order of first reference. */
  private readonly footnoteNumbers = new Map<string, number>();
  private readonly referenced = new Set<string>();

  constructor(private readonly opts: RichTextRenderOptions) {
    this.blocks = collectRichTextBlocks(opts.plugins);
  }

  resolve(ref: RichTextRef): string | null {
    return this.opts.resolveRef?.(ref) ?? null;
  }

  inline(nodes: RichTextInline[]): string {
    return nodes.map((n) => this.inlineNode(n)).join('');
  }

  inlineNode(n: RichTextInline): string {
    switch (n.type) {
      case 'text': {
        let html = escapeHtml(n.text);
        for (const mark of n.marks ?? []) html = `<${MARK_TAG[mark]}>${html}</${MARK_TAG[mark]}>`;
        return html;
      }
      case 'link': {
        const href = safeHref(n.href);
        const inner = this.inline(n.content);
        return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
      }
      case 'ref': {
        const url = this.resolve(n.ref);
        const href = url ? safeHref(url) : null;
        return `<a${href ? ` href="${escapeHtml(href)}"` : ''}${refAttrs(n.ref)}>${this.inline(n.content)}</a>`;
      }
      case 'embed': {
        const url = this.resolve(n.ref);
        const src = url ? safeSrc(url) : null;
        return n.ref.kind === 'file' && src
          ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(n.alt ?? '')}"${refAttrs(n.ref)}>`
          : `<span${refAttrs(n.ref)}${altAttr(n.alt)}></span>`;
      }
      case 'break':
        return '<br>';
      case 'footnote': {
        let num = this.footnoteNumbers.get(n.label);
        const first = num === undefined;
        if (num === undefined) {
          num = this.footnoteNumbers.size + 1;
          this.footnoteNumbers.set(n.label, num);
        }
        this.referenced.add(n.label);
        const id = first ? ` id="fnref-${escapeHtml(n.label)}"` : '';
        return `<sup${id}><a href="#fn-${escapeHtml(n.label)}" class="footnote-ref" aria-describedby="footnotes-label">${num}</a></sup>`;
      }
    }
  }

  blockList(blocks: RichTextBlock[], footnotes: RichTextBlock[]): string {
    return blocks.map((b) => this.block(b, footnotes)).join('');
  }

  /** A table cell holding a single paragraph renders its text directly. */
  cell(blocks: RichTextBlock[], footnotes: RichTextBlock[]): string {
    const only = blocks.length === 1 ? blocks[0] : undefined;
    return only?.type === 'paragraph' ? this.inline(only.content) : this.blockList(blocks, footnotes);
  }

  table(b: RichTextTable, footnotes: RichTextBlock[]): string {
    let head = 0;
    while (head < b.rows.length && b.rows[head]!.header) head++;
    const align = (i: number) => {
      const a = b.align?.[i];
      return a ? ` data-align="${a}"` : '';
    };
    const row = (cells: RichTextBlock[][], header: boolean) =>
      `<tr>${cells
        .map((c, i) => {
          if (header) return `<th scope="col"${align(i)}>${this.cell(c, footnotes)}</th>`;
          if (i === 0 && b.headerColumn) return `<th scope="row"${align(i)}>${this.cell(c, footnotes)}</th>`;
          return `<td${align(i)}>${this.cell(c, footnotes)}</td>`;
        })
        .join('')}</tr>`;
    const caption = b.caption ? `<caption>${escapeHtml(b.caption)}</caption>` : '';
    const thead = head > 0 ? `<thead>${b.rows.slice(0, head).map((r) => row(r.cells, true)).join('')}</thead>` : '';
    const bodyRows = b.rows.slice(head);
    const tbody = bodyRows.length ? `<tbody>${bodyRows.map((r) => row(r.cells, !!r.header)).join('')}</tbody>` : '';
    return `<table>${caption}${thead}${tbody}</table>`;
  }

  block(b: RichTextBlock, footnotes: RichTextBlock[]): string {
    switch (b.type) {
      case 'paragraph':
        return `<p>${this.inline(b.content)}</p>`;
      case 'heading':
        return `<h${b.level}>${this.inline(b.content)}</h${b.level}>`;
      case 'quote':
        return `<blockquote>${this.blockList(b.content, footnotes)}</blockquote>`;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const start = b.ordered && b.start !== undefined && b.start !== 1 ? ` start="${b.start}"` : '';
        return `<${tag}${start}>${b.items.map((item) => `<li>${this.blockList(item, footnotes)}</li>`).join('')}</${tag}>`;
      }
      case 'code':
        return `<pre><code${b.language ? ` class="language-${escapeHtml(b.language)}"` : ''}>${escapeHtml(b.text)}</code></pre>`;
      case 'rule':
        return '<hr>';
      case 'embed': {
        const url = this.resolve(b.ref);
        const src = url ? safeSrc(url) : null;
        if (b.ref.kind === 'file' && src) {
          return `<figure${refAttrs(b.ref)}><img src="${escapeHtml(src)}" alt="${escapeHtml(b.alt ?? '')}"></figure>`;
        }
        return `<div${refAttrs(b.ref)}${altAttr(b.alt)}></div>`;
      }
      case 'table':
        return this.table(b, footnotes);
      case 'footnote':
        footnotes.push(b);
        return '';
      case 'custom': {
        const def = this.blocks.get(b.name);
        if (def?.toHtml) {
          let inner = '';
          try {
            inner = def.toHtml(b.data, { escape: escapeHtml, resolveRef: (r) => this.resolve(r) });
          } catch {
            inner = '';
          }
          return `<div data-block="${escapeHtml(b.name)}">${inner}</div>`;
        }
        return `<div data-block="${escapeHtml(b.name)}"></div>`;
      }
    }
  }

  footnoteSection(footnotes: RichTextBlock[]): string {
    const defs = footnotes.filter((f): f is Extract<RichTextBlock, { type: 'footnote' }> => f.type === 'footnote');
    if (defs.length === 0) return '';
    // Referenced notes in reference order, then unreferenced ones.
    const order = (l: string) => this.footnoteNumbers.get(l) ?? Number.MAX_SAFE_INTEGER;
    const sorted = [...defs].sort((a, b) => order(a.label) - order(b.label));
    const seen = new Set<string>();
    const items = sorted
      .filter((f) => (seen.has(f.label) ? false : (seen.add(f.label), true)))
      .map((f) => {
        const back = this.referenced.has(f.label)
          ? ` <a href="#fnref-${escapeHtml(f.label)}" class="footnote-backref" aria-label="Back to reference">↩</a>`
          : '';
        const nested: RichTextBlock[] = [];
        return `<li id="fn-${escapeHtml(f.label)}">${this.blockList(f.content, nested)}${back}</li>`;
      })
      .join('');
    return `<section class="footnotes" role="doc-endnotes"><h2 id="footnotes-label" class="lb-sr-only">Footnotes</h2><ol>${items}</ol></section>`;
  }
}

/**
 * Render a document to safe HTML: every text node and attribute is escaped,
 * links and media keep only allowlisted schemes, tables are semantic
 * (`<caption>`, `<thead>`, `<th scope>`), and the result passes the allowlist
 * sanitiser (#700) — so custom block renderers cannot inject markup either.
 */
export function richTextToHtml(doc: RichTextDocument, opts: RichTextRenderOptions = {}): string {
  const r = new HtmlRenderer(opts);
  const footnotes: RichTextBlock[] = [];
  const body = r.blockList(doc.content, footnotes);
  return sanitizeHtml(body + r.footnoteSection(footnotes));
}
