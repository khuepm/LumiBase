/**
 * Pure Change Feed subscription domain logic (design §3.2, Req 3.3, 6.2).
 *
 * Kept free of Drizzle/Hono so the state machine and keyset ordering are
 * property-testable in isolation (P11, state-machine unit tests) and the
 * service/routes stay thin.
 */

import type { CdcCursor, CdcSubscriptionStatus } from '@lumibase/contracts/schemas';

/** Who is attempting a status transition. */
export type TransitionVia = 'admin' | 'dispatcher' | 'retention' | 'replay';

/**
 * State machine (design §3.2):
 *   active ⇄ paused        — admin only
 *   active → dead          — dispatcher (10 consecutive failures)
 *   active|paused → stale  — retention (cursor pruned past)
 *   dead|stale → active    — ONLY via explicit replay/resume (replay)
 *
 * Everything else is invalid; same→same is a no-op allowed for idempotence.
 */
export function canTransitionSubscription(
  from: CdcSubscriptionStatus,
  to: CdcSubscriptionStatus,
  via: TransitionVia,
): boolean {
  if (from === to) return true;
  switch (via) {
    case 'admin':
      return (
        (from === 'active' && to === 'paused') ||
        (from === 'paused' && to === 'active')
      );
    case 'dispatcher':
      return from === 'active' && to === 'dead';
    case 'retention':
      return (from === 'active' || from === 'paused') && to === 'stale';
    case 'replay':
      // Replay resets any subscription back to active (with a rewound cursor).
      return to === 'active';
    default:
      return false;
  }
}

/**
 * Total order over the feed keyset `(occurredAtMs, eventId)` — the single
 * comparison every ordering rule (ack monotonicity, pagination, dispatch)
 * derives from. Returns <0, 0, >0 like a comparator.
 */
export function compareKeyset(a: CdcCursor, b: CdcCursor): number {
  if (a.occurredAtMs !== b.occurredAtMs) return a.occurredAtMs - b.occurredAtMs;
  if (a.eventId === b.eventId) return 0;
  return a.eventId < b.eventId ? -1 : 1;
}

/**
 * Ack monotonicity (Req 3.3): a new cursor may only move forward (or stay).
 * Rewinding is reserved for replay.
 */
export function isAckAllowed(current: CdcCursor | null, next: CdcCursor): boolean {
  if (current === null) return true;
  return compareKeyset(next, current) >= 0;
}
