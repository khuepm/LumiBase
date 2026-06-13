import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  ROLE_LIBRARY,
  intersectCapabilities,
} from '../agent-role-service';
import { PlannerError, splitBudget } from '../planner-service';

/**
 * Feature: content-os, Module C (task 10): multi-agent org invariants.
 *
 * - Capability narrowing: effective capability = role ∩ grant — the result
 *   never exceeds either side (Req 10.4).
 * - Role library: minimal capability sets; the Writer never holds any
 *   `schema:*` capability (Req 10.3).
 * - Planner budget inheritance: sub-goals split exactly the remaining
 *   budget — never minting new tool calls (Req 10.1).
 *
 * **Validates: Requirements 10.1, 10.3, 10.4**
 */

const capabilityArb = fc.constantFrom(
  'items:read',
  'items:write',
  'schema:read',
  'schema:write',
  'media:write',
  'review:items',
  'goals:write',
);
const capSetArb = fc.uniqueArray(capabilityArb, { minLength: 0, maxLength: 6 });

describe('Feature: content-os, Module C: capability intersection (Req 10.4)', () => {
  it('never exceeds the role nor the grant', () => {
    fc.assert(
      fc.property(capSetArb, capSetArb, (roleCaps, grant) => {
        const effective = intersectCapabilities(roleCaps, grant);
        for (const cap of effective) {
          expect(roleCaps).toContain(cap);
          expect(grant).toContain(cap);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('equals the exact set intersection without wildcards', () => {
    fc.assert(
      fc.property(capSetArb, capSetArb, (roleCaps, grant) => {
        const effective = new Set(intersectCapabilities(roleCaps, grant));
        const expected = new Set(roleCaps.filter((c) => grant.includes(c)));
        expect(effective).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('a wildcard grant collapses to the role capabilities (role is the ceiling)', () => {
    fc.assert(
      fc.property(capSetArb, capSetArb, (roleCaps, rest) => {
        const effective = intersectCapabilities(roleCaps, ['*', ...rest]);
        expect(new Set(effective)).toEqual(new Set(roleCaps));
        expect(effective).not.toContain('*');
      }),
      { numRuns: 100 },
    );
  });

  it('a wildcard role collapses to the grant (grant is the ceiling)', () => {
    fc.assert(
      fc.property(capSetArb, (grant) => {
        const effective = intersectCapabilities(['*'], grant);
        expect(new Set(effective)).toEqual(new Set(grant));
      }),
      { numRuns: 100 },
    );
  });

  it('the empty role or empty grant always yields nothing (fail closed)', () => {
    fc.assert(
      fc.property(capSetArb, (caps) => {
        expect(intersectCapabilities([], caps)).toEqual([]);
        expect(intersectCapabilities(caps, [])).toEqual([]);
      }),
      { numRuns: 50 },
    );
  });
});

describe('Feature: content-os, Module C: role library (Req 10.3)', () => {
  it('the Writer never holds a schema capability', () => {
    const writer = ROLE_LIBRARY.find((role) => role.name === 'writer');
    expect(writer).toBeDefined();
    expect(writer!.capabilities.some((cap) => cap.startsWith('schema:'))).toBe(false);
  });

  it('every role has a unique name and a non-empty minimal capability set', () => {
    const names = ROLE_LIBRARY.map((role) => role.name);
    expect(new Set(names).size).toBe(names.length);
    for (const role of ROLE_LIBRARY) {
      expect(role.capabilities.length).toBeGreaterThan(0);
      expect(role.capabilities).not.toContain('*');
      expect(role.systemPromptRef).toMatch(/^roles\//);
    }
  });

  it('only the planner can create goals; only the librarian touches media', () => {
    for (const role of ROLE_LIBRARY) {
      if (role.name !== 'planner') expect(role.capabilities).not.toContain('goals:write');
      if (role.name !== 'librarian') expect(role.capabilities).not.toContain('media:write');
    }
  });
});

describe('Feature: content-os, Module C: planner budget split (Req 10.1)', () => {
  it('distributes exactly the remaining budget, at least 1 per sub-goal', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: 20 }),
        (remaining, count) => {
          fc.pre(remaining >= count);
          const shares = splitBudget(remaining, count);
          expect(shares).toHaveLength(count);
          expect(shares.reduce((a, b) => a + b, 0)).toBe(remaining);
          for (const share of shares) expect(share).toBeGreaterThanOrEqual(1);
          // Fair split: shares differ by at most 1.
          expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('refuses to fund more sub-goals than remaining budget allows', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 19 }),
        fc.integer({ min: 1, max: 20 }),
        (remaining, count) => {
          fc.pre(remaining < count);
          expect(() => splitBudget(remaining, count)).toThrowError(PlannerError);
        },
      ),
      { numRuns: 100 },
    );
  });
});
