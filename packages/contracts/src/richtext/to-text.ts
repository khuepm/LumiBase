import type { RichTextBlock, RichTextDocument, RichTextInline } from './model';
import { collectRichTextBlocks, type RichTextBlockDefinition, type RichTextPlugin } from './plugins';

function inlineToText(nodes: RichTextInline[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'text') return n.text;
      if (n.type === 'link' || n.type === 'ref') return inlineToText(n.content);
      if (n.type === 'break') return '\n';
      if (n.type === 'embed') return n.alt ?? '';
      return '';
    })
    .join('');
}

function blocksToText(blocks: RichTextBlock[], defs: Map<string, RichTextBlockDefinition>): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
      case 'heading':
        out.push(inlineToText(b.content));
        break;
      case 'quote':
      case 'footnote':
        out.push(...blocksToText(b.content, defs));
        break;
      case 'list':
        for (const item of b.items) out.push(...blocksToText(item, defs));
        break;
      case 'code':
        out.push(b.text);
        break;
      case 'table':
        if (b.caption) out.push(b.caption);
        for (const row of b.rows) out.push(row.cells.map((c) => blocksToText(c, defs).join(' ')).join('\t'));
        break;
      case 'embed':
        if (b.alt) out.push(b.alt);
        break;
      case 'custom': {
        const def = defs.get(b.name);
        if (def?.toText) {
          try {
            out.push(def.toText(b.data));
          } catch {
            /* indexing must not fail on a plugin */
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Plain text, one block per line — for search indexing and previews. */
export function richTextToPlainText(doc: RichTextDocument, opts: { plugins?: readonly RichTextPlugin[] } = {}): string {
  return blocksToText(doc.content, collectRichTextBlocks(opts.plugins)).join('\n');
}
