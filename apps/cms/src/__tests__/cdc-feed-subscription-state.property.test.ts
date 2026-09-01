import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  canTransitionSubscription,
  compareKeyset,
  isAckAllowed,
  type TransitionVia,
} from '../modules/cdc/change-feed/subscription-state';
import type { CdcCursor, CdcSubscriptionStatus } from '@lumibase/contracts';

/**
 * Feature: cdc-extension-integration, Property 11: Ack không lùi
 *
 * For any sequence of ack attempts, the accepted cursor SHALL be monotonic
 * non-decreasing under the keyset order; any rewinding ack SHALL be rejected
 * (Req 3.3 — rewind is reserved for replay).
 */

const cursorArb: fc.Arbitrary<CdcCursor> = fc.record({
  occurredAtMs: fc.integer({ min: 0, max: 4_102_444_800_000 }),
  eventId: fc.stringMatching(/^[A-Za-z0-9_-]{1,21}$/),
});

const STATUSES: CdcSubscriptionStatus[] = ['active', 'paused', 'dead', 'stale'];
const VIAS: TransitionVia[] = ['admin', 'dispatcher', 'retention', 'replay'];

describe('Feature: cdc-extension-integration, Property 11: Ack không lùi', () => {
  it('accepts an ack iff it does not move the cursor backwards', () => {
    fc.assert(
      fc.property(cursorArb, cursorArb, (current, next) => {
        const allowed = isAckAllowed(current, next);
        expect(allowed).toBe(compareKeyset(next, current) >= 0);
      }),
      { numRuns: 200 },
    );
  });

  it('applying only allowed acks keeps the cursor monotonic non-decreasing', () => {
    fc.assert(
      fc.property(fc.array(cursorArb, { maxLength: 30 }), (attempts) => {
        let current: CdcCursor | null = null;
        for (const next of attempts) {
          if (isAckAllowed(current, next)) current = next;
        }
        // Replaying the accepted sequence never observes a decrease.
        let prev: CdcCursor | null = null;
        for (const next of attempts) {
          if (isAckAllowed(prev, next)) {
            if (prev) expect(compareKeyset(next, prev)).toBeGreaterThanOrEqual(0);
            prev = next;
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('a null checkpoint accepts any first ack', () => {
    fc.assert(
      fc.property(cursorArb, (next) => {
        expect(isAckAllowed(null, next)).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it('compareKeyset is a total order: antisymmetric and transitive over samples', () => {
    fc.assert(
      fc.property(cursorArb, cursorArb, cursorArb, (a, b, c) => {
        expect(Math.sign(compareKeyset(a, b))).toBe(-Math.sign(compareKeyset(b, a)));
        if (compareKeyset(a, b) <= 0 && compareKeyset(b, c) <= 0) {
          expect(compareKeyset(a, c)).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('cdc-feed subscription state machine (design §3.2)', () => {
  it('enumerates exactly the legal transitions', () => {
    const legal = new Set([
      'active→paused:admin',
      'paused→active:admin',
      'active→dead:dispatcher',
      'active→stale:retention',
      'paused→stale:retention',
      // replay resets anything to active
      'active→active:replay',
      'paused→active:replay',
      'dead→active:replay',
      'stale→active:replay',
    ]);
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        for (const via of VIAS) {
          const key = `${from}→${to}:${via}`;
          const expected = from === to ? true : legal.has(key);
          expect(canTransitionSubscription(from, to, via), key).toBe(expected);
        }
      }
    }
  });

  it('dead/stale never resume via admin or dispatcher — only replay', () => {
    for (const from of ['dead', 'stale'] as const) {
      expect(canTransitionSubscription(from, 'active', 'admin')).toBe(false);
      expect(canTransitionSubscription(from, 'active', 'dispatcher')).toBe(false);
      expect(canTransitionSubscription(from, 'active', 'retention')).toBe(false);
      expect(canTransitionSubscription(from, 'active', 'replay')).toBe(true);
    }
  });
});
