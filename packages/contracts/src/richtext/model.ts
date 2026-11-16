/**
 * Portable rich-text document model (v1).
 *
 * Structured JSON, not HTML: blocks hold inline nodes, inline text carries
 * marks, and references to items or files are typed nodes rather than URLs.
 * Content migrated from other CMSs (#728) and the `richtext` field type of
 * epic #669 share this shape.
 *
 * v1 grows additively: every optional property and node type added after the
 * first release (table `caption` / `headerColumn` / `align`, list `start`,
 * embed `alt`, footnotes) is optional or new, so a document written by an
 * older release still validates unchanged.
 */

export const RICHTEXT_VERSION = 1 as const;

/** Field interface id for a field that stores a {@link RichTextDocument}. */
export const RICHTEXT_INTERFACE = 'richtext';

/** Field type whose values are {@link RichTextDocument}s (#695). */
export const RICHTEXT_FIELD_TYPE = 'richtext';

export type RichTextMark = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'superscript' | 'subscript';

/** Every mark, in canonical order (sanitised documents list marks in this order). */
export const RICHTEXT_MARKS: readonly RichTextMark[] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'superscript',
  'subscript',
];

/** A typed pointer to another item (by collection + id) or a file (by id). */
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
  | { type: 'embed'; ref: RichTextRef; alt?: string }
  | { type: 'break' }
  /** A footnote reference; `label` matches a `footnote` block. */
  | { type: 'footnote'; label: string };

export type RichTextAlign = 'left' | 'center' | 'right';

export interface RichTextTableRow {
  /** Header row: rendered inside `<thead>` with `<th scope="col">` cells. */
  header?: boolean;
  /** Each cell is a list of blocks. */
  cells: RichTextBlock[][];
}

export interface RichTextTable {
  type: 'table';
  rows: RichTextTableRow[];
  /** Accessible table name, rendered as `<caption>`. */
  caption?: string;
  /** The first cell of each body row is a row header (`<th scope="row">`). */
  headerColumn?: boolean;
  /** Per-column alignment (GFM `:---:`); `null` leaves a column unaligned. */
  align?: Array<RichTextAlign | null>;
}

export type RichTextBlock =
  | { type: 'paragraph'; content: RichTextInline[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; content: RichTextInline[] }
  | { type: 'quote'; content: RichTextBlock[] }
  /** Each list item is a list of blocks (so items can hold nested lists). */
  | { type: 'list'; ordered: boolean; start?: number; items: RichTextBlock[][] }
  | { type: 'code'; language?: string; text: string }
  | { type: 'rule' }
  /** A block-level embed of an item or file (image, entry card…). */
  | { type: 'embed'; ref: RichTextRef; alt?: string }
  | RichTextTable
  /** A footnote definition referenced by `{ type: 'footnote', label }`. */
  | { type: 'footnote'; label: string; content: RichTextBlock[] }
  /**
   * A custom block (#697): `name` picks a block renderer (plugin or display
   * template); without one it renders as an empty, inert placeholder.
   */
  | { type: 'custom'; name: string; data: Record<string, unknown> };

export interface RichTextDocument {
  type: 'doc';
  version: typeof RICHTEXT_VERSION;
  content: RichTextBlock[];
}

export function emptyRichTextDocument(): RichTextDocument {
  return { type: 'doc', version: RICHTEXT_VERSION, content: [] };
}

/** Size limits enforced on write: a document past them is rejected, not truncated. */
export const RICHTEXT_LIMITS = {
  /** Deepest nesting of blocks/inlines (lists in quotes in tables…). */
  maxDepth: 32,
  /** Total number of nodes (blocks + inlines + table rows). */
  maxNodes: 50_000,
  /** Total UTF-16 length of all text, code and attribute strings. */
  maxTextLength: 2_000_000,
} as const;

/** Identifier shape for custom block names and footnote labels. */
export const RICHTEXT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** Code block language tags kept on write (anything else is dropped). */
export const RICHTEXT_CODE_LANGUAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_+#.-]{0,31}$/;
