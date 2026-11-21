/**
 * Orphaned-upload sweep (#993, backlog B229).
 *
 * A presigned upload writes bytes to `sites/<siteId>/files/<ts>_<name>` and
 * the client then registers them with `POST /api/v1/files`. An upload that is
 * never registered — an abandoned form, a failed client, or someone using the
 * signed URL as free storage — leaves an object no file record points to,
 * served by nothing and invisible in the library.
 *
 * Once an hour, for every site, this lists the site's `files/` namespace and
 * deletes objects that:
 *   - no `lumibase_files` row and no `lumibase_file_versions` row references,
 *   - and are older than the grace period (default 24 h), read from the
 *     `<ts>_` prefix the presign step writes into every key.
 *
 * A key without that prefix (legacy, or written by something else) is never
 * deleted: its age is unknown. Deletes are capped per run so a large backlog
 * drains over several hours instead of in one burst. Never throws.
 */
import { eq } from 'drizzle-orm';
import { fileVersions, files, sites, type Database } from '@lumibase/database';
import type { StorageProvider } from '@lumibase/runtime';
import { filesKeyPrefix } from './upload-token';
import { dbUploadClaims } from './upload-claims';

export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
export const ORPHAN_MAX_DELETES_PER_RUN = 1000;

export interface OrphanSweepDeps {
  db: Database;
  storage: Pick<StorageProvider, 'list' | 'delete'>;
  now?: number;
  graceMs?: number;
  maxDeletes?: number;
}

export interface OrphanSweepResult {
  sites: number;
  scanned: number;
  deleted: number;
}

/** Upload time encoded in a presigned key (`…/files/<ms>_<name>`), or null. */
export function uploadedAtFromKey(key: string): number | null {
  const base = key.slice(key.lastIndexOf('/') + 1);
  const match = /^(\d{13})_/.exec(base);
  return match ? Number(match[1]) : null;
}

export async function sweepOrphanedUploads(deps: OrphanSweepDeps): Promise<OrphanSweepResult> {
  const now = deps.now ?? Date.now();
  const grace = deps.graceMs ?? ORPHAN_GRACE_MS;
  const budget = deps.maxDeletes ?? ORPHAN_MAX_DELETES_PER_RUN;
  const result: OrphanSweepResult = { sites: 0, scanned: 0, deleted: 0 };

  const siteRows = await deps.db.select({ id: sites.id }).from(sites);
  for (const { id: siteId } of siteRows) {
    if (result.deleted >= budget) break;
    result.sites += 1;
    // Claims older than the grace period are spent: their signed URL expired
    // long ago, and an unregistered key's bytes are swept below (#993).
    await dbUploadClaims(deps.db).sweep(siteId, new Date(now - grace));
    const { keys } = await deps.storage.list(filesKeyPrefix(siteId));
    if (keys.length === 0) continue;
    result.scanned += keys.length;

    const referenced = new Set<string>();
    for (const row of await deps.db.select({ key: files.filenameDisk }).from(files).where(eq(files.siteId, siteId))) {
      referenced.add(row.key);
    }
    for (const row of await deps.db.select({ key: fileVersions.filenameDisk }).from(fileVersions).where(eq(fileVersions.siteId, siteId))) {
      referenced.add(row.key);
    }

    for (const key of keys) {
      if (result.deleted >= budget) break;
      if (referenced.has(key)) continue;
      const uploadedAt = uploadedAtFromKey(key);
      if (uploadedAt === null || now - uploadedAt < grace) continue;
      await deps.storage.delete(key);
      result.deleted += 1;
    }
  }
  return result;
}

/** Hourly entry point: never throws, logs what it removed. */
export async function runScheduledOrphanSweep(deps: OrphanSweepDeps): Promise<OrphanSweepResult | null> {
  try {
    const result = await sweepOrphanedUploads(deps);
    if (result.deleted > 0) {
      console.log(`[lumibase-cms] orphan upload sweep removed ${result.deleted} object(s) across ${result.sites} site(s).`);
    }
    return result;
  } catch (err) {
    console.error('[lumibase-cms] orphan upload sweep failed', err instanceof Error ? err.message : String(err));
    return null;
  }
}
