import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentApprovals,
  agentGoals,
  agentRuns,
  agentToolCalls,
  aiApprovals,
  createDb,
  sites,
  users,
  type Database,
} from '@lumibase/database';
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

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_g1_conc';
const ADMIN = 'usr_g1_conc_admin';

describe('G1 approval concurrency — DB integration', () => {
  let db: Database;
  let canConnect = false;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping G1 concurrency DB test: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping G1 concurrency DB test: database not reachable.');
      return;
    }

    await db.insert(sites).values({ id: SITE, name: 'G1 concurrency' })
      .onConflictDoNothing();
    await db.insert(users).values({ id: ADMIN, email: 'g1-conc@example.dev' })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    if (!canConnect) return;
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

  beforeEach(() => {
    if (!canConnect) return;
  });

  it('runs the approved action exactly once under concurrent approves', async () => {
    if (!canConnect) return;
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
    if (!canConnect) return;
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

  it('leaves the approval retryable, never stranded in `deciding`, when the skill fails', async () => {
    if (!canConnect) return;
    const { legacyId, approvalId } = await seedPendingApproval();

    const deleteCollection = vi.fn().mockRejectedValue(new Error('SCHEMA_BOOM'));
    const result = await harnessWithSpy(deleteCollection).executeApproved(legacyId, ADMIN, ['*']);

    expect(result.status).toBe('denied');

    // `deciding` is invisible to Mission Control's pending inbox, so a failed
    // execution must never come to rest there.
    const [row] = await db.select().from(agentApprovals)
      .where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.siteId, SITE)));
    expect(row!.status).toBe('pending');
  });

  it('keeps both records in step when a reject wins the race', async () => {
    if (!canConnect) return;
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
    if (!canConnect) return;
    const { legacyId } = await seedPendingApproval();

    const deleteCollection = vi.fn().mockResolvedValue({ deleted: true });
    const harness = harnessWithSpy(deleteCollection);

    await harness.executeApproved(legacyId, ADMIN, ['*']);
    const second = await harness.executeApproved(legacyId, ADMIN, ['*']);

    expect(second.status).toBe('denied');
    expect(deleteCollection).toHaveBeenCalledTimes(1);
  });
});
