import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { blockedPinnedFields, computeNextPinnedFields } from '../item-service';

/**
 * Feature: content-os, Property 2: Pin supremacy (Law Zero).
 *
 * For any item with pinned fields P and any agent patch touching fields K:
 * - every field in K ∩ P is blocked, and only those (agents never write
 *   pinned fields; unpinned fields are unaffected);
 * - human writes are never blocked by pins;
 * - human edits on intent-governed collections pin exactly the touched
 *   fields (idempotent union); agent writes never alter the pin set.
 *
 * **Validates: Requirements 8.1, 8.3**
 */

const fieldArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);
const fieldsArb = fc.uniqueArray(fieldArb, { maxLength: 12 });

describe('Feature: content-os, Property 2: Pin supremacy (Law Zero)', () => {
  it('blocks exactly the agent-patched fields that are pinned', () => {
    fc.assert(
      fc.property(fieldsArb, fieldsArb, (pinned, patched) => {
        const blocked = blockedPinnedFields(pinned, patched, 'agent');
        const pinnedSet = new Set(pinned);
        // Soundness: everything blocked is both patched and pinned.
        for (const field of blocked) {
          expect(pinnedSet.has(field)).toBe(true);
          expect(patched.includes(field)).toBe(true);
        }
        // Completeness: nothing patched-and-pinned escapes the block.
        for (const field of patched) {
          if (pinnedSet.has(field)) expect(blocked).toContain(field);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never blocks human writes regardless of pins', () => {
    fc.assert(
      fc.property(fieldsArb, fieldsArb, (pinned, patched) => {
        expect(blockedPinnedFields(pinned, patched, 'human')).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('human edits on governed collections pin exactly the union of touched fields', () => {
    fc.assert(
      fc.property(fieldsArb, fieldsArb, (pinned, patched) => {
        const next = computeNextPinnedFields(pinned, patched, 'human', true);
        const expected = new Set([...pinned, ...patched]);
        expect(new Set(next)).toEqual(expected);
        // Idempotent: pinning again changes nothing.
        expect(new Set(computeNextPinnedFields(next, patched, 'human', true))).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('agent writes and un-governed human writes never alter the pin set', () => {
    fc.assert(
      fc.property(fieldsArb, fieldsArb, fc.boolean(), (pinned, patched, governed) => {
        expect(computeNextPinnedFields(pinned, patched, 'agent', governed)).toEqual([...pinned]);
        expect(computeNextPinnedFields(pinned, patched, 'human', false)).toEqual([...pinned]);
      }),
      { numRuns: 200 },
    );
  });
});
