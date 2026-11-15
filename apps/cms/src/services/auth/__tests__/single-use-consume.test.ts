import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

import {
  classifyVerificationLoser,
  consumeEmailVerification,
  consumePasswordReset,
  type ConsumeDb,
} from '../single-use-consume';

/**
 * Unit coverage for the #732 single-winner consumes. The concurrency itself is
 * proven on Postgres in `routes/__tests__/auth-single-use-race.db.integration.test.ts`;
 * here we pin the parts a fake can check honestly: the guard predicate the
 * UPDATE carries (rendered to SQL) and how a zero-row update is classified.
 */

const dialect = new PgDialect();

interface Recorded {
  set?: Record<string, unknown>;
  where?: string;
  params?: unknown[];
}

function fakeDb(opts: { updated: Array<{ id: string }>; selected?: Array<{ status: string }> }): {
  db: ConsumeDb;
  recorded: Recorded;
  selects: () => number;
} {
  const recorded: Recorded = {};
  let selects = 0;
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        recorded.set = values;
        return {
          where: (condition: SQL) => {
            const q = dialect.sqlToQuery(condition);
            recorded.where = q.sql;
            recorded.params = q.params;
            return { returning: async () => opts.updated };
          },
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selects += 1;
            return opts.selected ?? [];
          },
        }),
      }),
    }),
  } as unknown as ConsumeDb;
  return { db, recorded, selects: () => selects };
}

describe('consumeEmailVerification', () => {
  it('flips only an invited account: the status guard is in the UPDATE itself', async () => {
    const { db, recorded, selects } = fakeDb({ updated: [{ id: 'u1' }] });
    expect(await consumeEmailVerification(db, 'u1')).toBe('verified');
    expect(recorded.set?.status).toBe('active');
    expect(recorded.where).toMatch(/"status" = \$\d/);
    expect(recorded.params).toEqual(['u1', 'invited']);
    // The winner needs no second read.
    expect(selects()).toBe(0);
  });

  it('a loser (zero rows) re-reads the account and answers already_verified', async () => {
    const { db } = fakeDb({ updated: [], selected: [{ status: 'active' }] });
    expect(await consumeEmailVerification(db, 'u1')).toBe('already_verified');
  });

  it('classifies every non-winning state', () => {
    expect(classifyVerificationLoser(undefined)).toBe('not_found');
    expect(classifyVerificationLoser('active')).toBe('already_verified');
    expect(classifyVerificationLoser('suspended')).toBe('disabled');
  });
});

describe('consumePasswordReset', () => {
  it('compare-and-swaps on token_version and refuses suspended accounts in the same statement', async () => {
    const { db, recorded } = fakeDb({ updated: [{ id: 'u1' }] });
    const now = new Date('2026-11-14T00:00:00Z');
    expect(
      await consumePasswordReset(db, { userId: 'u1', expectedTokenVersion: 3, passwordHash: 'h', now }),
    ).toBe(true);
    expect(recorded.where).toMatch(/"token_version" = \$\d/);
    expect(recorded.where).toMatch(/"status" <> \$\d/);
    expect(recorded.params).toEqual(['u1', 3, 'suspended']);
    expect(recorded.set?.passwordHash).toBe('h');
    expect(recorded.set?.passwordChangedAt).toBe(now);
  });

  it('reports a lost race (zero rows) as false', async () => {
    const { db } = fakeDb({ updated: [] });
    expect(await consumePasswordReset(db, { userId: 'u1', expectedTokenVersion: 0, passwordHash: 'h' })).toBe(false);
  });
});
