import { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { marketplaceRouter } from '../marketplace';

// Simplified mock since the real issue is in the `db` interactions for `/publish`
function buildApp(dbMock: Database) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', dbMock);
    await next();
  });
  app.route('/api/v1/marketplace', marketplaceRouter);
  return app;
}

describe('marketplace publish performance', () => {
  it('measures time to publish with many sites and admins', async () => {
    const NUM_SITES = 100;
    const ADMINS_PER_SITE = 5;

    let queriesExecuted = 0;

    const dbMock = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve([{
              id: 'source_ext',
              marketplaceSlug: 'test-ext',
              name: 'Test Ext',
              version: '2.0.0'
            }])
          })
        })
      }),
      select: () => {
        const selectFluent = {
          from: () => selectFluent,
          innerJoin: () => selectFluent,
          where: (cond: any) => {
            queriesExecuted++;

            // To simulate different queries returning correctly:
            // 1. the first select in /publish is for installedOutdated.
            if (queriesExecuted === 1) {
                const outdated = [];
                for(let i=0; i<NUM_SITES; i++) {
                    outdated.push({ id: `ext_${i}`, siteId: `site_${i}`, name: 'Test Ext', version: '1.0.0' });
                }
                return Promise.resolve(outdated);
            }

            // 2. subsequent selects inside the loop are for admins
            const admins = [];
            for(let j=0; j<ADMINS_PER_SITE; j++) {
                admins.push({ userId: `admin_${j}` });
            }
            return Promise.resolve(admins);
          }
        };
        return selectFluent;
      },
      insert: () => {
        return {
           values: () => {
             queriesExecuted++;
             return Promise.resolve();
           }
        }
      }
    } as unknown as Database;

    const app = buildApp(dbMock);

    const payload = {
      extensionId: 'source_ext',
      marketplaceSlug: 'test-ext',
      publisher: 'Publisher',
      signature: 'dummy_sig',
      signatureAlg: 'ed25519',
      publisherKeyId: 'key_1',
      bundleSha256: 'a'.repeat(64)
    };

    const start = performance.now();
    const res = await app.request('/api/v1/marketplace/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const end = performance.now();

    if (res.status !== 200) {
      console.error(await res.text());
    }

    expect(res.status).toBe(200);

    console.log(`Publish executed ${queriesExecuted} queries in ${(end - start).toFixed(2)}ms for ${NUM_SITES} sites with ${ADMINS_PER_SITE} admins each.`);

    // We expect 1 query for installedOutdated, then for each of the 100 sites,
    // 1 query for admins + 5 queries for notifications = 601 queries.
  });
});
