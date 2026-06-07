import { test, expect } from 'vitest';
import { installAutoRefreshTrigger, MaterializeConfig } from '../materialize-service';
import { Database } from '@lumibase/database';

test('siteId injection in materialize trigger is mitigated', async () => {
  const queries: string[] = [];
  const mockDb = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ id: 'coll-123' }])
      })
    }),
    execute: async (q: any) => {
      queries.push(q.queryChunks.map((c: any) => typeof c === 'string' ? c : (c.value ? c.value.join('') : c)).join(''));
    }
  } as unknown as Database;

  const maliciousSiteId = "site', 'action', 'injected'); DROP TABLE items; --";
  const config: MaterializeConfig = {
    id: 'mat-123',
    siteId: maliciousSiteId,
    collection: 'my_collection',
    target: 'my_target',
    refreshStrategy: 'auto',
    projection: { fields: ['*'] },
    filter: {}
  };

  await installAutoRefreshTrigger(mockDb, config);
  // It shouldn't contain unescaped quote that breaks out of the string
  expect(queries[0]).not.toContain("', 'action', 'injected');");
  expect(queries[0]).toContain("'', ''action'', ''injected''); DROP TABLE items; --'");
});
