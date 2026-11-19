import { isRichTextDocument, richTextToPlainText } from '@lumibase/contracts/richtext';
import type { DisplayComponent } from './types';

const MAX = 120;

/** First characters of the document as plain text (#695); a localized value shows its first locale. */
export function richTextExcerpt(value: unknown, max = MAX): string | null {
  const doc = isRichTextDocument(value)
    ? value
    : value && typeof value === 'object' && !Array.isArray(value)
      ? Object.values(value as Record<string, unknown>).find(isRichTextDocument)
      : undefined;
  if (!doc) return null;
  const text = richTextToPlainText(doc).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `richtext` — a one-line plain-text excerpt; never renders the document's markup in a list. */
export const RichTextDisplay: DisplayComponent<unknown> = ({ value }) => {
  const text = richTextExcerpt(value);
  if (text === null || text === '') return <span className="text-muted-foreground">—</span>;
  return <span title={text}>{text}</span>;
};
