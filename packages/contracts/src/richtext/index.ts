/**
 * Portable rich-text document model (v1) and its serialisers — epic #669.
 *
 * Structured JSON, not HTML: blocks hold inline nodes, inline text carries
 * marks, and references to items or files are typed nodes rather than URLs.
 *
 * Security (#700): documents are validated and sanitised on write
 * (`validateRichTextDocument` + `sanitizeRichTextDocument`); pasted or
 * imported HTML/Markdown is parsed into the model (`htmlToRichText`,
 * `markdownToRichText`) instead of being stored; every serialiser escapes
 * text, keeps only allowlisted URL schemes, and `richTextToHtml` finishes with
 * the allowlist sanitiser (`sanitizeHtml`).
 */

export * from './model';
export { validateRichTextDocument, isRichTextDocument, type RichTextIssue, type RichTextLimits } from './validate';
export {
  sanitizeRichTextDocument,
  type RichTextSanitizeChange,
  type RichTextSanitizeResult,
} from './sanitize';
export { safeHref, safeSrc, escapeHtml, RICHTEXT_LINK_SCHEMES, RICHTEXT_MEDIA_SCHEMES } from './url';
export { tokenizeHtml, decodeEntities, type HtmlToken } from './html-tokenizer';
export { sanitizeHtml, DEFAULT_HTML_POLICY, type HtmlSanitizePolicy } from './html-sanitize';
export {
  collectRichTextBlocks,
  defineRichTextPlugin,
  type RichTextBlockDefinition,
  type RichTextPlugin,
  type RichTextRenderContext,
} from './plugins';
export { richTextToHtml, type RichTextRefResolver, type RichTextRenderOptions } from './to-html';
export { richTextToMarkdown, richTextRefUrl, escapeMarkdown, RICHTEXT_MD_CUSTOM_FENCE } from './to-markdown';
export { richTextToPlainText } from './to-text';
export { htmlToRichText } from './from-html';
export { markdownToRichText, type MarkdownImportOptions } from './from-markdown';
export { collectRichTextRefs } from './refs';
export {
  checkRichTextOptions,
  readRichTextFieldOptions,
  RICHTEXT_BLOCK_FEATURES,
  type RichTextBlockFeature,
  type RichTextFieldOptions,
} from './options';
