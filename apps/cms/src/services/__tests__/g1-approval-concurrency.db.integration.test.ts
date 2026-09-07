import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  agentApprovals,
  agentGoals,
  agentRuns,
  agentToolCalls,
  aiApprovals,
  sites,
  users,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from './g1-db-integration';
import { AISecureHarness } from '../ai-harness';

/**
 * G1 (#453) — the approval claim must serialize against REAL PostgreSQL.
 *
 * The fake-DB suites simulate the compare-and-set by declaring which statuses
 * an update may match, so they verify the code's intent, not the database's
 * behaviour. Only a real server can show that two genuinely concurrent
 * `UPDATE ... WHERE status = 'pending'` statements resolve to one winner.
 *
 * The property under test is the one that matters: the approved action runs
 * EXACTLY ONCE, no matter how many decisions race for it.
 *
 * Skips without DATABASE_URL, matching the other `*.db.integration.test.ts`.
 *
 * **Validates: #453 acceptance — duplicate/concurrent approve, approve-vs-reject**
 */

const SITE = 'site_g1_conc';
const ADMIN = 'usr_g1_conc_admin';

describe.skipIf(!hasDbIntegrationUrl)('G1 approval concurrency — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration();

    await db.insert(sites).values({ id: SITE, name: 'G1 concurrency' })
      .onConflictDoNothing();
    await db.insert(users).values({ id: ADMIN, email: 'g1-conc@example.dev' })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
  });

  /** Seeds a parked approval with a stored `deleteCollection`, returns its ids. */
  async function seedPendingApproval() {
    await db.delete(agentGoals).where(eq(agentGoals.siteId, SITE));
    await db.delete(aiApprovals).where(eq(aiApprovals.siteId, SITE));

    const [goal] = await db.insert(agentGoals).values({
      siteId: SITE, title: 'G1 concurrency', source: 'api',
      assigneeAgent: 'lumibase-copilot', status: 'in_progress',
    }).returning();

    const [run] = await db.insert(agentRuns).values({
      siteId: SITE, goalId: goal!.id, agentName: 'lumibase-copilot', status: 'awaiting_approval',
    }).returning();

    const [legacy] = await db.insert(aiApprovals).values({
      siteId: SITE, skillName: 'deleteCollection', arguments: { name: 'posts' },
      status: 'pending', agentName: 'lumibase-copilot',
    }).returning();

    const [toolCall] = await db.insert(agentToolCalls).values({
      siteId: SITE, runId: run!.id, toolName: 'deleteCollection',
      input: { name: 'posts' }, status: 'pending_approval',
    }).returning();

    const [approval] = await db.insert(agentApprovals).values({
      siteId: SITE, runId: run!.id, legacyApprovalId: legacy!.id,
      subjectType: 'tool_call', subjectId: toolCall!.id, status: 'pending',
      requestedByAgent: 'lumibase-copilot',
    }).returning();

    return { legacyId: legacy!.id, approvalId: approval!.id };
  }

  /**
   * A harness whose only real dependency is a SchemaService spy, so every
   * invocation of the stored skill is counted.
   */
  function harnessWithSpy(deleteCollection: ReturnType<typeof vi.fn>) {
    return new AISecureHarness({
      db,
      siteId: SITE,
      schemaService: { deleteCollection } as never,
      enableAgentHarnessAudit: true,
    });
  }

  it('runs the approved action exactly once under concurrent approves', async () => {
    const { legacyId, approvalId } = await seedPendingApproval();

    const deleteCollection = vi.fn().mockResolvedValue({ deleted: true });
    const harness = harnessWithSpy(deleteCollection);

    // Five genuinely concurrent approvals of the same parked action.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => harness.executeApproved(legacyId, ADMIN, ['*'])),
    );

    const executed = results.filter((r) => r.status === 'executed');
    expect(executed).toHaveLength(1);
    // The property that matters: one side effect, not one status.
    expect(deleteCollection).toHaveBeenCalledTimes(1);

    const [row] = await db.select().from(agentApprovals)
      .where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.siteId, SITE)));
    expect(row!.status).toBe('approved');

    const [legacyRow] = await db.select().from(aiApprovals)
      .where(and(eq(aiApprovals.id, legacyId), eq(aiApprovals.siteId, SITE)));
    expect(legacyRow!.status).toBe('approved');
  });

  it('runs the action at most once under a concurrent approve and reject', async () => {
    const { legacyId, approvalId } = await seedPendingApproval();

    const deleteCollection = vi.fn().mockResolvedValue({ deleted: true });
    const harness = harnessWithSpy(deleteCollection);

    await Promise.all([
      harness.executeApproved(legacyId, ADMIN, ['*']),
      harness.rejectApproval(legacyId, ADMIN),
    ]);

    expect(deleteCollection.mock.calls.length).toBeLessThanOrEqual(1);

    // The two records must agree; a run recorded as approved on one side and
    // rejected on the other is the inconsistency this issue is about.
    const [row] = await db.select().from(agentApprovals)
      .where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.siteId, SITE)));
    const [legacyRow] = await db.select().from(aiApprovals)
      .where(and(eq(aiApprovals.id, legacyId), eq(aiApprovals.siteId, SITE)));

    expect(['approved', 'rejected', 'pending']).toContain(row!.status);
    expect(row!.status).toBe(legacyRow!.status);
  });

  it('never leaves the approval stranded in `deciding` when the skill fails', async () => {
    const { legacyId, approvalId } = await seedPendingApproval();

    const deleteCollection = vi.fn().mockRejectedValue(new Error('SCHEMA_BOOM'));
    const result = await harnessWithSpy(deleteCollection).executeApproved(legacyId, ADMIN, ['*']);

    expect(result.status).toBe('denied');

    // `deciding` is invisible to Mission Control's pending inbox, so a failed
    // execution must never come to rest there. Which terminal state it takes
    // depends on how far the skill got — that distinction has its own suite
    // (g1-failed-outcome); here the property is only that the claim ended.
    const [row] = await db.select().from(agentApprovals)
      .where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.siteId, SITE)));
    expect(row!.status).not.toBe('deciding');
    // This skill reached SchemaService before throwing, so the side effect is
    // unknown and the approval is not silently re-offered.
    expect(row!.status).toBe('failed');
  });

  it('keeps both records in step when a reject wins the race', async () => {
    const { legacyId, approvalId } = await seedPendingApproval();

    const deleteCollection = vi.fn().mockResolvedValue({ deleted: true });
    const harness = harnessWithSpy(deleteCollection);

    // Reject first, then a late approve must find nothing to claim.
    expect(await harness.rejectApproval(legacyId, ADMIN)).toBe(true);
    const late = await harness.executeApproved(legacyId, ADMIN, ['*']);

    expect(late.status).toBe('denied');
    expect(deleteCollection).not.toHaveBeenCalled();

    const [row] = await db.select().from(agentApprovals)
      .where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.siteId, SITE)));
    const [legacyRow] = await db.select().from(aiApprovals)
      .where(and(eq(aiApprovals.id, legacyId), eq(aiApprovals.siteId, SITE)));

    expect(row!.status).toBe('rejected');
    expect(legacyRow!.status).toBe('rejected');
  });

  it('does not replay an approval that was already decided', async () => {
    const { legacyId } = await seedPendingApproval();

    const deleteCollection = vi.fn().mockResolvedValue({ deleted: true });
    const harness = harnessWithSpy(deleteCollection);

    await harness.executeApproved(legacyId, ADMIN, ['*']);
    const second = await harness.executeApproved(legacyId, ADMIN, ['*']);

    expect(second.status).toBe('denied');
    expect(deleteCollection).toHaveBeenCalledTimes(1);
  });
});
