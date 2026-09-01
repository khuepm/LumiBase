import { describe, it, expect } from 'vitest';

import { ConsentSetSchema, ConsentTypeSchema } from '@lumibase/contracts/schemas';
import { ConsentService } from '../service';
import type { Database } from '@lumibase/database';

// ---------------------------------------------------------------------------
// Zod DTOs
// ---------------------------------------------------------------------------

describe('consent Zod schemas', () => {
  it('accepts the canonical consent types and rejects others', () => {
    for (const t of ['marketing', 'analytics', 'personalization', 'functional', 'sale_share']) {
      expect(ConsentTypeSchema.safeParse(t).success).toBe(true);
    }
    expect(ConsentTypeSchema.safeParse('tracking').success).toBe(false);
    expect(ConsentTypeSchema.safeParse('').success).toBe(false);
  });

  it('requires a boolean `granted` and trims optional provenance', () => {
    expect(ConsentSetSchema.safeParse({}).success).toBe(false);
    expect(ConsentSetSchema.safeParse({ granted: 'yes' }).success).toBe(false);

    const ok = ConsentSetSchema.safeParse({ granted: true, source: ' signup ', version: 'v2' });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.source).toBe('signup');
      expect(ok.data.version).toBe('v2');
    }

    // Over-long provenance is rejected.
    expect(
      ConsentSetSchema.safeParse({ granted: false, source: 'x'.repeat(65) }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ConsentService — value computation against a scripted fake DB
// ---------------------------------------------------------------------------

interface FakeOpts {
  existing?: Array<{ granted: boolean }>;
  list?: Array<Record<string, unknown>>;
  returnRow?: Record<string, unknown>;
}

function makeFakeDb(opts: FakeOpts): {
  db: Database;
  captured: { values?: any; set?: any };
} {
  const captured: { values?: any; set?: any } = {};
  const db = {
    select() {
      const builder: any = {
        from() {
          return builder;
        },
        where() {
          return builder;
        },
        limit() {
          return Promise.resolve(opts.existing ?? []);
        },
        // `list()` awaits the builder directly (no .limit()).
        then(resolve: (rows: unknown) => unknown) {
          return Promise.resolve(opts.list ?? []).then(resolve);
        },
      };
      return builder;
    },
    insert() {
      const ins: any = {
        values(v: unknown) {
          captured.values = v;
          return ins;
        },
        onConflictDoUpdate(cfg: { set: unknown }) {
          captured.set = cfg.set;
          return ins;
        },
        returning() {
          return Promise.resolve([opts.returnRow]);
        },
      };
      return ins;
    },
  };
  return { db: db as unknown as Database, captured };
}

const FIXED_NOW = new Date('2026-06-24T10:00:00.000Z');

function sampleRow(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    siteId: 'site_1',
    userId: 'user_1',
    consentType: 'marketing',
    granted: true,
    grantedAt: FIXED_NOW,
    withdrawnAt: null,
    source: 'preference_center',
    version: 'v1',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...over,
  };
}

describe('ConsentService.set', () => {
  it('stamps grantedAt + clears withdrawnAt when granting, and returns previousGranted', async () => {
    const { db, captured } = makeFakeDb({
      existing: [{ granted: false }],
      returnRow: sampleRow({ granted: true }),
    });
    const service = new ConsentService({ db, now: () => FIXED_NOW });

    const result = await service.set({
      siteId: 'site_1',
      userId: 'user_1',
      consentType: 'marketing',
      granted: true,
      source: 'preference_center',
      version: 'v1',
    });

    expect(result.previousGranted).toBe(false);
    expect(captured.values.grantedAt).toEqual(FIXED_NOW);
    expect(captured.values.withdrawnAt).toBeNull();
    // The upsert update branch stamps grantedAt and clears withdrawnAt.
    expect(captured.set.granted).toBe(true);
    expect(captured.set.grantedAt).toEqual(FIXED_NOW);
    expect(captured.set.withdrawnAt).toBeNull();
    expect(result.record.consentType).toBe('marketing');
    expect(result.record.grantedAt).toBe(FIXED_NOW.toISOString());
  });

  it('stamps withdrawnAt and preserves historical grantedAt when withdrawing', async () => {
    const { db, captured } = makeFakeDb({
      existing: [{ granted: true }],
      returnRow: sampleRow({ granted: false, withdrawnAt: FIXED_NOW }),
    });
    const service = new ConsentService({ db, now: () => FIXED_NOW });

    const result = await service.set({
      siteId: 'site_1',
      userId: 'user_1',
      consentType: 'analytics',
      granted: false,
    });

    expect(result.previousGranted).toBe(true);
    expect(captured.values.withdrawnAt).toEqual(FIXED_NOW);
    expect(captured.values.grantedAt).toBeNull();
    // Withdrawal must NOT overwrite the historical grantedAt in the update set.
    expect(captured.set.granted).toBe(false);
    expect(captured.set.withdrawnAt).toEqual(FIXED_NOW);
    expect('grantedAt' in captured.set).toBe(false);
  });

  it('reports previousGranted = null when no record exists yet', async () => {
    const { db } = makeFakeDb({
      existing: [],
      returnRow: sampleRow(),
    });
    const service = new ConsentService({ db, now: () => FIXED_NOW });

    const result = await service.set({
      siteId: 'site_1',
      userId: 'user_1',
      consentType: 'marketing',
      granted: true,
    });

    expect(result.previousGranted).toBeNull();
  });
});

describe('ConsentService.list', () => {
  it('maps rows to ConsentRecords with ISO timestamps', async () => {
    const { db } = makeFakeDb({
      list: [sampleRow(), sampleRow({ consentType: 'analytics', granted: false, withdrawnAt: FIXED_NOW })],
    });
    const service = new ConsentService({ db });

    const records = await service.list({ siteId: 'site_1', userId: 'user_1' });

    expect(records).toHaveLength(2);
    expect(records[0]!.consentType).toBe('marketing');
    expect(records[0]!.updatedAt).toBe(FIXED_NOW.toISOString());
    expect(records[1]!.consentType).toBe('analytics');
    expect(records[1]!.granted).toBe(false);
    expect(records[1]!.withdrawnAt).toBe(FIXED_NOW.toISOString());
  });
});
