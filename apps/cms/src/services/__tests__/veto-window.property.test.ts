import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { decideVetoCommit, filterPinnedPatch } from '../veto-service';

/**
 * Feature: content-os, Property 6: veto window.
 *
 * - A staging never commits before its autoCommitAt deadline.
 * - A veto (any non-pending approval status) always wins over the commit
 *   job, regardless of timing.
 * - Pin-after-staging wins at commit: the applied patch never touches a
 *   pinned field, nothing is silently lost (applied ∪ dropped = patch),
 *   and an all-pinned patch applies nothing.
 *
 * **Validates: Requirements 13.1, 13.3, 13.4, 8.6**
 */

const fieldArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/);
const patchArb = fc.dictionary(fieldArb, fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean()), {
  maxKeys: 10,
});

describe('Feature: content-os, Property 6: veto window — commit decision', () => {
  const statusArb = fc.constantFrom('pending', 'approved', 'rejected', 'expired');
  const timeArb = fc.integer({ min: 0, max: 1_000_000_000 });

  it('never commits before the deadline; a veto always wins', () => {
    fc.assert(
      fc.property(statusArb, timeArb, timeArb, (status, nowMs, deadlineMs) => {
        const decision = decideVetoCommit(status, new Date(deadlineMs), new Date(nowMs));
        if (status !== 'pending') {
          // Vetoed/decided stagings are untouchable, regardless of timing.
          expect(decision).toBe('skip');
        } else if (nowMs < deadlineMs) {
          expect(decision).toBe('wait');
        } else {
          expect(decision).toBe('commit');
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a staging without a deadline never auto-commits', () => {
    fc.assert(
      fc.property(timeArb, (nowMs) => {
        expect(decideVetoCommit('pending', null, new Date(nowMs))).toBe('skip');
      }),
      { numRuns: 100 },
    );
  });
});

describe('Feature: content-os, Property 6: pin-after-staging wins at commit (Req 8.6)', () => {
  it('the applied patch never touches a pinned field and nothing is lost silently', () => {
    fc.assert(
      fc.property(patchArb, fc.array(fieldArb, { maxLength: 12 }), (patch, pinned) => {
        const { applied, dropped } = filterPinnedPatch(patch, pinned);
        const pinnedSet = new Set(pinned);
        // Applied part is disjoint from pins.
        for (const field of Object.keys(applied)) {
          expect(pinnedSet.has(field)).toBe(false);
          expect(applied[field]).toBe(patch[field]);
        }
        // Dropped part is exactly the pinned intersection.
        for (const field of dropped) {
          expect(pinnedSet.has(field)).toBe(true);
        }
        // Accounting: applied ∪ dropped = patch keys, disjoint.
        const union = [...Object.keys(applied), ...dropped].sort();
        expect(union).toEqual(Object.keys(patch).sort());
      }),
      { numRuns: 300 },
    );
  });

  it('an all-pinned patch applies nothing (commit becomes a no-op)', () => {
    fc.assert(
      fc.property(patchArb, (patch) => {
        const { applied, dropped } = filterPinnedPatch(patch, Object.keys(patch));
        expect(Object.keys(applied)).toEqual([]);
        expect(dropped.sort()).toEqual(Object.keys(patch).sort());
      }),
      { numRuns: 200 },
    );
  });

  it('no pins means the full patch applies', () => {
    fc.assert(
      fc.property(patchArb, (patch) => {
        const { applied, dropped } = filterPinnedPatch(patch, []);
        expect(applied).toEqual(patch);
        expect(dropped).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});
