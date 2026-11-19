/**
 * Rich-text document type emitted by `generateTypes` when a collection has a
 * `richtext` field (#695). Self-contained so the generated file needs no
 * runtime dependency; mirrors `RichTextDocument` in
 * `@lumibase/contracts/richtext` (a parity test in the SDK keeps them aligned).
 */
export const RICHTEXT_TS_DECLARATIONS = `export type RichTextMark = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'superscript' | 'subscript';

export interface RichTextRef {
  kind: 'item' | 'file';
  collection?: string;
  id: string;
}

export type RichTextInline =
  | { type: 'text'; text: string; marks?: RichTextMark[] }
  | { type: 'link'; href: string; content: RichTextInline[] }
  | { type: 'ref'; ref: RichTextRef; content: RichTextInline[] }
  | { type: 'embed'; ref: RichTextRef; alt?: string }
  | { type: 'break' }
  | { type: 'footnote'; label: string };

export interface RichTextTableRow {
  header?: boolean;
  cells: RichTextBlock[][];
}

export type RichTextBlock =
  | { type: 'paragraph'; content: RichTextInline[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; content: RichTextInline[] }
  | { type: 'quote'; content: RichTextBlock[] }
  | { type: 'list'; ordered: boolean; start?: number; items: RichTextBlock[][] }
  | { type: 'code'; language?: string; text: string }
  | { type: 'rule' }
  | { type: 'embed'; ref: RichTextRef; alt?: string }
  | { type: 'table'; rows: RichTextTableRow[]; caption?: string; headerColumn?: boolean; align?: Array<'left' | 'center' | 'right' | null> }
  | { type: 'footnote'; label: string; content: RichTextBlock[] }
  | { type: 'custom'; name: string; data: Record<string, unknown> };

export interface RichTextDocument {
  type: 'doc';
  version: 1;
  content: RichTextBlock[];
}`;

/** Zod validator text for a `richtext` value (structure is checked by the server). */
export const RICHTEXT_ZOD = "z.object({ type: z.literal('doc'), version: z.literal(1), content: z.array(z.record(z.string(), z.unknown())) })";
