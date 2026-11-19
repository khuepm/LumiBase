import { z } from 'zod';
import {
  checkRichTextOptions,
  sanitizeRichTextDocument,
  validateRichTextDocument,
  type RichTextDocument,
  type RichTextFieldOptions,
} from '../richtext/index';

/**
 * Zod schema for a `richtext` field value (#695 / #700): structural
 * validation with limits, the field's own options (allowed blocks, marks,
 * heading levels, references, length), then write-path sanitisation — the
 * parsed value is the sanitised document, so what is stored is always clean.
 */
export function richTextValueSchema(options: RichTextFieldOptions = {}): z.ZodType<RichTextDocument, unknown> {
  return z.unknown().transform((value, ctx) => {
    const issue = validateRichTextDocument(value);
    if (issue) {
      ctx.addIssue({ code: 'custom', path: issue.path, message: `Invalid rich text: ${issue.message}`, params: { code: 'invalid_richtext' } });
      return z.NEVER;
    }
    const doc = sanitizeRichTextDocument(value as RichTextDocument).doc;
    const optionIssue = checkRichTextOptions(doc, options);
    if (optionIssue) {
      ctx.addIssue({ code: 'custom', path: optionIssue.path, message: optionIssue.message, params: { code: 'richtext_not_allowed' } });
      return z.NEVER;
    }
    return doc;
  });
}

/** A rich-text document with default (unrestricted) options. */
export const RichTextDocumentSchema = richTextValueSchema();
