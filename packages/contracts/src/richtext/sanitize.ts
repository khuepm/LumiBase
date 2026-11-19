import {
  RICHTEXT_CODE_LANGUAGE_PATTERN,
  RICHTEXT_MARKS,
  RICHTEXT_NAME_PATTERN,
  type RichTextBlock,
  type RichTextDocument,
  type RichTextInline,
  type RichTextMark,
  type RichTextRef,
} from './model';
import { safeHref } from './url';

/** What the sanitiser changed — for logs and API warnings, never for security decisions. */
export interface RichTextSanitizeChange {
  path: Array<string | number>;
  /** `unsafe-link` · `code-language` · `custom-name` · `footnote-label` · `control-chars` · `empty-text` */
  reason: string;
}

export interface RichTextSanitizeResult {
  doc: RichTextDocument;
  changes: RichTextSanitizeChange[];
}

// C0 controls except TAB / LF, DEL, C1 controls, lone surrogates are handled
// by JSON already. CR is folded into LF.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

type Path = Array<string | number>;

class Sanitizer {
  changes: RichTextSanitizeChange[] = [];

  note(path: Path, reason: string): void {
    this.changes.push({ path, reason });
  }

  text(s: string, path: Path): string {
    const out = s.replace(/\r\n?/g, '\n').replace(CONTROL, '');
    if (out !== s.replace(/\r\n?/g, '\n')) this.note(path, 'control-chars');
    return out;
  }

  ref(r: RichTextRef): RichTextRef {
    return r.kind === 'file'
      ? { kind: 'file', id: r.id, ...(r.collection ? { collection: r.collection } : {}) }
      : { kind: 'item', collection: r.collection as string, id: r.id };
  }

  marks(marks: RichTextMark[] | undefined): RichTextMark[] | undefined {
    if (!marks || marks.length === 0) return undefined;
    const set = new Set(marks);
    return RICHTEXT_MARKS.filter((m) => set.has(m));
  }

  inlines(nodes: RichTextInline[], path: Path): RichTextInline[] {
    const out: RichTextInline[] = [];
    nodes.forEach((n, i) => {
      for (const clean of this.inline(n, [...path, i])) {
        const prev = out[out.length - 1];
        // Merge adjacent text runs with identical marks: the editor and the
        // parsers produce the same canonical shape, so round-trips compare equal.
        if (clean.type === 'text' && prev?.type === 'text' && sameMarks(prev.marks, clean.marks)) {
          out[out.length - 1] = { ...prev, text: prev.text + clean.text };
        } else {
          out.push(clean);
        }
      }
    });
    return out;
  }

  inline(n: RichTextInline, path: Path): RichTextInline[] {
    switch (n.type) {
      case 'text': {
        const text = this.text(n.text, path);
        if (text === '') {
          this.note(path, 'empty-text');
          return [];
        }
        const marks = this.marks(n.marks);
        return [marks ? { type: 'text', text, marks } : { type: 'text', text }];
      }
      case 'link': {
        const content = this.inlines(n.content, [...path, 'content']);
        const href = safeHref(n.href);
        if (!href) {
          // Keep the words, lose the link.
          this.note(path, 'unsafe-link');
          return content;
        }
        return content.length ? [{ type: 'link', href, content }] : [];
      }
      case 'ref': {
        const content = this.inlines(n.content, [...path, 'content']);
        return content.length ? [{ type: 'ref', ref: this.ref(n.ref), content }] : [];
      }
      case 'embed':
        return [{ type: 'embed', ref: this.ref(n.ref), ...(n.alt ? { alt: this.text(n.alt, [...path, 'alt']) } : {}) }];
      case 'break':
        return [{ type: 'break' }];
      case 'footnote':
        if (!RICHTEXT_NAME_PATTERN.test(n.label)) {
          this.note(path, 'footnote-label');
          return [];
        }
        return [{ type: 'footnote', label: n.label }];
    }
  }

  blocks(blocks: RichTextBlock[], path: Path): RichTextBlock[] {
    const out: RichTextBlock[] = [];
    blocks.forEach((b, i) => {
      const clean = this.block(b, [...path, i]);
      if (clean) out.push(clean);
    });
    return out;
  }

  block(b: RichTextBlock, path: Path): RichTextBlock | null {
    switch (b.type) {
      case 'paragraph':
        return { type: 'paragraph', content: this.inlines(b.content, [...path, 'content']) };
      case 'heading':
        return { type: 'heading', level: b.level, content: this.inlines(b.content, [...path, 'content']) };
      case 'quote':
        return { type: 'quote', content: this.blocks(b.content, [...path, 'content']) };
      case 'list':
        return {
          type: 'list',
          ordered: b.ordered,
          ...(b.ordered && b.start !== undefined && b.start !== 1 ? { start: b.start } : {}),
          items: b.items.map((item, i) => this.blocks(item, [...path, 'items', i])),
        };
      case 'code': {
        const text = this.text(b.text, [...path, 'text']);
        if (b.language !== undefined && !RICHTEXT_CODE_LANGUAGE_PATTERN.test(b.language)) {
          this.note(path, 'code-language');
          return { type: 'code', text };
        }
        return b.language ? { type: 'code', language: b.language, text } : { type: 'code', text };
      }
      case 'rule':
        return { type: 'rule' };
      case 'embed':
        return { type: 'embed', ref: this.ref(b.ref), ...(b.alt ? { alt: this.text(b.alt, [...path, 'alt']) } : {}) };
      case 'table': {
        const rows = b.rows.map((r, i) => ({
          ...(r.header ? { header: true } : {}),
          cells: r.cells.map((c, j) => this.blocks(c, [...path, 'rows', i, 'cells', j])),
        }));
        const caption = b.caption ? this.text(b.caption, [...path, 'caption']).trim() : '';
        return {
          type: 'table',
          rows,
          ...(caption ? { caption } : {}),
          ...(b.headerColumn ? { headerColumn: true } : {}),
          ...(b.align && b.align.some((a) => a !== null) ? { align: [...b.align] } : {}),
        };
      }
      case 'footnote':
        if (!RICHTEXT_NAME_PATTERN.test(b.label)) {
          this.note(path, 'footnote-label');
          return null;
        }
        return { type: 'footnote', label: b.label, content: this.blocks(b.content, [...path, 'content']) };
      case 'custom':
        if (!RICHTEXT_NAME_PATTERN.test(b.name)) {
          this.note(path, 'custom-name');
          return null;
        }
        // `data` is only ever rendered through a registered renderer whose
        // output is sanitised, or as nothing; it is kept as authored JSON.
        return { type: 'custom', name: b.name, data: b.data };
    }
  }
}

function sameMarks(a: RichTextMark[] | undefined, b: RichTextMark[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((m, i) => m === y[i]);
}

/**
 * Write-path sanitisation (#700) of a structurally valid document: drops
 * links whose scheme is not allowlisted (keeping their text), strips control
 * characters, drops malformed code languages, custom block names and footnote
 * labels, and normalises (canonical mark order, merged text runs, no empty
 * text). Idempotent: sanitising the result changes nothing.
 *
 * Call {@link validateRichTextDocument} first — this assumes the shape.
 */
export function sanitizeRichTextDocument(doc: RichTextDocument): RichTextSanitizeResult {
  const s = new Sanitizer();
  const content = s.blocks(doc.content, ['content']);
  return { doc: { type: 'doc', version: doc.version, content }, changes: s.changes };
}
