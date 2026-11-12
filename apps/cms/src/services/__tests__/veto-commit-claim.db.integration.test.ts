import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentApprovals,
  agentGoals,
  agentRuns,
  collections,
  items,
  revisions,
  sites,
  type Database,
} from '@lumibase/database';
import { VetoService, VetoServiceError } from '../veto-service';
import { sweepDueVetoCommits } from '../veto-commit-worker';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Veto-window commits claim the approval before applying anything (B131).
 *
 * On Cloudflare Workers the 5-minute veto sweep runs from a Cron Trigger with
 * no leader lock, so two passes, or a pass and a queue job, can reach
 * `VetoService.commit` for the same approval at once. `commit` used to read
 * `pending` and then act, so both applied the patch. The `pending → deciding`
 * conditional UPDATE makes the database pick one winner.
 */

const SITE = 'site_veto_claim_it';
const COLLECTION = 'articles';

describe.skipIf(!hasDbIntegrationUrl)('VetoService.commit — claim before apply (B131)', () => {
  let db: Database;
  let itemId: string;
  let runId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('veto-commit-claim');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: SITE, name: 'Veto claim IT' });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: COLLECTION, label: 'Articles' })
      .returning({ id: collections.id });
    const [item] = await db
      .insert(items)
      .values({ siteId: SITE, collectionId: coll!.id, data: { title: 'Human title' } })
      .returning({ id: items.id });
    itemId = item!.id;
    const [goal] = await db.insert(agentGoals).values({ siteId: SITE, title: 'retitle' }).returning({ id: agentGoals.id });
    const [run] = await db.insert(agentRuns).values({ siteId: SITE, goalId: goal!.id }).returning({ id: agentRuns.id });
    runId = run!.id;
  });

  async function stageDue(): Promise<{ approvalId: string; revisionId: string }> {
    const service = new VetoService({ db, siteId: SITE });
    const staged = await service.stageItemPatch({
      runId,
      agentRole: 'writer',
      capability: 'items:update',
      collection: COLLECTION,
      itemId,
      patch: { title: 'Agent title' },
    });
    await db
      .update(agentApprovals)
      .set({ autoCommitAt: new Date(Date.now() - 60_000) })
      .where(eq(agentApprovals.id, staged.approvalId));
    return { approvalId: staged.approvalId, revisionId: staged.revisionId };
  }

  /** Revisions written by applying the patch: every revision of the item except the staging itself. */
  const appliedRevisions = async (stagingId: string) =>
    (await db.select({ id: revisions.id }).from(revisions).where(and(eq(revisions.siteId, SITE), eq(revisions.itemId, itemId))))
      .filter((r) => r.id !== stagingId).length;

  it('two overlapping sweeps apply the patch once and approve the row once', async () => {
    const { approvalId, revisionId } = await stageDue();
    const before = await appliedRevisions(revisionId);

    await Promise.all([sweepDueVetoCommits({ db }), sweepDueVetoCommits({ db })]);

    const [row] = await db.select().from(agentApprovals).where(eq(agentApprovals.id, approvalId));
    expect(row!.status).toBe('approved');
    expect(await appliedRevisions(revisionId)).toBe(before + 1);
    const [item] = await db.select({ data: items.data }).from(items).where(eq(items.id, itemId));
    expect((item!.data as Record<string, unknown>)['title']).toBe('Agent title');
  });

  it('a veto that loses the race to a claimed commit is refused, not written over it', async () => {
    const { approvalId } = await stageDue();
    // Simulate a commit holding the claim.
    await db.update(agentApprovals).set({ status: 'deciding', decidedAt: new Date() }).where(eq(agentApprovals.id, approvalId));

    const service = new VetoService({ db, siteId: SITE });
    await expect(service.veto(approvalId, null, 'too late')).rejects.toBeInstanceOf(VetoServiceError);
    const [row] = await db.select({ status: agentApprovals.status }).from(agentApprovals).where(eq(agentApprovals.id, approvalId));
    expect(row!.status).toBe('deciding');
  });

  it('a commit after a veto does nothing', async () => {
    const { approvalId, revisionId } = await stageDue();
    const service = new VetoService({ db, siteId: SITE });
    await service.veto(approvalId, null, 'no');
    const before = await appliedRevisions(revisionId);

    await sweepDueVetoCommits({ db });

    const [row] = await db.select({ status: agentApprovals.status }).from(agentApprovals).where(eq(agentApprovals.id, approvalId));
    expect(row!.status).toBe('rejected');
    expect(await appliedRevisions(revisionId)).toBe(before);
  });
});
