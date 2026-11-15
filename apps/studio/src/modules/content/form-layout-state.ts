import { useQuery } from '@tanstack/react-query';
import {
  missingRequiredFields,
  parseFormLayout,
  type FormLayout,
  type RequiredFieldLike,
} from '@lumibase/contracts/form-layout';
import { getApiClient } from '@/lib/api';

/**
 * Form-layout data for the item editors (#750). A missing, unreadable or
 * forbidden layout resolves to `null`, which renders the classic flat form.
 */
export function useFormLayout(collection: string): FormLayout | null {
  const client = getApiClient();
  const query = useQuery({
    queryKey: ['form-layout', collection],
    queryFn: async () => {
      try {
        return parseFormLayout((await client.schema.getFormLayout(collection)).data?.layout);
      } catch {
        return null;
      }
    },
  });
  return query.data ?? null;
}

/**
 * Client-side required check — the same `missingRequiredFields` rule the
 * CMS applies, so the form flags exactly what the server would reject.
 * `partial` mirrors a PATCH: only keys present in `data` are checked.
 */
export function checkRequired(
  fields: readonly RequiredFieldLike[],
  data: Readonly<Record<string, unknown>>,
  layout: FormLayout | null,
  partial = false,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of missingRequiredFields(fields, data, layout, { partial })) {
    out[key] = 'This field is required.';
  }
  return out;
}

/**
 * Map a CMS `VALIDATION` error (`"field: message; other: message"`) to a
 * field → message record. Unknown shapes return `{}`.
 */
export function validationErrorsFrom(err: unknown, knownFields: Iterable<string>): Record<string, string> {
  const e = err as { body?: { errors?: Array<{ code?: string; message?: string }> }; message?: string } | null;
  const first = e?.body?.errors?.[0];
  if (!first || first.code !== 'VALIDATION' || typeof first.message !== 'string') return {};
  const known = new Set(knownFields);
  const out: Record<string, string> = {};
  for (const part of first.message.split('; ')) {
    const idx = part.indexOf(': ');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).split('.')[0] ?? '';
    if (known.has(key) && !out[key]) out[key] = part.slice(idx + 2);
  }
  return out;
}
