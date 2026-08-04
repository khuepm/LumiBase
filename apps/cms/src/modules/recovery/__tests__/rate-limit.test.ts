import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryRateLimiter } from '@lumibase/runtime';

import {
  checkRecoveryRateLimit,
  recoveryRateLimitHeaders,
  __resetRecoveryRateLimitForTests,
  RECOVERY_RATE_LIMIT,
  RECOVERY_RATE_WINDOW_SECONDS,
  RECOVERY_RATE_LIMIT_CODE,
} from '../rate-limit';

const IP = '203.0.113.7';
const OTHER_IP = '198.51.100.42';

let now = 1_000_000;
let limiter: MemoryRateLimiter;

beforeEach(() => {
  __resetRecoveryRateLimitForTests();
  now = 1_000_000;
  limiter = new MemoryRateLimiter(undefined, () => now);
});

afterEach(() => {
  __resetRecoveryRateLimitForTests();
});

describe('checkRecoveryRateLimit — budget within a window (Req 14.8)', () => {
  it('allows the first 3 requests with remaining counting down 2, 1, 0', async () => {
    const first = await checkRecoveryRateLimit(limiter, IP);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);
    expect(first.retryAfterSeconds).toBeUndefined();

    const second = await checkRecoveryRateLimit(limiter, IP);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(1);

    const third = await checkRecoveryRateLimit(limiter, IP);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
  });

  it('denies the 4th request with retryAfterSeconds', async () => {
    await checkRecoveryRateLimit(limiter, IP);
    await checkRecoveryRateLimit(limiter, IP);
    await checkRecoveryRateLimit(limiter, IP);

    const fourth = await checkRecoveryRateLimit(limiter, IP);
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
    expect(fourth.retryAfterSeconds).toBeLessThanOrEqual(RECOVERY_RATE_WINDOW_SECONDS);
  });

  it('never allows more than RECOVERY_RATE_LIMIT requests in one window', async () => {
    let allowedCount = 0;
    for (let i = 0; i < 10; i += 1) {
      if ((await checkRecoveryRateLimit(limiter, IP)).allowed) allowedCount += 1;
    }
    expect(allowedCount).toBe(RECOVERY_RATE_LIMIT);
  });
});

describe('checkRecoveryRateLimit — per-IP isolation (Req 14.8)', () => {
  it('tracks budgets independently per IP', async () => {
    await checkRecoveryRateLimit(limiter, IP);
    await checkRecoveryRateLimit(limiter, IP);
    await checkRecoveryRateLimit(limiter, IP);
    expect((await checkRecoveryRateLimit(limiter, IP)).allowed).toBe(false);

    const other = await checkRecoveryRateLimit(limiter, OTHER_IP);
    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(2);
  });
});

describe('checkRecoveryRateLimit — window reset (Req 14.8)', () => {
  it('opens a fresh window after RECOVERY_RATE_WINDOW_SECONDS elapses', async () => {
    await checkRecoveryRateLimit(limiter, IP);
    await checkRecoveryRateLimit(limiter, IP);
    await checkRecoveryRateLimit(limiter, IP);
    expect((await checkRecoveryRateLimit(limiter, IP)).allowed).toBe(false);

    now += RECOVERY_RATE_WINDOW_SECONDS * 1000 + 1;
    const reopened = await checkRecoveryRateLimit(limiter, IP);
    expect(reopened.allowed).toBe(true);
    expect(reopened.remaining).toBe(2);
  });
});

describe('checkRecoveryRateLimit — SHARED counter across endpoints (Req 14.8)', () => {
  it('combines /recover and /forgot-path into one budget', async () => {
    const recover1 = await checkRecoveryRateLimit(limiter, IP);
    const forgot1 = await checkRecoveryRateLimit(limiter, IP);
    const recover2 = await checkRecoveryRateLimit(limiter, IP);
    expect(recover1.allowed).toBe(true);
    expect(forgot1.allowed).toBe(true);
    expect(recover2.allowed).toBe(true);

    const forgot2 = await checkRecoveryRateLimit(limiter, IP);
    expect(forgot2.allowed).toBe(false);
  });
});

describe('recoveryRateLimitHeaders', () => {
  it('builds Retry-After header bag', () => {
    expect(recoveryRateLimitHeaders(120)).toEqual({ 'Retry-After': '120' });
  });

  it('exports the shared error code constant', () => {
    expect(RECOVERY_RATE_LIMIT_CODE).toBe('RATE_LIMITED');
  });
});
