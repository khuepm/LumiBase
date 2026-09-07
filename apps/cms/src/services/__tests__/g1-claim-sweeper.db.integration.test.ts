import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  activity,
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
import { CLAIM_STALE_AFTER_MS, sweepStaleApprovalClaims } from '../approval-claim-sweeper';

/**
 * G1 (#453) — the sweeper that recovers approval claims abandoned by a dead
 * process.
 *
 * Every in-process failure path releases its own claim, so what is left to
 * cover is the case no handler can: the process disappearing mid-execution.
 * These tests simulate that the only honest way — by leaving a row in
 * `deciding` with no live holder — and then check the sweep does the right
 * thing, including the cases where it must do NOTHING.
 *
 * Runs against real PostgreSQL because the behaviour under test is a
 * time-bounded conditional update; a fake DB would only replay the assumptions
 * the code already makes. Skips without DATABASE_URL.
 *
 * **Validates: #453 acceptance — interrupted execution is observable and retryable**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_g1_sweep';
const ADMIN = 'usr_g1_sweep_admin';

describe('G1 stale approval-claim sweeper — DB integration', () => {
  let db: Database;
  let canConnect = false;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping G1 sweeper DB test: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping G1 sweeper DB test: database not reachable.');
      return;
    }
    await db.insert(sites).values({ id: SITE, name: 'G1 sweeper' }).onConflictDoNothing();
    await db.insert(users).values({ id: ADMIN, email: 'g1-sweep@example.dev' }).onConflictDoNothing();
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE));
  });

  async function seedApproval(status: string, claimAgeMs: number | null) {
    await db.delete(agentGoals).where(eq(agentGoals.siteId, SITE));
    await db.delete(aiApprovals).where(eq(aiApprovals.siteId, SITE));
    await db.delete(activity).where(eq(activity.siteId, SITE));

    const [goal] = await db.insert(agentGoals).values({
      siteId: SITE, title: 'G1 sweeper', source: 'api',
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
      subjectType: 'tool_call', subjectId: toolCall!.id,
      status,
      decidedBy: claimAgeMs === null ? null : ADMIN,
      decidedAt: claimAgeMs === null ? null : new Date(Date.now() - claimAgeMs),
      requestedByAgent: 'lumibase-copilot',
    }).returning();

    return { approvalId: approval!.id, legacyId: legacy!.id };
  }

  it('releases a claim abandoned past the stale window', async () => {
    if (!canConnect) return;
    const { approvalId } = await seedApproval('deciding', CLAIM_STALE_AFTER_MS + 60_000);

    const released = await sweepStaleApprovalClaims({ db });

    expect(released.map((r) => r.approvalId)).toContain(approvalId);

    const [row] = await db.select().from(agentApprovals)
      .where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.siteId, SITE)));
    // Back where Mission Control's `status === 'pending'` inbox can see it.
    expect(row!.status).toBe('pending');
    expect(row!.decidedBy).toBeNull();
    expect(row!.decidedAt).toBeNull();
  });

  it('records the release so the interrupted execution is not silent', async () => {
    if (!canConnect) return;
    const { approvalId } = await seedApproval('deciding', CLAIM_STALE_AFTER_MS + 60_000);

    await sweepStaleApprovalClaims({ db });

    const rows = await db.select().from(activity)
      .where(and(eq(activity.siteId, SITE), eq(activity.action, 'approval.claim_released')));
    expect(rows).toHaveLength(1);

    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload['approvalId']).toBe(approvalId);
    expect(payload['claimedBy']).toBe(ADMIN);
    // The ambiguity is stated, not resolved: a re-approval replays the action.
    expect(String(payload['note'])).toMatch(/may or may not have run/i);
  });

  it('leaves a fresh claim alone — a live execution is never interrupted', async () => {
    if (!canConnect) return;
    const { approvalId } = await seedApproval('deciding', 30_000);

    const released = await sweepStaleApprovalClaims({ db });

    expect(released).toHaveLength(0);
    const [row] = await db.select().from(agentApprovals)
      .where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.siteId, SITE)));
    expect(row!.status).toBe('deciding');
  });

  it('never touches a decided approval, however old', async () => {
    if (!canConnect) return;
    for (const status of ['approved', 'rejected', 'pending'] as const) {
      const { approvalId } = await seedApproval(status, CLAIM_STALE_AFTER_MS * 10);

      const released = await sweepStaleApprovalClaims({ db });

      expect(released).toHaveLength(0);
      const [row] = await db.select().from(agentApprovals)
        .where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.siteId, SITE)));
      expect(row!.status).toBe(status);
    }
  });

  it('honours the staleness window it is given', async () => {
    if (!canConnect) return;
    const { approvalId } = await seedApproval('deciding', 60_000);

    // One minute old. Under the default window it is a live execution and must
    // be left alone; under a 30-second window it is abandoned and released.
    // Same row, same sweep — the deadline is what decides.
    expect(await sweepStaleApprovalClaims({ db })).toHaveLength(0);

    const released = await sweepStaleApprovalClaims({ db }, new Date(), 30_000);
    expect(released.map((r) => r.approvalId)).toEqual([approvalId]);

    const [row] = await db.select().from(agentApprovals)
      .where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.siteId, SITE)));
    expect(row!.status).toBe('pending');
  });

  it('is safe to run twice concurrently — one release, one audit row', async () => {
    if (!canConnect) return;
    await seedApproval('deciding', CLAIM_STALE_AFTER_MS + 60_000);

    const [a, b] = await Promise.all([
      sweepStaleApprovalClaims({ db }),
      sweepStaleApprovalClaims({ db }),
    ]);

    // Whichever sweep wins the conditional update is the only one that reports
    // and audits the release.
    expect(a!.length + b!.length).toBe(1);
    const rows = await db.select().from(activity)
      .where(and(eq(activity.siteId, SITE), eq(activity.action, 'approval.claim_released')));
    expect(rows).toHaveLength(1);
  });

  it('makes a swept approval decidable again, and it executes once', async () => {
    if (!canConnect) return;
    const { legacyId } = await seedApproval('deciding', CLAIM_STALE_AFTER_MS + 60_000);

    await sweepStaleApprovalClaims({ db });

    // The whole point of releasing to `pending`: an operator can retry.
    const deleteCollection = vi.fn().mockResolvedValue({ deleted: true });
    const harness = new AISecureHarness({
      db,
      siteId: SITE,
      schemaService: { deleteCollection } as never,
      enableAgentHarnessAudit: true,
    });

    const result = await harness.executeApproved(legacyId, ADMIN, ['*']);

    expect(result.status).toBe('executed');
    expect(deleteCollection).toHaveBeenCalledTimes(1);
  });

  it('releases exactly the stale claims and nothing else', async () => {
    if (!canConnect) return;
    // A mixed table is what makes the two predicates separable. With a single
    // row, a sweep missing either guard still looks correct; here, dropping the
    // deadline sweeps `fresh`, and dropping the `deciding` guard sweeps the old
    // decided rows. Only both together produce this exact result.
    await seedApproval('deciding', CLAIM_STALE_AFTER_MS + 60_000);
    const [staleRow] = await db.select().from(agentApprovals).where(eq(agentApprovals.siteId, SITE));
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.siteId, SITE));

    const old = CLAIM_STALE_AFTER_MS * 10;
    const extra: Array<{ label: string; status: string; ageMs: number }> = [
      { label: 'fresh', status: 'deciding', ageMs: 10_000 },
      { label: 'approved-old', status: 'approved', ageMs: old },
      { label: 'rejected-old', status: 'rejected', ageMs: old },
    ];

    const ids: Record<string, string> = { stale: staleRow!.id };
    for (const row of extra) {
      const [legacy] = await db.insert(aiApprovals).values({
        siteId: SITE, skillName: 'deleteCollection', arguments: { name: row.label },
        status: 'pending', agentName: 'lumibase-copilot',
      }).returning();
      const [call] = await db.insert(agentToolCalls).values({
        siteId: SITE, runId: run!.id, toolName: 'deleteCollection',
        input: { name: row.label }, status: 'pending_approval',
      }).returning();
      const [approval] = await db.insert(agentApprovals).values({
        siteId: SITE, runId: run!.id, legacyApprovalId: legacy!.id,
        subjectType: 'tool_call', subjectId: call!.id, status: row.status,
        decidedBy: ADMIN, decidedAt: new Date(Date.now() - row.ageMs),
        requestedByAgent: 'lumibase-copilot',
      }).returning();
      ids[row.label] = approval!.id;
    }

    const released = await sweepStaleApprovalClaims({ db });

    // Exactly the stale claim, by id — not "at least" and not a count.
    expect(released.map((r) => r.approvalId)).toEqual([ids['stale']]);

    const after = await db.select().from(agentApprovals).where(eq(agentApprovals.siteId, SITE));
    const statusById = Object.fromEntries(after.map((r) => [r.id, r.status]));
    expect(statusById[ids['stale']!]).toBe('pending');
    expect(statusById[ids['fresh']!]).toBe('deciding');
    expect(statusById[ids['approved-old']!]).toBe('approved');
    expect(statusById[ids['rejected-old']!]).toBe('rejected');
  });
});
