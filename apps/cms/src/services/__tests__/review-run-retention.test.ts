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

  it('deletes runs older than the window and never throws', async () => {
    const where = vi.fn(() => ({ returning: async () => [{ id: 'a' }, { id: 'b' }] }));
    const db = { delete: vi.fn(() => ({ where })) } as unknown as Database;
    const log = { log: vi.fn(), error: vi.fn() };

    await expect(runScheduledReviewRunPurge(db, '30', log)).resolves.toEqual({ deleted: 2 });
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('removed 2'));

    const broken = { delete: vi.fn(() => { throw new Error('db down'); }) } as unknown as Database;
    await expect(runScheduledReviewRunPurge(broken, undefined, log)).resolves.toEqual({ deleted: 0 });
    expect(log.error).toHaveBeenCalled();
  });
});
