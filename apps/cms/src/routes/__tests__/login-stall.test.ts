/**
 * Unit tests for the login-failure stall helper (`stallLoginFailure`).
 *
 * Validates the Directus `LOGIN_STALL_TIME`-parity speed brake added to
 * the `/auth/login` `INVALID_CREDENTIALS` branches. The helper is a thin
 * wrapper around a `setTimeout` promise; these tests pin its two
 * behavioural contracts deterministically with fake timers (no real
 * wall-clock wait, no DB):
 *
 *   1. A positive `stallMs` resolves only after that many milliseconds
 *      have elapsed — i.e. the await genuinely parks for the configured
 *      duration rather than resolving on the next microtask tick.
 *   2. A non-positive / non-finite `stallMs` resolves immediately with
 *      no timer scheduled, so a disabled stall adds zero overhead.
 *
 * Full-route timing parity (both fail branches paying the same stall on
 * top of the dummy-hash PBKDF2 cost) is exercised by the DB-driven
 * `__tests__/user-enum.timing.test.ts` integration suite.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { stallLoginFailure } from '../auth';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stallLoginFailure', () => {
  it('resolves only after the configured stall elapses', async () => {
    vi.useFakeTimers();

    let resolved = false;
    const pending = stallLoginFailure(500).then(() => {
      resolved = true;
    });

    // Not yet — still inside the stall window.
    await vi.advanceTimersByTimeAsync(499);
    expect(resolved).toBe(false);

    // Crossing the configured boundary releases the response.
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'resolves immediately without scheduling a timer for stallMs=%s',
    async (stallMs) => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      await stallLoginFailure(stallMs as number);

      expect(setTimeoutSpy).not.toHaveBeenCalled();
    },
  );
});
