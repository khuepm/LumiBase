import type { FieldResource } from '@lumibase/sdk';

/**
 * Identify the translatable fields of a collection (translation-memory-ui Req
 * 3.1, 4.1). A field is translatable when it renders with the
 * `translatable-text` interface or carries a `translations`/i18n special —
 * these store a `{ locale: string }` map rather than a scalar.
 *
 * Also computes translation completion for an item (Req 5.1).
 */

export function isTranslatableField(field: FieldResource): boolean {
  if (field.interface === 'translatable-text') return true;
  const special = Array.isArray(field.special) ? field.special : [];
  return special.some((s) => typeof s === 'string' && (s === 'translations' || s === 'i18n'));
}

export function translatableFields(fields: FieldResource[]): FieldResource[] {
  return fields.filter(isTranslatableField);
}

/** The per-locale value map for a translatable field value. */
export function localeMap(value: unknown): Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {};
}

/**
 * Completion % for a target locale across an item's translatable fields:
 * the share of translatable fields that have a non-empty value in `locale`
 * (relative to fields that have a source value to translate). Returns 0 when
 * there are no translatable fields.
 */
export function completionPct(
  fields: FieldResource[],
  data: Record<string, unknown>,
  sourceLocale: string,
  targetLocale: string,
): number {
  const tf = translatableFields(fields);
  let translatable = 0;
  let done = 0;
  for (const f of tf) {
    const map = localeMap(data[f.name]);
    const hasSource = !!map[sourceLocale]?.trim();
    if (!hasSource) continue; // nothing to translate for this field
    translatable += 1;
    if (map[targetLocale]?.trim()) done += 1;
  }
  if (translatable === 0) return 0;
  return Math.round((done / translatable) * 100);
}
