/**
 * `?locale=&field=` on the item editor route (issue #759). TanStack Router
 * JSON-parses search values (`field=true` arrives as a boolean), so scalars are
 * stringified back and then held to the same shape rules as the intent
 * contract; anything else is dropped.
 */
const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface EditorIntentSearch {
  locale?: string;
  field?: string;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export function readEditorIntentSearch(search: unknown): EditorIntentSearch {
  if (!search || typeof search !== 'object') return {};
  const raw = search as Record<string, unknown>;
  const out: EditorIntentSearch = {};
  const locale = scalar(raw.locale);
  const field = scalar(raw.field);
  if (locale && LOCALE.test(locale)) out.locale = locale;
  if (field && FIELD.test(field)) out.field = field;
  return out;
}

/** Route `validateSearch` for the item editor: keeps only valid hints. */
export function validateEditorIntentSearch(search: Record<string, unknown>): EditorIntentSearch {
  return readEditorIntentSearch(search);
}
