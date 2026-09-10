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
 * ## Why the sweep quarantines instead of releasing
 *
 * A crash says "no decision was recorded", NOT "nothing happened". The process
 * died at an unknown point, so the action may have run, partially run, or not
 * at all — and no side effect is undone here.
 *
 * An earlier version returned these rows to `pending`, which put them straight
 * back in the inbox where an ordinary approval re-ran the action. That defeats
 * the whole point of the `failed` outcome the in-process paths use: a fault the
 * process SURVIVED is quarantined, while a crash — strictly less knowable —
 * would have been waved through fifteen minutes later.
 *
 * So a swept claim lands in `failed`, exactly where a touched-service failure
 * lands, and rejoins normal work only through
 * `POST /agent/approvals/:id/reopen` after a human verifies what happened.
 *
 * Elapsed time is not evidence the abandoned work stopped: a JavaScript
 * timeout rejects a promise, it does not cancel the handler behind it, and a
 * crashed process may have left an in-flight request at an external provider.
 * The window bounds how long we WAIT, never what we conclude.
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

export interface QuarantinedClaim {
  approvalId: string;
  siteId: string;
  /** How long the claim had been held, in ms — useful when triaging a crash. */
  heldForMs: number;
}

/**
 * Quarantines every claim older than `staleAfterMs`. System-level, cross-site,
 * like the veto sweep: each row is handled within its own site scope.
 *
 * Returns what it quarantined so a caller can log or alert on it. Safe to run
 * concurrently with itself and with live decisions — each write is a
 * conditional update guarded on `deciding` plus the same stale deadline, so a
 * claim that was renewed or finalized in the meantime is left alone.
 */
export async function sweepStaleApprovalClaims(
  deps: ApprovalClaimSweepDeps,
  now = new Date(),
  staleAfterMs = CLAIM_STALE_AFTER_MS,
): Promise<QuarantinedClaim[]> {
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

  const quarantined: QuarantinedClaim[] = [];

  for (const row of stale) {
    const heldForMs = row.decidedAt ? now.getTime() - row.decidedAt.getTime() : 0;

    // Quarantine + audit commit together. Split, a failing audit insert would
    // leave a row marked `failed` with no record of why it was interrupted —
    // and the reopen decision depends on exactly that record. Duck-typed so the
    // fake-DB suites, which have no `transaction`, still exercise the path.
    const withTx = deps.db as Database & {
      transaction?: <T>(cb: (tx: Database) => Promise<T>) => Promise<T>;
    };

    const quarantineOne = async (tx: Database): Promise<boolean> => {
      // Guarded on both `deciding` and the stale deadline: if the claim holder
      // finalized, released, or re-claimed the row since the SELECT above, this
      // affects zero rows and the sweep moves on. That is what makes the sweep
      // safe to run against live traffic.
      const undone = await tx
        .update(agentApprovals)
        .set({
          // `failed`, not `pending`: a crashed execution is at least as
          // ambiguous as one that failed in-process, so it goes through the
          // same explicit reopen gate rather than back into the inbox as
          // ordinary work.
          status: 'failed',
          decisionReason:
            'execution was interrupted (claim abandoned); the side effect is unknown. ' +
            'Verify before reopening.',
        })
        .where(
          and(
            eq(agentApprovals.id, row.id),
            eq(agentApprovals.siteId, row.siteId),
            eq(agentApprovals.status, 'deciding'),
            lt(agentApprovals.decidedAt, deadline),
          ),
        )
        .returning({ id: agentApprovals.id });

      if (undone.length === 0) return false;

      await tx.insert(activity).values({
        siteId: row.siteId,
        action: 'approval.claim_quarantined',
        payload: {
          approvalId: row.id,
          claimedBy: row.decidedBy,
          heldForMs,
          staleAfterMs,
          // Stated explicitly because it drives what a human should do next.
          note:
            'Execution was interrupted; the action may or may not have run. ' +
            'Verify the intended side effect, then reopen the approval to retry.',
        },
      });
      return true;
    };

    const didQuarantine =
      typeof withTx.transaction === 'function'
        ? await withTx.transaction(quarantineOne)
        : await quarantineOne(deps.db);

    if (didQuarantine) {
      quarantined.push({ approvalId: row.id, siteId: row.siteId, heldForMs });
    }
  }

  return quarantined;
}
