import { describe, expect, it } from 'vitest';
import type { Database } from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { DeploymentService, DeploymentError } from '../deployment-service';

/**
 * Auto-deploy coalescing (deployment-integrations task 10.3; Req 5.4).
 *
 * **Validates: Requirements 5.4**
 */

const TARGET = {
  id: 'tgt_1',
  siteId: 's1',
  provider: 'vercel',
  name: 'site',
  projectId: 'prj_1',
  tokenCiphertext: 'zzz',
  tokenKeyId: 'v0',
  defaultBranch: 'main',
  productionUrl: null,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const RECENT_DEPLOY = {
  id: 'dep_recent',
  siteId: 's1',
  targetId: 'tgt_1',
  provider: 'vercel',
  status: 'building',
  createdAt: new Date(),
};

/** Selects resolve in call order; inserts are captured. */
function makeDb(selectResults: unknown[][]) {
  let call = 0;
  const inserted: Record<string, unknown>[] = [];
  const db = {
    select() {
      const rows = selectResults[call] ?? [];
      call += 1;
      const b: Record<string, unknown> = {
        from: () => b,
        where: () => b,
        orderBy: () => b,
        limit: () => Promise.resolve(rows),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(res, rej),
      };
      return b;
    },
    insert() {
      return {
        values(v: Record<string, unknown>) {
          inserted.push(v);
          return { returning: () => Promise.resolve([{ id: 'dep_new', ...v }]) };
        },
      };
    },
  };
  return { db: db as unknown as Database, inserted };
}

// decryptToken only runs on the non-coalesced path; a throwing KeyProvider is
// enough to prove the path was taken without talking to a real provider.
const throwingKeys = {
  getKey: () => {
    throw new Error('no key material in tests');
  },
} as unknown as KeyProvider;

function service(db: Database) {
  return new DeploymentService({ db, siteId: 's1', keys: throwingKeys });
}

describe('DeploymentService.trigger coalescing (Req 5.4)', () => {
  it('reuses a recent non-error deployment for auto triggers inside the window', async () => {
    const { db, inserted } = makeDb([[TARGET], [RECENT_DEPLOY]]);
    const row = await service(db).trigger('tgt_1', {
      source: 'auto',
      coalesceWindowMs: 60_000,
    });
    expect(row.id).toBe('dep_recent');
    // No new deployment row — the burst collapsed into the existing build.
    expect(inserted.filter((v) => v.targetId === 'tgt_1')).toHaveLength(0);
  });

  it('never coalesces manual triggers', async () => {
    // Manual path skips the coalesce lookup entirely (select #2 would be the
    // recent-deploy query if it ran) and proceeds to the provider, which
    // fails here on token decryption — proving no reuse happened.
    const { db } = makeDb([[TARGET], [RECENT_DEPLOY]]);
    await expect(
      service(db).trigger('tgt_1', { source: 'manual', coalesceWindowMs: 60_000 }),
    ).rejects.toThrow(DeploymentError);
  });

  it('proceeds to a real trigger when the window is empty', async () => {
    const { db } = makeDb([[TARGET], []]);
    await expect(
      service(db).trigger('tgt_1', { source: 'auto', coalesceWindowMs: 60_000 }),
    ).rejects.toThrow(DeploymentError);
  });
});
