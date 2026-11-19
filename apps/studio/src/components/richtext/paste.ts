import { htmlToRichText, markdownToRichText, type RichTextDocument, type RichTextPlugin } from '@lumibase/contracts/richtext';

/**
 * Clipboard → document (#696 / #700). Pasted HTML (Word, Google Docs, web
 * pages, the editor's own copy) is never handed to the editor as HTML: it is
 * parsed into the portable model, which drops scripts, styles, event
 * handlers, unknown elements and unsafe URLs, and only then inserted.
 *
 * Plain text that is clearly Markdown (a heading, list, fence, quote or
 * table line) is imported as Markdown; any other text is left to the editor.
 */

const MARKDOWN_HINT = /^(#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>\s|```|~~~|\|.*\|\s*$)/m;

export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_HINT.test(text);
}

export interface ClipboardInput {
  html?: string;
  text?: string;
  /** The selection is inside a code block: paste text verbatim. */
  inCode?: boolean;
  plugins?: readonly RichTextPlugin[];
}

/** The document to insert, or `null` to let the editor paste plain text itself. */
export function clipboardToRichText(input: ClipboardInput): RichTextDocument | null {
  if (input.inCode) return null;
  if (input.html && input.html.trim()) return htmlToRichText(input.html);
  if (input.text && looksLikeMarkdown(input.text)) return markdownToRichText(input.text, { plugins: input.plugins });
  return null;
}
