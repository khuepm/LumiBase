import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  __COMPARE_BUFFER_SIZE_FOR_TESTS as BUF,
  pathEqualsConstantTime,
} from '../path-compare';

/**
 * Feature: admin-setup-wizard, task 4.1 — `pathEqualsConstantTime`.
 *
 * This file covers the *correctness* axes of Property 6 (the timing
 * variance bound itself is checked by the dedicated security test
 * `path-compare.timing.test.ts` in task 4.6 — running 10k iterations
 * is too slow / too flaky for the standard unit-test budget):
 *
 *   1. equal strings → `true`
 *   2. any differing position → `false`
 *   3. differing lengths → `false`
 *   4. correctness under fixed-size 64-byte padding, including the
 *      length-XOR guard against zero-byte tail aliasing
 *
 * **Validates: Requirements 5.7**
 * **Validates: Property 6 (Constant-Time Path Compare — correctness side)**
 */

// A generator for valid-shaped admin paths so property tests focus on
// realistic input. The shape mirrors Req 4.2 (`^/[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$`)
// but keeps the upper bound at 32 chars to stay well clear of the
// 64-byte truncation boundary for byte-equality checks; a separate
// dedicated test covers the boundary explicitly.
const adminPathArb = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
    fc.stringMatching(/^[a-z0-9-]{2,30}$/),
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  )
  .map(([head, mid, tail]) => `/${head}${mid}${tail}`);

describe('pathEqualsConstantTime — equality (correctness)', () => {
  it('returns true for byte-identical inputs', () => {
    fc.assert(
      fc.property(adminPathArb, (p) => {
        expect(pathEqualsConstantTime(p, p)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('returns true for two independently-built but equal strings', () => {
    // Defensive: in V8, identical literals can become the same object;
    // here we force fresh allocations to make sure we're not just
    // exercising reference equality at some lower layer.
    const a = ['/lumi-', '7f3a9c'].join('');
    const b = `/lumi-7f3a9c`;
    expect(a).not.toBe(b === a ? '' : a); // sanity — same value
    expect(pathEqualsConstantTime(a, b)).toBe(true);
  });

  it('returns true for the empty string compared with itself', () => {
    expect(pathEqualsConstantTime('', '')).toBe(true);
  });
});

describe('pathEqualsConstantTime — differing positions return false', () => {
  it('flips false when any single byte position differs', () => {
    fc.assert(
      fc.property(
        adminPathArb,
        // Pick an index strictly inside the path so we never accidentally
        // mutate the leading slash to a non-slash (which still flips
        // false anyway, but the intent of the property is "interior diff").
        fc.integer({ min: 1 }),
        (p, idxSeed) => {
          const idx = 1 + (idxSeed % (p.length - 1));
          const original = p[idx]!;
          // Pick a different alphanumeric replacement char.
          const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
          const replacement = alphabet[
            (alphabet.indexOf(original) + 1) % alphabet.length
          ]!;
          // If the original wasn't in the alphabet (e.g. '-'), pick 'a'.
          const safeReplacement =
            alphabet.includes(original) ? replacement : 'a';
          if (safeReplacement === original) return; // skip: nothing to flip
          const mutated =
            p.slice(0, idx) + safeReplacement + p.slice(idx + 1);
          expect(mutated).not.toBe(p); // sanity
          expect(mutated.length).toBe(p.length); // same-length diff case
          expect(pathEqualsConstantTime(p, mutated)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('detects an explicit diff at the first byte', () => {
    expect(pathEqualsConstantTime('/lumi-7f3a9c', 'Xlumi-7f3a9c')).toBe(false);
  });

  it('detects an explicit diff at the last byte', () => {
    expect(pathEqualsConstantTime('/lumi-7f3a9c', '/lumi-7f3a9d')).toBe(false);
  });

  it('detects diffs deep inside long paths (near the 64-byte boundary)', () => {
    // 1 leading slash + 62 chars of 'a' + 1 differing char = 64 chars.
    const base = '/' + 'a'.repeat(62) + 'b';
    const flip = '/' + 'a'.repeat(62) + 'c';
    expect(base.length).toBe(BUF);
    expect(flip.length).toBe(BUF);
    expect(pathEqualsConstantTime(base, flip)).toBe(false);
  });
});

describe('pathEqualsConstantTime — length differences return false', () => {
  it('returns false when one input is a prefix of the other', () => {
    fc.assert(
      fc.property(adminPathArb, (p) => {
        const shorter = p.slice(0, p.length - 1);
        // The wizard's normalisation never produces a length-1 string,
        // but the helper itself must still reject the prefix case
        // regardless of upstream invariants.
        expect(pathEqualsConstantTime(p, shorter)).toBe(false);
        expect(pathEqualsConstantTime(shorter, p)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('returns false when comparing a string against the empty string', () => {
    expect(pathEqualsConstantTime('/lumi-7f3a9c', '')).toBe(false);
    expect(pathEqualsConstantTime('', '/lumi-7f3a9c')).toBe(false);
  });

  it('length-XOR seed catches zero-byte tail aliasing', () => {
    // Without the `a.length ^ b.length` seed, the byte-XOR loop alone
    // would compare `'/abc'` (4 bytes) against `'/abc\0\0\0…'` (where
    // the tail is the zero-pad anyway) as equal, because both buffers
    // hold the same 64 bytes after padding. The seed guarantees the
    // length difference flips `diff` away from 0.
    const a = '/abc-xyz';
    const b = '/abc-xyz\u0000';
    expect(a.length).not.toBe(b.length);
    expect(pathEqualsConstantTime(a, b)).toBe(false);
  });
});

describe('pathEqualsConstantTime — robustness', () => {
  it('does not throw on non-string inputs and treats them as empty', () => {
    // Type-erased to mirror "what if upstream forgets to validate".
    const f = pathEqualsConstantTime as unknown as (
      a: unknown,
      b: unknown,
    ) => boolean;
    expect(f(undefined, undefined)).toBe(true); // both coerced to ''
    expect(f(null, null)).toBe(true);
    expect(f('/lumi-7f3a9c', undefined)).toBe(false);
    expect(f(undefined, '/lumi-7f3a9c')).toBe(false);
  });

  it('treats the buffer size as exactly 64 bytes', () => {
    // The middleware (task 4.2) relies on this width matching the
    // Req 4.2 max admin path length. If someone retunes the value,
    // this test forces them to revisit the spec note.
    expect(BUF).toBe(64);
  });
});
