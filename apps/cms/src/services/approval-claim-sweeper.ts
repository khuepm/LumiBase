import { activity, agentApprovals, type Database } from '@lumibase/database';
import { and, asc, eq, lt } from 'drizzle-orm';

/**
 * Releases approval claims abandoned by a dead process (#453).
 *
 * Deciding an approval is claim → execute → finalize: the claim moves the row
 * to `deciding` so exactly one decision can execute it (the read-then-act
 * alternative lets two decisions both run the action). Every path that does
 * not complete releases the claim itself — a failing skill, a kill switch, a
 * cancellation, a thrown error.
 *
 * What no in-process handler can cover is the process dying mid-execution: a
 * crash, an OOM kill, a Worker eviction, a deploy that rolls the pod. The row
 * then stays `deciding` forever, and because Mission Control's inbox filters
 * on `status === 'pending'` it also stops being visible to the operator — the
 * worst combination: stuck AND invisible.
 *
 * This sweep is the safety net, deliberately shaped like `veto-commit-worker`:
 * a periodic pass that only ever undoes a claim older than the window, and
 * only from `deciding`, so it can never touch a live execution or override a
 * real decision.
 *
 * ## What a released claim means
 *
 * Releasing says "no decision was recorded", NOT "nothing happened". The
 * process died at an unknown point, so the action may have run, partially run,
 * or not run at all — and no side effect is undone here. The approval returns
 * to `pending` because that is the state an operator can act on, and each
 * release writes an `approval.claim_released` activity row so the ambiguity is
 * on the record rather than silently resolved. Re-approving replays the action:
 * safe for an idempotent skill, and something to check first for one that is
 * not.
 */

/**
 * How long a claim may be held before the sweep treats it as abandoned.
 *
 * Generous on purpose. A claim is held for exactly one skill execution, which
 * is seconds; fifteen minutes is far beyond a slow LLM-backed skill or a
 * stalled HTTP call, so a live execution is never released out from under
 * itself. The cost of waiting is that a genuinely crashed claim stays hidden
 * from the inbox a little longer — much cheaper than racing a running action.
 */
export const CLAIM_STALE_AFTER_MS = 15 * 60_000;

/** Cap per pass so one sweep cannot hold a long transaction over the table. */
const SWEEP_BATCH_SIZE = 100;

export interface ApprovalClaimSweepDeps {
  db: Database;
}

export interface ReleasedClaim {
  approvalId: string;
  siteId: string;
  /** How long the claim had been held, in ms — useful when triaging a crash. */
  heldForMs: number;
}

/**
 * Releases every claim older than `staleAfterMs`. System-level, cross-site,
 * like the veto sweep: each row is released within its own site scope.
 *
 * Returns what it released so a caller can log or alert on it. Safe to run
 * concurrently with itself and with live decisions — each release is a
 * conditional update guarded on `deciding` plus the same stale deadline, so a
 * claim that was renewed or finalized in the meantime is left alone.
 */
export async function sweepStaleApprovalClaims(
  deps: ApprovalClaimSweepDeps,
  now = new Date(),
  staleAfterMs = CLAIM_STALE_AFTER_MS,
): Promise<ReleasedClaim[]> {
  const deadline = new Date(now.getTime() - staleAfterMs);

  const stale = await deps.db
    .select({
      id: agentApprovals.id,
      siteId: agentApprovals.siteId,
      decidedAt: agentApprovals.decidedAt,
      decidedBy: agentApprovals.decidedBy,
    })
    .from(agentApprovals)
    .where(and(eq(agentApprovals.status, 'deciding'), lt(agentApprovals.decidedAt, deadline)))
    .orderBy(asc(agentApprovals.decidedAt))
    .limit(SWEEP_BATCH_SIZE);

  const released: ReleasedClaim[] = [];

  for (const row of stale) {
    // Guarded on both `deciding` and the stale deadline: if the claim holder
    // finalized, released, or re-claimed the row since the SELECT above, this
    // affects zero rows and the sweep moves on. That is what makes the sweep
    // safe to run against live traffic.
    const undone = await deps.db
      .update(agentApprovals)
      .set({ status: 'pending', decidedBy: null, decidedAt: null })
      .where(
        and(
          eq(agentApprovals.id, row.id),
          eq(agentApprovals.siteId, row.siteId),
          eq(agentApprovals.status, 'deciding'),
          lt(agentApprovals.decidedAt, deadline),
        ),
      )
      .returning({ id: agentApprovals.id });

    if (undone.length === 0) continue;

    const heldForMs = row.decidedAt ? now.getTime() - row.decidedAt.getTime() : 0;

    // The release itself is auditable. Without this the approval simply
    // reappears as pending with no trace of the interrupted execution, and a
    // reviewer re-approving it would have no way to know the action may have
    // already run once.
    await deps.db.insert(activity).values({
      siteId: row.siteId,
      action: 'approval.claim_released',
      payload: {
        approvalId: row.id,
        claimedBy: row.decidedBy,
        heldForMs,
        staleAfterMs,
        // Stated explicitly because it drives what a human should do next.
        note:
          'Execution was interrupted; the action may or may not have run. ' +
          'Verify the intended side effect before re-approving.',
      },
    });

    released.push({ approvalId: row.id, siteId: row.siteId, heldForMs });
  }

  return released;
}
