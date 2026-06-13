import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  AUTONOMY_LEVELS,
  IRREVERSIBLE_HARD_CEILING,
  demotedLevel,
  resolveAutonomy,
} from '../autonomy-service';

/**
 * Feature: content-os, Property 3: Autonomy resolver.
 *
 * resolveAutonomy = min(grant-or-default, intentCap, hard ceiling):
 * - no grant → L2 for safe capabilities, L1 for dangerous ones;
 * - the result never exceeds the intent cap when one is set;
 * - irreversible actions never resolve above L2, regardless of grants;
 * - the result is always a valid level 0-4.
 *
 * Also covers the demotion half of Property 7: demotion always lowers the
 * level (or is already at/below the floor), and high severity lands at L1.
 *
 * **Validates: Requirements 12.2, 12.3, 12.6, 12.7**
 */

const levelArb = fc.integer({ min: 0, max: 4 });
const maybeGrantArb = fc.option(levelArb, { nil: null });
const maybeCapArb = fc.option(levelArb, { nil: null });

describe('Feature: content-os, Property 3: Autonomy resolver', () => {
  it('defaults to L2 (safe) / L1 (dangerous) when no grant exists', () => {
    fc.assert(
      fc.property(fc.boolean(), (dangerous) => {
        const level = resolveAutonomy({ grantLevel: null, dangerous });
        expect(level).toBe(dangerous ? AUTONOMY_LEVELS.PROPOSE : AUTONOMY_LEVELS.CO_SIGN);
      }),
      { numRuns: 100 },
    );
  });

  it('never exceeds min(grant-or-default, intentCap, hard ceiling)', () => {
    fc.assert(
      fc.property(maybeGrantArb, fc.boolean(), maybeCapArb, fc.boolean(), (grant, dangerous, cap, irreversible) => {
        const level = resolveAutonomy({ grantLevel: grant, dangerous, intentCap: cap, irreversible });
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(4);
        const base = grant === null ? (dangerous ? 1 : 2) : grant;
        expect(level).toBeLessThanOrEqual(base);
        if (cap !== null) expect(level).toBeLessThanOrEqual(cap);
        if (irreversible) expect(level).toBeLessThanOrEqual(IRREVERSIBLE_HARD_CEILING);
      }),
      { numRuns: 300 },
    );
  });

  it('equals the exact minimum of the applicable bounds', () => {
    fc.assert(
      fc.property(levelArb, fc.boolean(), levelArb, fc.boolean(), (grant, dangerous, cap, irreversible) => {
        const level = resolveAutonomy({ grantLevel: grant, dangerous, intentCap: cap, irreversible });
        const bounds = [grant, cap, ...(irreversible ? [IRREVERSIBLE_HARD_CEILING] : [])];
        expect(level).toBe(Math.min(...bounds));
      }),
      { numRuns: 300 },
    );
  });

  it('clamps out-of-range grant levels into 0-4', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 100 }), fc.boolean(), (grant, dangerous) => {
        const level = resolveAutonomy({ grantLevel: grant, dangerous });
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(4);
      }),
      { numRuns: 100 },
    );
  });
});

describe('Feature: content-os, Property 7 (demotion half): demotions only go down', () => {
  it('always lowers the level or stays at the floor; high severity lands at L1 or below', () => {
    fc.assert(
      fc.property(levelArb, fc.constantFrom<'low' | 'medium' | 'high'>('low', 'medium', 'high'), (current, severity) => {
        const next = demotedLevel(current, severity);
        expect(next).toBeLessThanOrEqual(current);
        expect(next).toBeGreaterThanOrEqual(0);
        if (severity === 'high') {
          expect(next).toBeLessThanOrEqual(AUTONOMY_LEVELS.PROPOSE);
        } else if (current > 0) {
          expect(next).toBe(current - 1);
        }
      }),
      { numRuns: 200 },
    );
  });
});
