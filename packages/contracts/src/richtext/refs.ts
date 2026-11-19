import type { RichTextBlock, RichTextDocument, RichTextInline, RichTextRef } from './model';

function fromInlines(nodes: RichTextInline[], out: RichTextRef[]): void {
  for (const n of nodes) {
    if (n.type === 'ref') {
      out.push(n.ref);
      fromInlines(n.content, out);
    } else if (n.type === 'embed') {
      out.push(n.ref);
    } else if (n.type === 'link') {
      fromInlines(n.content, out);
    }
  }
}

function fromBlocks(blocks: RichTextBlock[], out: RichTextRef[]): void {
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
      case 'heading':
        fromInlines(b.content, out);
        break;
      case 'quote':
      case 'footnote':
        fromBlocks(b.content, out);
        break;
      case 'list':
        for (const item of b.items) fromBlocks(item, out);
        break;
      case 'table':
        for (const row of b.rows) for (const cell of row.cells) fromBlocks(cell, out);
        break;
      case 'embed':
        out.push(b.ref);
        break;
      case 'custom':
        // Custom blocks may carry `{ ref: { kind, id } }` / `{ refs: [...] }` (#697).
        for (const v of [b.data.ref, ...(Array.isArray(b.data.refs) ? b.data.refs : [])]) {
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const r = v as Record<string, unknown>;
            if ((r.kind === 'file' || (r.kind === 'item' && typeof r.collection === 'string')) && typeof r.id === 'string' && r.id) {
              out.push({ kind: r.kind, id: r.id, ...(typeof r.collection === 'string' ? { collection: r.collection } : {}) });
            }
          }
        }
        break;
      default:
        break;
    }
  }
}

/**
 * Every item/file reference in a document (links, embeds, custom-block
 * `ref` / `refs`), de-duplicated — what the dependents service needs to
 * block deleting a file still embedded in content (#697).
 */
export function collectRichTextRefs(doc: RichTextDocument): RichTextRef[] {
  const all: RichTextRef[] = [];
  fromBlocks(doc.content, all);
  const seen = new Set<string>();
  return all.filter((r) => {
    const key = `${r.kind}\u0000${r.collection ?? ''}\u0000${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
