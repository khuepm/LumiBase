import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  agentApprovals,
  agentRuns,
  apiKeys,
  apiKeyPolicies,
  collections,
  fields,
  items,
  permissions,
  policies,
  roles,
  settings,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { AgentRunService } from '../agent-run-service';
import { EffectiveCapabilityService } from '../effective-capability-service';
import { CONTENT_OS_SETTINGS_KEY } from '../feature-flags';
import { ReviewerService } from '../reviewer-service';

/**
 * The reviewer gate must agree with the resolver that feeds it (#481 R3.4).
 *
 * ## What was wrong
 *
 * `capabilitiesFromPermissionBundle` emits `['admin']` for an administrator and
 * deliberately never mints `*`. `ReviewerService` accepted `review:<domain>` or
 * `*` — so a real site administrator, resolved through the production path the
 * route uses, was refused with `Capability "review:items" is required`. The
 * agent-reviewer route therefore had **no reachable positive path**.
 *
 * It survived because the existing reviewer tests pass `review:items` straight
 * into `decide()`. That proves the service honours a capability; it cannot prove
 * anything in production is able to produce it. Two spellings of "what counts as
 * admin" in two files is the actual defect, and the fix is one shared predicate.
 *
 * ## Evidence class
 *
 * REAL PostgreSQL and the REAL `EffectiveCapabilityService` — the capability array
 * under test is the one the route would pass, never a literal written here. That
 * is the whole point: a fabricated `['*']` would make these cases pass while the
 * route stayed broken.
 *
 * **Validates: #481 R3.4 — an admin can decide; a non-admin still cannot**
 */

const SITE = 'site_rev_contract';
const ADMIN = 'usr_rev_admin';
const ADMIN_ROLE = 'role_rev_admin';
const MEMBER = 'usr_rev_member';
const MEMBER_ROLE = 'role_rev_member';
const MEMBER_POLICY = 'pol_rev_member';
const WRITER_KEY = 'key_rev_writer';

describe.skipIf(!hasDbIntegrationUrl)('#481 R3.4 reviewer admin contract — DB integration', () => {
  let db: Database;
  let collectionId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('g2-reviewer-admin-contract');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db
      .delete(users)
      .where(sql`${users.id} IN (${ADMIN}, ${MEMBER})`)
      .catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(users).where(sql`${users.id} IN (${ADMIN}, ${MEMBER})`);

    await db.insert(sites).values({ id: SITE, name: 'Reviewer contract' });
    await db.insert(settings).values({
      siteId: SITE,
      key: CONTENT_OS_SETTINGS_KEY,
      scope: 'site',
      // `agentReview` on, so a refusal can only come from the capability gate.
      value: { reconciler: true, agentReview: true },
    });

    await db.insert(users).values([
      { id: ADMIN, email: 'rev-admin@example.dev' },
      { id: MEMBER, email: 'rev-member@example.dev' },
    ]);
    await db.insert(roles).values([
      { id: ADMIN_ROLE, siteId: SITE, name: 'Rev Administrator', adminAccess: true, appAccess: true },
      { id: MEMBER_ROLE, siteId: SITE, name: 'Rev Member', adminAccess: false, appAccess: true },
    ]);
    await db.insert(userSites).values([
      { userId: ADMIN, siteId: SITE, roleId: ADMIN_ROLE },
      { userId: MEMBER, siteId: SITE, roleId: MEMBER_ROLE },
    ]);

    // The member can WRITE items. That is the case worth pinning: being able to
    // perform the action is not the same as being allowed to approve it.
    await db.insert(policies).values({
      id: MEMBER_POLICY,
      siteId: SITE,
      name: 'Rev member policy',
      key: 'rev-member',
      adminAccess: false,
      appAccess: true,
    });
    await db.insert(permissions).values([
      { siteId: SITE, policyId: MEMBER_POLICY, collection: 'posts', action: 'read', fields: ['*'] },
      { siteId: SITE, policyId: MEMBER_POLICY, collection: 'posts', action: 'update', fields: ['*'] },
    ]);
    await db.insert(apiKeys).values({
      id: WRITER_KEY,
      siteId: SITE,
      name: 'rev writer key',
      prefix: 'lbk_rev',
      tokenHash: 'fixture-not-a-credential',
    });
    await db.insert(apiKeyPolicies).values({
      siteId: SITE,
      apiKeyId: WRITER_KEY,
      policyId: MEMBER_POLICY,
      priority: 0,
    });

    const [collection] = await db
      .insert(collections)
      .values({ siteId: SITE, name: 'posts', label: 'Posts' })
      .returning();
    collectionId = collection!.id;
    await db.insert(fields).values({
      siteId: SITE,
      collectionId,
      name: 'title',
      type: 'string',
      interface: 'input',
    });
    await db.insert(items).values({ siteId: SITE, collectionId, data: { title: 'seed' } });
  });

  async function resolvedCapabilities(
    ref: Parameters<EffectiveCapabilityService['resolve']>[0],
  ): Promise<string[]> {
    const grant = await new EffectiveCapabilityService({ db, siteId: SITE }).resolve(ref);
    expect(grant.allowed, 'fixture principal must resolve').toBe(true);
    return (grant as Extract<typeof grant, { allowed: true }>).capabilities;
  }

  /**
   * A pending approval plus a reviewer run in a DISJOINT goal tree, so the
   * self-review rule cannot be the thing that refuses.
   */
  async function pendingApproval(): Promise<{ approvalId: string; reviewerRunId: string }> {
    const runs = new AgentRunService(db, SITE);
    const subject = await runs.ensureRun({ title: 'subject run' });
    const reviewer = await runs.ensureRun({ title: 'reviewer run' });
    const toolCallId = await runs.appendToolCall({
      runId: subject.runId,
      toolName: 'updateItem',
      input: {},
      status: 'pending_approval',
    });
    const [approval] = await db
      .insert(agentApprovals)
      .values({
        siteId: SITE,
        runId: subject.runId,
        subjectType: 'tool_call',
        subjectId: toolCallId,
        kind: 'approval',
        status: 'pending',
      })
      .returning({ id: agentApprovals.id });
    return { approvalId: approval!.id, reviewerRunId: reviewer.runId };
  }

  /**
   * A reviewer whose executor stands in for the harness.
   *
   * The executor is not just a boolean: `decide` finalizes by annotating a row the
   * harness has ALREADY claimed and moved to `approved`, guarded on that status so
   * a human rejection landing mid-execution cannot be overwritten. A stub that
   * only returns `{ executed: true }` therefore escalates with
   * `decision_changed_during_execution` — which is the contract working, not a
   * capability refusal. Measured that way first; the status write is what makes
   * this stand-in faithful.
   */
  function reviewer(options: { executed?: boolean; approvalId?: string } = {}) {
    const executed = options.executed ?? true;
    const calls: unknown[] = [];
    const service = new ReviewerService({
      db,
      siteId: SITE,
      execute: async (input) => {
        calls.push(input);
        if (executed) {
          await db
            .update(agentApprovals)
            // `decidedBy` has an FK to users, and the deciding party here is the
            // admin principal — the same one whose capabilities are under test.
            .set({ status: 'approved', decidedAt: new Date(), decidedBy: ADMIN })
            .where(eq(agentApprovals.id, input.approvalId));
        }
        return { executed };
      },
    });
    return { service, calls };
  }

  it('lets a real administrator decide, using the capabilities the resolver emits', async () => {
    const capabilities = await resolvedCapabilities({ type: 'user', siteId: SITE, userId: ADMIN });
    // Pinned deliberately: if the resolver ever starts minting `*`, that is a
    // separate decision and this test should be the one that notices.
    expect(capabilities).toEqual(['admin']);

    const { approvalId, reviewerRunId } = await pendingApproval();
    const { service, calls } = reviewer();

    const outcome = await service.decide({
      approvalId,
      reviewerRunId,
      decision: 'approved',
      confidence: 1,
      capabilities,
    });

    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      outcome: 'decided',
      status: 'approved',
    });
    expect(calls, 'the stored action must actually be executed').toHaveLength(1);
  });

  it('refuses a member who may write items but was never granted review', async () => {
    const capabilities = await resolvedCapabilities({
      type: 'api_key',
      siteId: SITE,
      apiKeyId: WRITER_KEY,
    });
    expect(capabilities, 'the fixture really can write').toContain('items:write');
    expect(capabilities).not.toContain('admin');

    const { approvalId, reviewerRunId } = await pendingApproval();
    const { service, calls } = reviewer();

    await expect(
      service.decide({
        approvalId,
        reviewerRunId,
        decision: 'approved',
        confidence: 1,
        capabilities,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls, 'nothing may execute on a refusal').toHaveLength(0);

    const [row] = await db.select().from(agentApprovals).where(eq(agentApprovals.id, approvalId));
    expect(row!.status, 'the approval stays pending for a human').toBe('pending');
  });

  it('refuses a member with no permissions at all', async () => {
    const capabilities = await resolvedCapabilities({ type: 'user', siteId: SITE, userId: MEMBER });
    expect(capabilities).toEqual([]);

    const { approvalId, reviewerRunId } = await pendingApproval();
    const { service, calls } = reviewer();

    await expect(
      service.decide({
        approvalId,
        reviewerRunId,
        decision: 'approved',
        confidence: 1,
        capabilities,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toHaveLength(0);
  });

  it('still refuses an administrator for a veto-window approval', async () => {
    // The admin marker must not become a way past the rules that are not about
    // capability at all. Veto windows are human-only by design.
    const capabilities = await resolvedCapabilities({ type: 'user', siteId: SITE, userId: ADMIN });
    const runs = new AgentRunService(db, SITE);
    const subject = await runs.ensureRun({ title: 'veto subject' });
    const reviewerRun = await runs.ensureRun({ title: 'veto reviewer' });
    const [approval] = await db
      .insert(agentApprovals)
      .values({
        siteId: SITE,
        runId: subject.runId,
        subjectType: 'tool_call',
        subjectId: 'tc_veto',
        kind: 'veto',
        status: 'pending',
      })
      .returning({ id: agentApprovals.id });

    const { service } = reviewer();
    await expect(
      service.decide({
        approvalId: approval!.id,
        reviewerRunId: reviewerRun.runId,
        decision: 'approved',
        confidence: 1,
        capabilities,
      }),
    ).rejects.toMatchObject({ code: 'HUMAN_ONLY' });
  });

  it('still refuses an administrator reviewing inside the subject goal tree', async () => {
    const capabilities = await resolvedCapabilities({ type: 'user', siteId: SITE, userId: ADMIN });
    const runs = new AgentRunService(db, SITE);
    const subject = await runs.ensureRun({ title: 'self subject' });
    // Same goal, so the reviewer run shares the subject's tree. The subject run is
    // settled first: since #481 R3.2 the database allows only one in-flight run per
    // goal, and a reviewer run inside the subject's own goal is exactly the shape
    // that constraint forbids. Settling it keeps the fixture about the self-review
    // rule rather than about the new index.
    await db.update(agentRuns).set({ status: 'succeeded' }).where(eq(agentRuns.id, subject.runId));
    const sameTree = await runs.ensureRun({ goalId: subject.goalId, title: 'self reviewer' });
    const toolCallId = await runs.appendToolCall({
      runId: subject.runId,
      toolName: 'updateItem',
      input: {},
      status: 'pending_approval',
    });
    const [approval] = await db
      .insert(agentApprovals)
      .values({
        siteId: SITE,
        runId: subject.runId,
        subjectType: 'tool_call',
        subjectId: toolCallId,
        kind: 'approval',
        status: 'pending',
      })
      .returning({ id: agentApprovals.id });

    const { service } = reviewer();
    await expect(
      service.decide({
        approvalId: approval!.id,
        reviewerRunId: sameTree.runId,
        decision: 'approved',
        confidence: 1,
        capabilities,
      }),
    ).rejects.toMatchObject({ code: 'SELF_REVIEW_FORBIDDEN' });
  });
});
