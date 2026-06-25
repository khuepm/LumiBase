/**
 * Field-level redaction by data classification (P2.3, builds on P2.4).
 *
 * Given a collection's field classifications, mask the values of fields tagged
 * `pii` or `sensitive` in a record. Use this when exposing content to audiences
 * that must not see raw personal data (e.g. a redacted export or a support view).
 */

export type Classification = 'none' | 'pii' | 'sensitive';

export interface ClassifiedField {
  name: string;
  classification: Classification;
}

export const REDACTED = '[REDACTED]';

/**
 * Return a shallow copy of `record` with classified field values masked.
 * By default both `pii` and `sensitive` are redacted; pass `levels` to narrow.
 */
export function redactByClassification<T extends Record<string, unknown>>(
  fields: readonly ClassifiedField[],
  record: T,
  levels: readonly Classification[] = ['pii', 'sensitive'],
): T {
  const redactSet = new Set(
    fields.filter((f) => levels.includes(f.classification)).map((f) => f.name),
  );
  if (redactSet.size === 0) return { ...record };

  const out: Record<string, unknown> = { ...record };
  for (const key of Object.keys(out)) {
    if (redactSet.has(key) && out[key] != null) {
      out[key] = REDACTED;
    }
  }
  return out as T;
}
