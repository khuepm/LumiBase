import { getTableName, type Table } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Database } from '@lumibase/database';
import { sweepOrphanedUploads, uploadedAtFromKey, runScheduledOrphanSweep } from '../files/orphan-sweep';

/**
 * #993 / B229 — unregistered presigned uploads are removed after a grace
 * period; anything referenced, recent, or of unknown age is kept.
 */
const NOW = Date.UTC(2026, 10, 20, 12);
const DAY = 24 * 60 * 60 * 1000;
const old = NOW - 2 * DAY;
const fresh = NOW - 60 * 60 * 1000;

function fakeDb(state: { sites: string[]; files: Record<string, string[]>; versions: Record<string, string[]> }) {
  let currentSite = '';
  const rows = (table: Table) => {
    const name = getTableName(table);
    if (name === 'lumibase_sites') return state.sites.map((id) => ({ id }));
    if (name === 'lumibase_files') return (state.files[currentSite] ?? []).map((key) => ({ key }));
    if (name === 'lumibase_file_versions') return (state.versions[currentSite] ?? []).map((key) => ({ key }));
    return [];
  };
  return {
    setSite: (s: string) => { currentSite = s; },
    db: {
      select: () => ({
        from: (table: Table) => {
          const result = rows(table);
          return Object.assign(Promise.resolve(result), { where: () => Promise.resolve(rows(table)) });
        },
      }),
      // Stale upload claims are dropped per site (#993); none exist here.
      delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    } as unknown as Database,
  };
}

function storage(objects: string[], onList?: (prefix: string) => void) {
  const deleted: string[] = [];
  return {
    deleted,
    list: async (prefix?: string) => {
      onList?.(prefix ?? '');
      return { keys: objects.filter((k) => k.startsWith(prefix ?? '')) };
    },
    delete: async (key: string) => { deleted.push(key); },
  };
}

describe('sweepOrphanedUploads', () => {
  it('deletes only old, unreferenced, timestamped keys in each site namespace', async () => {
    const objects = [
      `sites/a/files/${old}_orphan.pdf`,
      `sites/a/files/${old}_registered.pdf`,
      `sites/a/files/${old}_versioned.pdf`,
      `sites/a/files/${fresh}_in-flight.pdf`,
      `sites/a/files/legacy-name.pdf`,
      `sites/b/files/${old}_orphan-b.png`,
      `sites/a/media/${old}_media.png`,
    ];
    const f = fakeDb({
      sites: ['a', 'b'],
      files: { a: [`sites/a/files/${old}_registered.pdf`] },
      versions: { a: [`sites/a/files/${old}_versioned.pdf`] },
    });
    const s = storage(objects, (prefix) => f.setSite(prefix.split('/')[1] ?? ''));
    const result = await sweepOrphanedUploads({ db: f.db, storage: s, now: NOW });
    expect(s.deleted.sort()).toEqual([`sites/a/files/${old}_orphan.pdf`, `sites/b/files/${old}_orphan-b.png`]);
    expect(result).toMatchObject({ sites: 2, deleted: 2 });
  });

  it('respects the per-run delete budget', async () => {
    const objects = Array.from({ length: 5 }, (_, i) => `sites/a/files/${old + i}_x${i}.pdf`);
    const f = fakeDb({ sites: ['a'], files: {}, versions: {} });
    const s = storage(objects, () => f.setSite('a'));
    const result = await sweepOrphanedUploads({ db: f.db, storage: s, now: NOW, maxDeletes: 2 });
    expect(result.deleted).toBe(2);
    expect(s.deleted).toHaveLength(2);
  });

  it('never throws from the scheduled entry point', async () => {
    const db = { select: () => { throw new Error('db down'); } } as unknown as Database;
    await expect(runScheduledOrphanSweep({ db, storage: storage([]) })).resolves.toBeNull();
  });
});

describe('uploadedAtFromKey', () => {
  it('reads the presign timestamp, or nothing', () => {
    expect(uploadedAtFromKey('sites/a/files/1795153525640_my photo.png')).toBe(1795153525640);
    expect(uploadedAtFromKey('sites/a/files/photo.png')).toBeNull();
    expect(uploadedAtFromKey('sites/a/files/123_short.png')).toBeNull();
  });
});
