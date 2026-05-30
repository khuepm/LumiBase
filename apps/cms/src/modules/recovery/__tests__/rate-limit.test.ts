import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  checkRecoveryRateLimit,
  recoveryRateLimitHeaders,
  __resetRecoveryRateLimitForTests,
  RECOVERY_RATE_LIMIT,
  RECOVERY_RATE_WINDOW_MS,
  RECOVERY_RATE_LIMIT_CODE,
} from '../rate-limit';

/**
 * Unit tests for the recovery rate limiter (admin-setup-wizard task
 * 10.6).
 *
 * The limiter is a pure `(ip, now) → RateLimitResult` function over a
 * module-level fixed-window bucket map, SHARED across the `/recover` and
 * `/forgot-path` endpoints (Req 14.8). An injected `now` (epoch-ms)
 * drives the window deterministically — no fake timers needed — and the
 * module-level map is reset before/after every case so the shared state
 * never leaks across tests.
 *
 * Coverage:
 *   - the first 3 requests from an IP are allowed, with `remaining`
 *     counting down 2 → 1 → 0;
 *   - the 4th request is denied (`allowed=false`) with a
 *     `retryAfterSeconds` in (0, 3600];
 *   - different IPs have independent budgets;
 *   - after the window elapses the IP gets a fresh budget;
 *   - the SHARED-counter property: 3 mixed `/recover` + `/forgot-path`
 *     calls from one IP exhaust the combined budget, so the 4th — from
 *     EITHER endpoint — is denied;
 *   - `__resetRecoveryRateLimitForTests` clears state;
 *   - `retryAfterSeconds` is a positive integer (ceil);
 *   - a denied request does not extend the window;
 *   - `recoveryRateLimitHeaders` builds the `Retry-After` header bag.
 *
 * **Validates: Requirements 14.8**
 */

const IP = '203.0.113.7';
const OTHER_IP = '198.51.100.42';

beforeEach(() => {
  __resetRecoveryRateLimitForTests();
});

afterEach(() => {
  __resetRecoveryRateLimitForTests();
});

describe('checkRecoveryRateLimit — budget within a window (Req 14.8)', () => {
  it('allows the first 3 requests with remaining counting down 2, 1, 0', () => {
    const now = 1_000_000;

    const first = checkRecoveryRateLimit(IP, now);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);
    expect(first.retryAfterSeconds).toBeUndefined();

    const second = checkRecoveryRateLimit(IP, now + 10);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(1);

    const third = checkRecoveryRateLimit(IP, now + 20);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
  });

  it('denies the 4th request with allowed=false and retryAfterSeconds in (0, 3600]', () => {
    const now = 1_000_000;
    checkRecoveryRateLimit(IP, now);
    checkRecoveryRateLimit(IP, now);
    checkRecoveryRateLimit(IP, now);

    const fourth = checkRecoveryRateLimit(IP, now);
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
    expect(fourth.retryAfterSeconds).toBeLessThanOrEqual(
      RECOVERY_RATE_WINDOW_MS / 1000,
    );
  });

  it('matches the LIMIT constant — exactly RECOVERY_RATE_LIMIT requests pass', () => {
    const now = 5_000;
    let allowedCount = 0;
    for (let i = 0; i < RECOVERY_RATE_LIMIT + 2; i++) {
      if (checkRecoveryRateLimit(IP, now + i).allowed) allowedCount += 1;
    }
    expect(allowedCount).toBe(RECOVERY_RATE_LIMIT);
  });
});

describe('checkRecoveryRateLimit — per-IP isolation (Req 14.8)', () => {
  it('gives different IPs independent budgets', () => {
    const now = 2_000_000;
    // Exhaust IP's budget.
    checkRecoveryRateLimit(IP, now);
    checkRecoveryRateLimit(IP, now);
    checkRecoveryRateLimit(IP, now);
    expect(checkRecoveryRateLimit(IP, now).allowed).toBe(false);

    // A different IP still has its full budget.
    const other = checkRecoveryRateLimit(OTHER_IP, now);
    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(2);
  });
});

describe('checkRecoveryRateLimit — window reset (Req 14.8)', () => {
  it('grants a fresh budget once the window has elapsed', () => {
    const now = 3_000_000;
    checkRecoveryRateLimit(IP, now);
    checkRecoveryRateLimit(IP, now);
    checkRecoveryRateLimit(IP, now);
    expect(checkRecoveryRateLimit(IP, now).allowed).toBe(false);

    // Advance just past the window's resetAt → fresh window.
    const afterWindow = now + RECOVERY_RATE_WINDOW_MS + 1;
    const reopened = checkRecoveryRateLimit(IP, afterWindow);
    expect(reopened.allowed).toBe(true);
    expect(reopened.remaining).toBe(2);
  });

  it('still denies exactly AT the window boundary (resetAt not yet reached)', () => {
    const now = 4_000_000;
    checkRecoveryRateLimit(IP, now);
    checkRecoveryRateLimit(IP, now);
    checkRecoveryRateLimit(IP, now);

    // One ms before reset → window still active → denied.
    const justBefore = now + RECOVERY_RATE_WINDOW_MS - 1;
    expect(checkRecoveryRateLimit(IP, justBefore).allowed).toBe(false);
  });
});

describe('checkRecoveryRateLimit — SHARED counter across endpoints (Req 14.8)', () => {
  it('exhausts the combined budget across mixed /recover + /forgot-path calls', () => {
    const now = 6_000_000;
    // Simulate the two routes (task 10.7) both calling the same limiter
    // for the same IP: a /recover, a /forgot-path, a /recover again.
    // The key is IP only, so all three draw from ONE 3/hour budget.
    const recover1 = checkRecoveryRateLimit(IP, now); // /recover
    const forgot1 = checkRecoveryRateLimit(IP, now); // /forgot-path
    const recover2 = checkRecoveryRateLimit(IP, now); // /recover

    expect(recover1.allowed).toBe(true);
    expect(forgot1.allowed).toBe(true);
    expect(recover2.allowed).toBe(true);
    expect(recover2.remaining).toBe(0);

    // The 4th — regardless of which endpoint it came from — is denied
    // because the budget is COMBINED, not 3-per-endpoint.
    const forgot2 = checkRecoveryRateLimit(IP, now); // /forgot-path
    expect(forgot2.allowed).toBe(false);
    expect(forgot2.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('checkRecoveryRateLimit — fixed window does not extend on deny (Req 14.8)', () => {
  it('keeps retryAfterSeconds anchored to the first request, shrinking over time', () => {
    const now = 7_000_000;
    checkRecoveryRateLimit(IP, now);
    checkRecoveryRateLimit(IP, now);
    checkRecoveryRateLimit(IP, now);

    // First deny at now: full hour remaining.
    const denyA = checkRecoveryRateLimit(IP, now);
    expect(denyA.retryAfterSeconds).toBe(RECOVERY_RATE_WINDOW_MS / 1000);

    // A later deny does NOT reset the window — Retry-After shrinks.
    const tenMinutesLater = now + 10 * 60 * 1000;
    const denyB = checkRecoveryRateLimit(IP, tenMinutesLater);
    expect(denyB.allowed).toBe(false);
    expect(denyB.retryAfterSeconds).toBe(
      RECOVERY_RATE_WINDOW_MS / 1000 - 10 * 60,
    );
    expect(denyB.retryAfterSeconds!).toBeLessThan(denyA.retryAfterSeconds!);
  });

  it('always returns a positive integer retryAfterSeconds (ceil)', () => {
    const now = 8_000_000;
    checkRecoveryRateLimit(IP, now);
    checkRecoveryRateLimit(IP, now);
    checkRecoveryRateLimit(IP, now);

    // Deny 500ms into the window → remaining is fractional seconds; ceil
    // it to a positive integer.
    const deny = checkRecoveryRateLimit(IP, now + 500);
    expect(deny.allowed).toBe(false);
    expect(Number.isInteger(deny.retryAfterSeconds)).toBe(true);
    expect(deny.retryAfterSeconds).toBeGreaterThan(0);
    // 3600s window minus 0.5s, ceil → 3600.
    expect(deny.retryAfterSeconds).toBe(RECOVERY_RATE_WINDOW_MS / 1000);
  });
});

describe('__resetRecoveryRateLimitForTests', () => {
  it('clears state so a previously-exhausted IP starts fresh', () => {
    const now = 9_000_000;
    checkRecoveryRateLimit(IP, now);
    checkRecoveryRateLimit(IP, now);
    checkRecoveryRateLimit(IP, now);
    expect(checkRecoveryRateLimit(IP, now).allowed).toBe(false);

    __resetRecoveryRateLimitForTests();

    const afterReset = checkRecoveryRateLimit(IP, now);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(2);
  });
});

describe('recoveryRateLimitHeaders', () => {
  it('builds a Retry-After header bag from the seconds value', () => {
    expect(recoveryRateLimitHeaders(3600)).toEqual({ 'Retry-After': '3600' });
    expect(recoveryRateLimitHeaders(42)).toEqual({ 'Retry-After': '42' });
  });
});

describe('RECOVERY_RATE_LIMIT_CODE', () => {
  it('is the RATE_LIMITED envelope code the route layer uses', () => {
    expect(RECOVERY_RATE_LIMIT_CODE).toBe('RATE_LIMITED');
  });
});
