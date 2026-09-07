import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  activity,
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
 * G1 (#453) — a failed execution must not be blindly retryable.
 *
 * Resetting every failure to `pending` puts the approval straight back in the
 * operator's inbox, and approving it again re-runs the skill. That is correct
 * when the failure happened before anything was touched, and dangerous when it
 * did not: `runSkill` flushes coalesced writes in a `finally` "even on
 * failure", and its 30s timeout abandons a handler that keeps running — both
 * are ways a skill mutates and then reports an error.
 *
 * So the outcome depends on how far the skill got:
 *   never reached a service → `pending`, safe to retry
 *   reached a service       → `failed`, a human reopens it after verifying
 *
 * **Validates: #453 acceptance — execution failure is observable, retry explicit**
 */

const SITE = 'site_g1_failed';
const ADMIN = 'usr_g1_failed_admin';

describe.skipIf(!hasDbIntegrationUrl)('G1 failed/unknown outcome — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration();
    await db.insert(sites).values({ id: SITE, name: 'G1 failed outcome' }).onConflictDoNothing();
    await db.insert(users).values({ id: ADMIN, email: 'g1-failed@example.dev' }).onConflictDoNothing();
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE));
  });

  async function seedPending() {
    await db.delete(agentGoals).where(eq(agentGoals.siteId, SITE));
    await db.delete(aiApprovals).where(eq(aiApprovals.siteId, SITE));
    await db.delete(activity).where(eq(activity.siteId, SITE));

    const [goal] = await db.insert(agentGoals).values({
      siteId: SITE, title: 'G1 failed', source: 'api',
      assigneeAgent: 'lumibase-copilot', status: 'in_progress',
    }).returning();
    const [run] = await db.insert(agentRuns).values({
      siteId: SITE, goalId: goal!.id, agentName: 'lumibase-copilot', status: 'awaiting_approval',
    }).returning();
    const [legacy] = await db.insert(aiApprovals).values({
      siteId: SITE, skillName: 'deleteCollection', arguments: { name: 'posts' },
      status: 'pending', agentName: 'lumibase-copilot',
    }).returning();
    const [call] = await db.insert(agentToolCalls).values({
      siteId: SITE, runId: run!.id, toolName: 'deleteCollection',
      input: { name: 'posts' }, status: 'pending_approval',
    }).returning();
    const [approval] = await db.insert(agentApprovals).values({
      siteId: SITE, runId: run!.id, legacyApprovalId: legacy!.id,
      subjectType: 'tool_call', subjectId: call!.id, status: 'pending',
      requestedByAgent: 'lumibase-copilot',
    }).returning();

    return { legacyId: legacy!.id, approvalId: approval!.id };
  }

  function harnessWith(deleteCollection: ReturnType<typeof vi.fn>) {
    return new AISecureHarness({
      db, siteId: SITE,
      schemaService: { deleteCollection } as never,
      enableAgentHarnessAudit: true,
    });
  }

  async function statusOf(approvalId: string) {
    const [row] = await db.select().from(agentApprovals)
      .where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.siteId, SITE)));
    return row!;
  }

  it('marks the approval failed when the skill fails AFTER reaching the service', async () => {
    const { legacyId, approvalId } = await seedPending();
    // Threw from inside the service: the mutation may be half-applied.
    const deleteCollection = vi.fn().mockRejectedValue(new Error('connection reset mid-delete'));

    const result = await harnessWith(deleteCollection).executeApproved(legacyId, ADMIN, ['*']);

    expect(result.status).toBe('denied');
    expect(deleteCollection).toHaveBeenCalledTimes(1);

    const row = await statusOf(approvalId);
    // NOT pending: re-approving would re-run a possibly-applied delete.
    expect(row.status).toBe('failed');
    expect(row.decisionReason).toMatch(/side effect is unknown/i);
  });

  it('returns the approval to pending when the skill fails BEFORE reaching the service', async () => {
    const { legacyId, approvalId } = await seedPending();
    // No SchemaService at all: the handler throws SCHEMA_SERVICE_NOT_CONFIGURED
    // before any service call, so nothing can have happened.
    const harness = new AISecureHarness({ db, siteId: SITE, enableAgentHarnessAudit: true, keys: {} as never });

    const result = await harness.executeApproved(legacyId, ADMIN, ['*']);

    expect(result.status).toBe('denied');
    const row = await statusOf(approvalId);
    expect(row.status).toBe('pending');
  });

  it('a failed approval cannot be decided again', async () => {
    const { legacyId, approvalId } = await seedPending();
    const deleteCollection = vi.fn().mockRejectedValue(new Error('boom'));
    const harness = harnessWith(deleteCollection);

    await harness.executeApproved(legacyId, ADMIN, ['*']);
    expect((await statusOf(approvalId)).status).toBe('failed');

    // The safety property: no second execution without a human reopening it.
    const second = await harness.executeApproved(legacyId, ADMIN, ['*']);
    expect(second.status).toBe('denied');
    expect(deleteCollection).toHaveBeenCalledTimes(1);
  });

  it('the claim sweeper never revives a failed approval', async () => {
    const { legacyId, approvalId } = await seedPending();
    await harnessWith(vi.fn().mockRejectedValue(new Error('boom')))
      .executeApproved(legacyId, ADMIN, ['*']);

    const { sweepStaleApprovalClaims } = await import('../approval-claim-sweeper');
    const released = await sweepStaleApprovalClaims({ db }, new Date(), 0);

    expect(released.map((r) => r.approvalId)).not.toContain(approvalId);
    expect((await statusOf(approvalId)).status).toBe('failed');
  });

  it('a reopened approval executes again, exactly once', async () => {
    const { legacyId, approvalId } = await seedPending();
    const deleteCollection = vi.fn().mockRejectedValueOnce(new Error('boom'));
    const harness = harnessWith(deleteCollection);

    await harness.executeApproved(legacyId, ADMIN, ['*']);
    expect((await statusOf(approvalId)).status).toBe('failed');

    // What the reopen endpoint does: failed → pending after a human check.
    await db.update(agentApprovals)
      .set({ status: 'pending', decidedAt: null, decidedBy: null })
      .where(eq(agentApprovals.id, approvalId));

    deleteCollection.mockResolvedValue({ deleted: true });
    const retry = await harness.executeApproved(legacyId, ADMIN, ['*']);

    expect(retry.status).toBe('executed');
    expect(deleteCollection).toHaveBeenCalledTimes(2);
    expect((await statusOf(approvalId)).status).toBe('approved');
  });
});
