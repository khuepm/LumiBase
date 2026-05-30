import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { normalizeEmail } from '../email-normalize';

/**
 * Feature: admin-setup-wizard, task 6.3 — centralised email
 * normalisation.
 *
 * The LoginGuard counter, the `users` lookup, the hooks, and the
 * middleware all key on the same canonical form of an email address.
 * If any of them drift, lockout transitions silently break — a
 * "Foo@Example.com" attempt would write to one bucket and read from
 * another. This file pins the contract of the shared helper.
 *
 * Validates: Requirements 7.1 (and the wider design §6.5 contract for
 * email key consistency across the LoginGuard surface).
 */

describe('normalizeEmail', () => {
  it('lowercases ASCII addresses', () => {
    expect(normalizeEmail('Foo@Example.com')).toBe('foo@example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('   foo@example.com\t\n')).toBe('foo@example.com');
  });

  it('combines trim and lowercase in a single pass', () => {
    expect(normalizeEmail('  Foo@EXAMPLE.com ')).toBe('foo@example.com');
  });

  it('returns the empty string for null', () => {
    expect(normalizeEmail(null)).toBe('');
  });

  it('returns the empty string for undefined', () => {
    expect(normalizeEmail(undefined)).toBe('');
  });

  it('does not coerce literal null into the string "null"', () => {
    // Guard against a regression where `String(input)` is used in
    // place of `String(input ?? '')` — the former would map `null`
    // to the literal four-character string "null", which would then
    // collide with users whose email is somehow stored as that word.
    expect(normalizeEmail(null)).not.toBe('null');
    expect(normalizeEmail(undefined)).not.toBe('undefined');
  });

  it('collapses an all-whitespace input to the empty string', () => {
    // The empty string is the sentinel the counter / lookup code
    // uses to short-circuit work — see `PostgresCounterStore`'s
    // length check.
    expect(normalizeEmail('   \t\n  ')).toBe('');
  });

  it('preserves internal whitespace', () => {
    // RFC 5321 doesn't allow whitespace in the local-part, but
    // normalisation is not validation: the helper isn't responsible
    // for rejecting structurally invalid addresses. The /login flow
    // returns the same generic 401 either way.
    expect(normalizeEmail('foo @example.com')).toBe('foo @example.com');
  });

  it('is idempotent for already-normalised input', () => {
    fc.assert(
      fc.property(
        fc.emailAddress(),
        (email) => {
          const once = normalizeEmail(email);
          const twice = normalizeEmail(once);
          return once === twice;
        },
      ),
    );
  });

  it('matches Postgres lower() semantics for any string', () => {
    // Postgres's `lower()` uses the Unicode default case-folding
    // algorithm, which matches `String.prototype.toLowerCase`. We
    // sanity-check the contract by verifying that the helper agrees
    // with `s.trim().toLowerCase()` for arbitrary strings.
    fc.assert(
      fc.property(fc.string(), (s) => normalizeEmail(s) === s.trim().toLowerCase()),
    );
  });
});
