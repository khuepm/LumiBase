import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import {
  DEFAULT_REVIEW_RETENTION_DAYS,
  resolveReviewRetentionDays,
  runScheduledReviewRunPurge,
} from '../review-run-retention';

describe('review run retention (#512)', () => {
  it.each([
    [undefined, DEFAULT_REVIEW_RETENTION_DAYS],
    ['', DEFAULT_REVIEW_RETENTION_DAYS],
    ['30', 30],
    [' 365 ', 365],
    ['0', DEFAULT_REVIEW_RETENTION_DAYS],
    ['4000', DEFAULT_REVIEW_RETENTION_DAYS],
    ['30.5', DEFAULT_REVIEW_RETENTION_DAYS],
    ['-1', DEFAULT_REVIEW_RETENTION_DAYS],
  ])('resolves %j to %d days', (value, days) => {
    expect(resolveReviewRetentionDays(value)).toBe(days);
  });

  /** A db double that records each site transaction: the scope it set and the DELETE it ran. */
  function siteDb(siteIds: string[], deletedPerSite: Record<string, number>) {
    const scopes: Array<{ siteId: string | null; deletes: number }> = [];
    const db = {
      select: vi.fn(() => ({ from: async () => siteIds.map((id) => ({ id })) })),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const scope = { siteId: null as string | null, deletes: 0 };
        scopes.push(scope);
        const tx = {
          execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
            // `SELECT set_config('app.site_id', $1, true)`: the param is the site id.
            const param = (query.queryChunks ?? []).find((c) => typeof c === 'string');
            scope.siteId = typeof param === 'string' ? param : null;
          }),
          delete: vi.fn(() => ({
            where: () => ({
              returning: async () => {
                scope.deletes += 1;
                return Array.from({ length: deletedPerSite[scope.siteId ?? ''] ?? 0 }, (_, i) => ({ id: `r${i}` }));
              },
            }),
          })),
        };
        return fn(tx);
      }),
    };
    return { db: db as unknown as Database, scopes };
  }

  it('deletes site by site, each DELETE inside a transaction scoped to that site (RLS, B114)', async () => {
    const { db, scopes } = siteDb(['site_a', 'site_b', 'site_c'], { site_a: 2, site_b: 0, site_c: 1 });
    const log = { log: vi.fn(), error: vi.fn() };
    await expect(runScheduledReviewRunPurge(db, '30', log)).resolves.toEqual({ deleted: 3 });
    expect(scopes).toEqual([
      { siteId: 'site_a', deletes: 1 },
      { siteId: 'site_b', deletes: 1 },
      { siteId: 'site_c', deletes: 1 },
    ]);
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('removed 3'));
  });

  it('never throws', async () => {
    const log = { log: vi.fn(), error: vi.fn() };
    const broken = { select: vi.fn(() => { throw new Error('db down'); }) } as unknown as Database;
    await expect(runScheduledReviewRunPurge(broken, undefined, log)).resolves.toEqual({ deleted: 0 });
    expect(log.error).toHaveBeenCalled();
  });
});
