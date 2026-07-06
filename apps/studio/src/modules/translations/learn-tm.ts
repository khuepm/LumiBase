import type { FieldResource } from '@lumibase/sdk';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { localeMap, translatableFields } from './translatable-fields';

/**
 * Learn-TM on save (translation-memory-ui Req 6.1). When the
 * `translations.learnTm` setting is enabled, a human-authored translation is
 * fed back into the TM store (`source=human`, `quality=100`) so future lookups
 * surface it. Best-effort: failures are swallowed — they must never fail a save.
 */

async function api<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(getActiveToken() ? { Authorization: `Bearer ${getActiveToken()}` } : {}),
        ...(getActiveSite() ? { 'x-site-id': getActiveSite()! } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as { data?: T };
    return res.ok ? (body.data ?? null) : null;
  } catch {
    return null;
  }
}

/** Read whether learn-TM is enabled for the site (defaults to true). */
export async function isLearnTmEnabled(): Promise<boolean> {
  const data = await api<{ value?: { enabled?: boolean } }>('/api/v1/settings/translations.learnTm');
  // Default on: absent setting → learn.
  return data?.value?.enabled !== false;
}

/**
 * Upsert TM entries from an item's translatable fields. For each field with a
 * source-locale value and a human target value, records the pair. `sourceLocale`
 * is the reference language (typically the first supported locale).
 */
export async function learnFromItem(
  fields: FieldResource[],
  data: Record<string, unknown>,
  sourceLocale: string,
  targetLocales: string[],
): Promise<number> {
  if (!(await isLearnTmEnabled())) return 0;
  let learned = 0;
  for (const field of translatableFields(fields)) {
    const map = localeMap(data[field.name]);
    const sourceText = map[sourceLocale]?.trim();
    if (!sourceText) continue;
    for (const target of targetLocales) {
      const targetText = map[target]?.trim();
      if (!targetText) continue;
      const res = await api('/api/v1/tm', {
        method: 'POST',
        body: JSON.stringify({
          sourceLang: sourceLocale,
          targetLang: target,
          sourceText,
          targetText,
          source: 'human',
          quality: 100,
        }),
      });
      if (res !== null) learned += 1;
    }
  }
  return learned;
}
