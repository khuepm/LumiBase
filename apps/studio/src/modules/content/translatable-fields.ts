import type { FieldResource } from '@lumibase/sdk';

/**
 * Translation helpers for the content editor.
 *
 * A translatable field uses the `translatable-text` interface and stores its
 * value as a per-locale map inside `item.data[fieldName]`
 * (e.g. `{ en: 'Hello', vi: 'Xin chào' }`). This is the existing convention —
 * see `interfaces/translatable-text.tsx`. These helpers centralise how we
 * detect such fields and read/write a single locale so Translation mode,
 * the suggestion popover, and completion % all agree.
 */

/** Interface id that marks a field as per-locale translatable. */
export const TRANSLATABLE_INTERFACE = 'translatable-text';

/** Fields that hold a per-locale value map, in editor order. */
export function translatableFields(fields: FieldResource[]): FieldResource[] {
  return fields.filter((f) => f.interface === TRANSLATABLE_INTERFACE);
}

/** Coerce a raw field value to its `{ locale: text }` map (empty when absent/scalar). */
export function localeMap(value: unknown): Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {};
}

/** Read one locale's text from a field value map. */
export function localeValue(value: unknown, locale: string): string {
  return localeMap(value)[locale] ?? '';
}

/** Return a new field value map with `locale` set to `text` (non-mutating). */
export function setLocaleValue(value: unknown, locale: string, text: string): Record<string, string> {
  return { ...localeMap(value), [locale]: text };
}

/** True when a locale has a non-empty translation for this field value. */
export function hasTranslation(value: unknown, locale: string): boolean {
  return localeValue(value, locale).trim().length > 0;
}

/**
 * Completion % for a target locale over the translatable fields of an item.
 * 100 when there are no translatable fields (nothing to translate).
 */
export function completionPct(
  fields: FieldResource[],
  data: Record<string, unknown>,
  targetLocale: string,
): number {
  const translatable = translatableFields(fields);
  if (translatable.length === 0) return 100;
  const done = translatable.filter((f) => hasTranslation(data[f.name], targetLocale)).length;
  return Math.round((done / translatable.length) * 100);
}

/** A TM upsert payload learned from a human-authored translation (Req 6.1). */
export interface LearnTmEntry {
  sourceLang: string;
  targetLang: string;
  sourceText: string;
  targetText: string;
  source: 'human';
  quality: 100;
}

/**
 * Build the TM entries to learn from a save (translation-memory-ui Req 6.1).
 * Pure so it can be unit-tested: returns [] when learn-TM is off, no target
 * locale, target === source, or no fields were touched; otherwise one entry per
 * touched field that has BOTH a source and a target value. The caller upserts
 * these best-effort after a successful save.
 */
export function buildLearnTmEntries(args: {
  enabled: boolean;
  sourceLocale: string;
  targetLocale: string | null;
  touchedFields: Iterable<string>;
  data: Record<string, unknown>;
}): LearnTmEntry[] {
  const { enabled, sourceLocale, targetLocale, touchedFields, data } = args;
  if (!enabled || !targetLocale || targetLocale === sourceLocale) return [];
  const entries: LearnTmEntry[] = [];
  for (const name of touchedFields) {
    const sourceText = localeValue(data[name], sourceLocale).trim();
    const targetText = localeValue(data[name], targetLocale).trim();
    if (!sourceText || !targetText) continue;
    entries.push({ sourceLang: sourceLocale, targetLang: targetLocale, sourceText, targetText, source: 'human', quality: 100 });
  }
  return entries;
}
