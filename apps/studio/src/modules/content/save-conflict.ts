import type { ItemRow } from '@lumibase/sdk';
import { jsonEqual } from '@/lib/json-equal';

/**
 * The save lost a race: the item changed after the draft was loaded, and the
 * server refused the write with 412 PRECONDITION_FAILED (`If-Match`).
 */
export function isPreconditionFailed(err: unknown): boolean {
  const e = err as { status?: number; body?: { errors?: Array<{ code?: string }> } } | null;
  return e?.status === 412 && e.body?.errors?.[0]?.code === 'PRECONDITION_FAILED';
}

type Data = Record<string, unknown>;
type Changes = { data: Data; publishAt?: string | null; unpublishAt?: string | null };

export function changedFields(base: Data, draft: Data): Data {
  return Object.fromEntries(Object.entries(draft).filter(
    ([key, value]) => value !== undefined && !jsonEqual(base[key], value),
  ));
}

/** Retry a stale save once, only if every edited field still has its original value. */
export async function saveFieldChanges(
  base: ItemRow,
  changes: Changes,
  read: () => Promise<ItemRow>,
  write: (changes: Changes, version?: number) => Promise<ItemRow>,
): Promise<ItemRow> {
  try {
    return await write(changes, base.version);
  } catch (error) {
    if (!isPreconditionFailed(error) || base.version === undefined) throw error;
    const latest = await read();
    if (latest.version === undefined || latest.version <= base.version ||
        latest.id !== base.id || latest.siteId !== base.siteId ||
        latest.collectionId !== base.collectionId) throw error;
    for (const key of Object.keys(changes.data)) {
      if (!jsonEqual(base.data[key], latest.data[key])) throw error;
    }
    for (const key of ['publishAt', 'unpublishAt'] as const) {
      if (key in changes && (base[key] ?? null) !== (latest[key] ?? null)) throw error;
    }
    return write(changes, latest.version);
  }
}
