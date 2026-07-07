import { test, expect } from 'vitest';
import { installAutoRefreshTrigger, MaterializeConfig } from '../materialize-service';
import { Database } from '@lumibase/database';

function makeMockDb(queries: string[]): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ id: 'coll-123' }]),
      }),
    }),
    execute: async (q: any) => {
      queries.push(
        typeof q === 'string'
          ? q
          : q.queryChunks
              ?.map((c: any) => (typeof c === 'string' ? c : c.value ? c.value.join('') : ''))
              .join('') ?? '',
      );
    },
  } as unknown as Database;
}

test('siteId injection in materialize trigger is rejected fail-closed', async () => {
  const queries: string[] = [];
  const mockDb = makeMockDb(queries);

  const maliciousSiteId = "site', 'action', 'injected'); DROP TABLE items; --";
  const config: MaterializeConfig = {
    id: 'mat-123',
    siteId: maliciousSiteId,
    collection: 'my_collection',
    target: 'my_target',
    refreshStrategy: 'auto',
    projection: { fields: ['*'] },
    filter: {},
  };

  // The trigger body embeds ids as literals (bind params are impossible inside a
  // PL/pgSQL body), so an id outside the URL-safe alphabet must be rejected
  // rather than escaped.
  await expect(installAutoRefreshTrigger(mockDb, config)).rejects.toThrow(/Unsafe siteId/);
  // No DDL should have been emitted for a rejected config.
  expect(queries).toHaveLength(0);
});

test('a malicious target is also rejected before any DDL runs', async () => {
  const queries: string[] = [];
  const mockDb = makeMockDb(queries);

  const config: MaterializeConfig = {
    id: 'mat-123',
    siteId: 'site-abc',
    collection: 'my_collection',
    target: "t'; DROP TABLE items; --",
    refreshStrategy: 'auto',
    projection: { fields: ['*'] },
    filter: {},
  };

  await expect(installAutoRefreshTrigger(mockDb, config)).rejects.toThrow(/Unsafe target/);
  expect(queries).toHaveLength(0);
});

test('a valid config installs the trigger with ids embedded verbatim', async () => {
  const queries: string[] = [];
  const mockDb = makeMockDb(queries);

  const config: MaterializeConfig = {
    id: 'mat-123',
    siteId: 'site-abc_123',
    collection: 'my_collection',
    target: 'my_target',
    refreshStrategy: 'auto',
    projection: { fields: ['*'] },
    filter: {},
  };

  await installAutoRefreshTrigger(mockDb, config);

  const joined = queries.join('\n');
  expect(joined).toContain("'site_id', 'site-abc_123'");
  expect(joined).toContain("'target', 'my_target'");
  // The validated ids contain no quotes, so no escaping artifacts should appear.
  expect(joined).not.toContain("''");
});
