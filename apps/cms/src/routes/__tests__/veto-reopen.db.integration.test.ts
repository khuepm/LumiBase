import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentApprovals,
  agentGoals,
  agentRuns,
  collections,
  items,
  revisions,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import type { AppEnv } from '../../env';
import { VetoService } from '../../services/veto-service';
import { sweepDueVetoCommits } from '../../services/veto-commit-worker';
import { agentRouter } from '../agent';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * `POST /agent/approvals/:id/reopen` for veto approvals, end to end on
 * PostgreSQL (B131, review of #807).
 *
 * Reopen refuses a quarantined veto whose patch is already live, because the
 * veto sweep would apply it again. The proof is the commit marker of THIS
 * staging, so a live revision from the same run on the same item, written by
 * committing a sibling staging, must not block reopening one that never
 * applied.
 */

const SITE = 'site_veto_reopen_it';
const ADMIN = 'usr_veto_reopen_admin';
const COLLECTION = 'articles';

type AuthVar = AppEnv['Variables']['auth'];

describe.skipIf(!hasDbIntegrationUrl)('veto reopen — DB integration', () => {
  let db: Database;
  let itemId: string;
  let runId: string;

  const adminAuth = { userId: ADMIN, email: 'veto-reopen@x.dev', roles: ['admin'], raw: { dev: true } } as AuthVar;
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    (c as never as { env: Record<string, unknown> }).env = {};
    c.set('db', db);
    c.set('siteId', SITE);
    c.set('auth', adminAuth);
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined, keys: undefined } as never);
    c.set('requestId', 'req_veto_reopen');
    await next();
  });
  app.route('/agent', agentRouter);

  const reopen = (approvalId: string) =>
    app.request(`/agent/approvals/${approvalId}/reopen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'checked the item by hand' }),
    });

  beforeAll(async () => {
    db = await connectDbIntegration('veto-reopen');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(users).where(eq(users.id, ADMIN));
    await db.insert(sites).values({ organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: SITE, name: 'Veto reopen IT' });
    await db.insert(users).values({ id: ADMIN, email: 'veto-reopen@x.dev', status: 'active' });
    const [adminRole] = await db
      .insert(roles)
      .values({ siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true })
      .returning({ id: roles.id });
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: adminRole!.id });
    const [coll] = await db.insert(collections).values({ siteId: SITE, name: COLLECTION, label: 'Articles' }).returning({ id: collections.id });
    const [item] = await db.insert(items).values({ siteId: SITE, collectionId: coll!.id, data: { title: 'Human title' } }).returning({ id: items.id });
    itemId = item!.id;
    const [goal] = await db.insert(agentGoals).values({ siteId: SITE, title: 'retitle' }).returning({ id: agentGoals.id });
    const [run] = await db.insert(agentRuns).values({ siteId: SITE, goalId: goal!.id }).returning({ id: agentRuns.id });
    runId = run!.id;
  });

  async function stage(title: string, dueNow: boolean): Promise<string> {
    const staged = await new VetoService({ db, siteId: SITE }).stageItemPatch({
      runId,
      agentRole: 'writer',
      capability: 'items:update',
      collection: COLLECTION,
      itemId,
      patch: { title },
    });
    await db
      .update(agentApprovals)
      .set({ autoCommitAt: new Date(Date.now() + (dueNow ? -60_000 : 3_600_000)) })
      .where(eq(agentApprovals.id, staged.approvalId));
    return staged.approvalId;
  }

  const quarantine = (approvalId: string) =>
    db.update(agentApprovals).set({ status: 'failed', decidedAt: new Date() }).where(eq(agentApprovals.id, approvalId));

  const status = async (approvalId: string) =>
    (await db.select({ status: agentApprovals.status }).from(agentApprovals).where(eq(agentApprovals.id, approvalId)))[0]!.status;

  it('reopens an unapplied veto even though a sibling staging from the same run is live', async () => {
    const a = await stage('Title from A', false);
    const b = await stage('Title from B', true);
    await sweepDueVetoCommits({ db });
    expect(await status(b)).toBe('approved');
    // The item now carries a live revision from the same run, written by B.
    const fromRun = await db
      .select({ id: revisions.id })
      .from(revisions)
      .where(and(eq(revisions.itemId, itemId), eq(revisions.createdByRunId, runId), eq(revisions.staged, false)));
    expect(fromRun.length).toBeGreaterThan(0);

    await quarantine(a);
    const res = await reopen(a);

    expect(res.status).toBe(200);
    expect(await status(a)).toBe('pending');
  });

  it('refuses to reopen a quarantined veto whose own patch is live', async () => {
    const b = await stage('Title from B', true);
    await sweepDueVetoCommits({ db });
    await quarantine(b);

    const res = await reopen(b);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('VETO_ALREADY_APPLIED');
    expect(await status(b)).toBe('failed');
  });
});
