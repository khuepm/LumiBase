import { RICHTEXT_MARKS, type RichTextBlock, type RichTextDocument, type RichTextInline, type RichTextMark } from './model';
import type { RichTextIssue } from './validate';
import { richTextToPlainText } from './to-text';

/** Block features a field can switch off (paragraphs are always allowed). */
export type RichTextBlockFeature = 'heading' | 'quote' | 'list' | 'code' | 'rule' | 'table' | 'embed' | 'footnote' | 'custom';

export const RICHTEXT_BLOCK_FEATURES: readonly RichTextBlockFeature[] = [
  'heading',
  'quote',
  'list',
  'code',
  'rule',
  'table',
  'embed',
  'footnote',
  'custom',
];

/**
 * Per-field configuration of a `richtext` field (`fields.options`). The
 * Studio editor shows only what is allowed, and the API rejects a write that
 * uses anything else — the toolbar is not the security boundary.
 * Every key is optional; omitted means "everything".
 */
export interface RichTextFieldOptions {
  /** Allowed heading levels, e.g. `[2, 3]`. */
  headingLevels?: Array<1 | 2 | 3 | 4 | 5 | 6>;
  /** Allowed marks. */
  marks?: RichTextMark[];
  /** Allowed block types besides paragraphs. */
  blocks?: RichTextBlockFeature[];
  /** URL links (`link` nodes). Default true. */
  links?: boolean;
  /** Item/file references and embeds (`ref`, `embed`). Default true. */
  references?: boolean;
  /** Collections an item reference / embed may point to. */
  referenceCollections?: string[];
  /** Custom block names allowed (block templates / plugins). */
  customBlocks?: string[];
  /** Maximum plain-text length (characters). */
  maxLength?: number;
  /** Editor placeholder. */
  placeholder?: string;
}

/** Read `fields.options` defensively (stored JSON may hold anything). */
export function readRichTextFieldOptions(raw: unknown): RichTextFieldOptions {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: RichTextFieldOptions = {};
  if (Array.isArray(o.headingLevels)) {
    out.headingLevels = o.headingLevels.filter((l): l is 1 | 2 | 3 | 4 | 5 | 6 => [1, 2, 3, 4, 5, 6].includes(l as number));
  }
  if (Array.isArray(o.marks)) out.marks = o.marks.filter((m): m is RichTextMark => (RICHTEXT_MARKS as readonly unknown[]).includes(m));
  if (Array.isArray(o.blocks)) {
    out.blocks = o.blocks.filter((b): b is RichTextBlockFeature => (RICHTEXT_BLOCK_FEATURES as readonly unknown[]).includes(b));
  }
  if (typeof o.links === 'boolean') out.links = o.links;
  if (typeof o.references === 'boolean') out.references = o.references;
  if (Array.isArray(o.referenceCollections)) out.referenceCollections = o.referenceCollections.filter((c): c is string => typeof c === 'string');
  if (Array.isArray(o.customBlocks)) out.customBlocks = o.customBlocks.filter((c): c is string => typeof c === 'string');
  if (typeof o.maxLength === 'number' && Number.isInteger(o.maxLength) && o.maxLength > 0) out.maxLength = o.maxLength;
  if (typeof o.placeholder === 'string') out.placeholder = o.placeholder;
  return out;
}

type Path = Array<string | number>;

class OptionChecker {
  issue: RichTextIssue | null = null;
  constructor(private readonly o: RichTextFieldOptions) {}

  fail(path: Path, message: string): void {
    this.issue ??= { path, message };
  }

  blockAllowed(f: RichTextBlockFeature): boolean {
    return !this.o.blocks || this.o.blocks.includes(f);
  }

  refAllowed(collection: string | undefined, kind: 'item' | 'file', path: Path): void {
    if (this.o.references === false) return this.fail(path, 'References and embeds are not enabled for this field.');
    if (kind === 'item' && this.o.referenceCollections && !this.o.referenceCollections.includes(collection ?? '')) {
      this.fail(path, `References to "${collection}" are not allowed in this field.`);
    }
  }

  inlines(nodes: RichTextInline[], path: Path): void {
    nodes.forEach((n, i) => {
      const p = [...path, i];
      switch (n.type) {
        case 'text':
          for (const m of n.marks ?? []) if (this.o.marks && !this.o.marks.includes(m)) this.fail(p, `The "${m}" mark is not enabled for this field.`);
          break;
        case 'link':
          if (this.o.links === false) this.fail(p, 'Links are not enabled for this field.');
          this.inlines(n.content, [...p, 'content']);
          break;
        case 'ref':
          this.refAllowed(n.ref.collection, n.ref.kind, p);
          this.inlines(n.content, [...p, 'content']);
          break;
        case 'embed':
          this.refAllowed(n.ref.collection, n.ref.kind, p);
          break;
        case 'footnote':
          if (!this.blockAllowed('footnote')) this.fail(p, 'Footnotes are not enabled for this field.');
          break;
        default:
          break;
      }
    });
  }

  blocks(blocks: RichTextBlock[], path: Path): void {
    blocks.forEach((b, i) => {
      const p = [...path, i];
      if (b.type !== 'paragraph' && !this.blockAllowed(b.type)) {
        this.fail(p, `"${b.type}" blocks are not enabled for this field.`);
        return;
      }
      switch (b.type) {
        case 'paragraph':
          this.inlines(b.content, [...p, 'content']);
          break;
        case 'heading':
          if (this.o.headingLevels && !this.o.headingLevels.includes(b.level)) {
            this.fail(p, `Heading level ${b.level} is not enabled for this field (allowed: ${this.o.headingLevels.join(', ') || 'none'}).`);
          }
          this.inlines(b.content, [...p, 'content']);
          break;
        case 'quote':
        case 'footnote':
          this.blocks(b.content, [...p, 'content']);
          break;
        case 'list':
          b.items.forEach((item, j) => this.blocks(item, [...p, 'items', j]));
          break;
        case 'table':
          b.rows.forEach((r, j) => r.cells.forEach((c, k) => this.blocks(c, [...p, 'rows', j, 'cells', k])));
          break;
        case 'embed':
          this.refAllowed(b.ref.collection, b.ref.kind, p);
          break;
        case 'custom':
          if (this.o.customBlocks && !this.o.customBlocks.includes(b.name)) this.fail(p, `Custom block "${b.name}" is not enabled for this field.`);
          break;
        default:
          break;
      }
    });
  }
}

/** The first way `doc` uses something the field's options do not allow, or `null`. */
export function checkRichTextOptions(doc: RichTextDocument, options: RichTextFieldOptions): RichTextIssue | null {
  const c = new OptionChecker(options);
  c.blocks(doc.content, ['content']);
  if (!c.issue && options.maxLength !== undefined) {
    const len = [...richTextToPlainText(doc)].length;
    if (len > options.maxLength) return { path: [], message: `Text is ${len} characters; the maximum is ${options.maxLength}.` };
  }
  return c.issue;
}
