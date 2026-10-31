import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { deploymentTargets, deployments, sites, type Database } from '@lumibase/database';
import { EnvKeyProvider } from '@lumibase/runtime';
import type { AppEnv } from '../../../env';
import { deploymentsRouter } from '../../../routes/deployments';
import { DeploymentService } from '../deployment-service';
import { encryptToken } from '../token-vault';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
/**
 * `GET /api/v1/deployments` ordering under `limit` (B162, issue #568).
 *
 * Without an ORDER BY, Postgres returns heap order, which for freshly inserted
 * rows is insertion order. The rows below are inserted OLDEST first, so an
 * unordered query with `limit` returns the oldest rows: the opposite of what
 * the list promises. Only a real database shows this, which is why the test is
 * DB-backed.
 *
 * Skips when DATABASE_URL is absent; fails when a configured database is
 * unreachable, following the shared DB integration harness contract.
 */
const SITE_A = 'site_deploy_order_a';
const SITE_B = 'site_deploy_order_b';
const KEK = Buffer.alloc(32, 7).toString('base64');
const keys = new EnvKeyProvider(new Map([['v0', KEK]]), 'v0');
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

describe.skipIf(!hasDbIntegrationUrl)('DeploymentService.listDeployments — order and isolation', () => {
  let db: Database;
  let targetA = '';
  let targetB = '';

  beforeAll(async () => {
    db = await connectDbIntegration('deployment-list-order');
  });

  afterAll(async () => {
    if (!db) return;
    for (const site of [SITE_A, SITE_B]) {
      await db.delete(sites).where(eq(sites.id, site)).catch(() => undefined);
    }
  });

  beforeEach(async () => {
    for (const site of [SITE_A, SITE_B]) {
      await db.delete(sites).where(eq(sites.id, site));
    }
    await db.insert(sites).values([
      { id: SITE_A, name: 'Deploy order A' },
      { id: SITE_B, name: 'Deploy order B' },
    ]);
    targetA = await seedTarget(SITE_A);
    targetB = await seedTarget(SITE_B);
  });

  async function seedTarget(siteId: string): Promise<string> {
    const enc = await encryptToken(keys, 'provider-token', siteId);
    const [row] = await db
      .insert(deploymentTargets)
      .values({
        siteId,
        provider: 'vercel',
        name: 'target',
        projectId: 'prj_order',
        tokenCiphertext: enc.ciphertext,
        tokenKeyId: enc.keyId,
      })
      .returning({ id: deploymentTargets.id });
    return row!.id;
  }

  /** Inserts one row per entry, in array order (= heap order). */
  async function seed(siteId: string, targetId: string, rows: Array<{ id: string; createdAt: Date }>) {
    for (const r of rows) {
      await db.insert(deployments).values({
        id: r.id,
        siteId,
        targetId,
        provider: 'vercel',
        status: 'ready',
        triggerSource: 'manual',
        createdAt: r.createdAt,
      });
    }
  }

  const service = (siteId: string) => new DeploymentService({ db, siteId, keys });

  it('returns the newest rows first under limit', async () => {
    // Oldest first in heap order.
    await seed(
      SITE_A,
      targetA,
      [1, 2, 3, 4, 5].map((m) => ({ id: `dep_a_${m}`, createdAt: at(m) })),
    );

    const rows = await service(SITE_A).listDeployments({ limit: 3 });

    expect(rows.map((r) => r.id)).toEqual(['dep_a_5', 'dep_a_4', 'dep_a_3']);
  });

  it('breaks createdAt ties by id, descending', async () => {
    // Same instant; inserted in ascending id order.
    await seed(SITE_A, targetA, [
      { id: 'dep_tie_a', createdAt: at(10) },
      { id: 'dep_tie_b', createdAt: at(10) },
      { id: 'dep_tie_c', createdAt: at(10) },
    ]);

    const rows = await service(SITE_A).listDeployments({ limit: 2 });

    expect(rows.map((r) => r.id)).toEqual(['dep_tie_c', 'dep_tie_b']);
  });

  it('never returns another site\'s deployments, even when they are newer (DoD §2b)', async () => {
    await seed(SITE_A, targetA, [
      { id: 'dep_iso_a_1', createdAt: at(1) },
      { id: 'dep_iso_a_2', createdAt: at(2) },
    ]);
    // Site B's rows are all newer than site A's.
    await seed(SITE_B, targetB, [
      { id: 'dep_iso_b_1', createdAt: at(30) },
      { id: 'dep_iso_b_2', createdAt: at(31) },
    ]);

    const a = await service(SITE_A).listDeployments({ limit: 10 });
    const b = await service(SITE_B).listDeployments({ limit: 1 });

    expect(a.map((r) => r.id)).toEqual(['dep_iso_a_2', 'dep_iso_a_1']);
    expect(a.every((r) => r.siteId === SITE_A)).toBe(true);
    expect(b.map((r) => r.id)).toEqual(['dep_iso_b_2']);
  });

  it('serves the same order through GET /deployments, response shape { data } unchanged', async () => {
    await seed(
      SITE_A,
      targetA,
      [1, 2, 3].map((m) => ({ id: `dep_http_${m}`, createdAt: at(m) })),
    );
    await seed(SITE_B, targetB, [{ id: 'dep_http_b', createdAt: at(50) }]);

    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('siteId', SITE_A);
      // Explicit admin dev token: the documented escape hatch of requireSiteAdmin.
      c.set('auth', { roles: ['admin'], raw: { dev: true } } as never);
      c.set('db', db as never);
      c.set('runtime', { keys } as never);
      await next();
    });
    app.route('/deployments', deploymentsRouter);

    const res = await app.request('/deployments?limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['data']);
    expect((body.data as Array<{ id: string }>).map((r) => r.id)).toEqual(['dep_http_3', 'dep_http_2']);
  });
});
