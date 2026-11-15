import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sites, type Database } from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { DeployApprovalStore, parseDeployPlan, type DeployApprovalPlan } from '../deploy-approvals';

/**
 * Deploy approvals on a real database (#743): site isolation, and that the
 * `pending → deciding` claim lets exactly one of two concurrent decisions win.
 *
 * Skips when DATABASE_URL is absent; fails when a configured database is
 * unreachable, following the shared DB integration harness contract.
 */
const SITE_A = 'site_deploy_apr_a';
const SITE_B = 'site_deploy_apr_b';

const plan = (siteId: string): DeployApprovalPlan => ({
  kind: 'trigger',
  scope: 'environment',
  environment: 'production',
  targetIds: ['tgt_prod'],
  requestedBy: { kind: 'principal', ref: { type: 'user', siteId, userId: 'usr_editor' } },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

describe.skipIf(!hasDbIntegrationUrl)('DeployApprovalStore', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('deploy-approvals');
  });

  afterAll(async () => {
    if (!db) return;
    for (const site of [SITE_A, SITE_B]) await db.delete(sites).where(eq(sites.id, site)).catch(() => undefined);
  });

  beforeEach(async () => {
    for (const site of [SITE_A, SITE_B]) await db.delete(sites).where(eq(sites.id, site));
    await db.insert(sites).values([
      { organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: SITE_A, name: 'Deploy apr A' },
      { organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: SITE_B, name: 'Deploy apr B' },
    ]);
  });

  it('round-trips a plan and keeps it inside its site', async () => {
    const a = new DeployApprovalStore({ db, siteId: SITE_A });
    const b = new DeployApprovalStore({ db, siteId: SITE_B });
    const row = await a.create(plan(SITE_A));
    expect(parseDeployPlan(row)?.environment).toBe('production');
    expect((await a.list('pending')).map((r) => r.id)).toEqual([row.id]);
    expect(await b.get(row.id)).toBeUndefined();
    expect(await b.list()).toEqual([]);
    expect(await b.transition(row.id, 'pending', 'rejected')).toBeUndefined();
  });

  it('two concurrent claims: exactly one wins', async () => {
    const a = new DeployApprovalStore({ db, siteId: SITE_A });
    const row = await a.create(plan(SITE_A));
    const [x, y] = await Promise.all([
      a.transition(row.id, 'pending', 'deciding'),
      a.transition(row.id, 'pending', 'deciding'),
    ]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    const done = await a.transition(row.id, 'deciding', 'approved', { result: { ok: true } });
    expect(done?.status).toBe('approved');
    expect(done?.decidedAt).toBeInstanceOf(Date);
  });
});
