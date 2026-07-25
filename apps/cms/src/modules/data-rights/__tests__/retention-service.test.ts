import { describe, it, expect } from 'vitest';

import type { Database } from '@lumibase/database';
import { RetentionService, resolveRetentionDays } from '../retention-service';

describe('resolveRetentionDays', () => {
  it('accepts valid in-range integers', () => {
    expect(resolveRetentionDays('365')).toBe(365);
    expect(resolveRetentionDays('1')).toBe(1);
  });
  it('disables (0) for invalid, missing, or out-of-range input', () => {
    expect(resolveRetentionDays(undefined)).toBe(0);
    expect(resolveRetentionDays('')).toBe(0);
    expect(resolveRetentionDays('0')).toBe(0);
    expect(resolveRetentionDays('-5')).toBe(0);
    expect(resolveRetentionDays('abc')).toBe(0);
    expect(resolveRetentionDays('99999')).toBe(0);
  });
});

function makeFakeDb(deletedRows: ReadonlyArray<Record<string, unknown>>) {
  let deleteCalls = 0;
  const db = {
    delete() {
      deleteCalls += 1;
      const chain: any = {
        where() {
          return chain;
        },
        returning() {
          return Promise.resolve(deletedRows);
        },
      };
      return chain;
    },
    get deleteCalls() {
      return deleteCalls;
    },
  };
  return db as unknown as Database & { deleteCalls: number };
}

describe('RetentionService.purge', () => {
  it('does nothing when horizons are disabled (0)', async () => {
    const db = makeFakeDb([{ id: 'x' }]);
    const result = await new RetentionService({ db }).purge({ siteId: 's1' });
    expect(result).toEqual({ activity: 0, notifications: 0 });
    expect((db as any).deleteCalls).toBe(0);
  });

  it('prunes both tables when horizons are set', async () => {
    const db = makeFakeDb([{ id: 'a' }, { id: 'b' }]);
    const result = await new RetentionService({
      db,
      activityRetentionDays: 365,
      notificationRetentionDays: 180,
    }).purge({ siteId: 's1' });
    expect(result.activity).toBe(2);
    expect(result.notifications).toBe(2);
    expect((db as any).deleteCalls).toBe(2);
  });
});
