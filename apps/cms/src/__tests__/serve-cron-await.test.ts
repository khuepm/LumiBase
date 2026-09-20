import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withLeaderLock } from '@lumibase/runtime/node';

/**
 * A leader-locked cron callback must AWAIT its work (reviewer R3).
 *
 * ## The defect
 *
 * Every cron registration in `serve.ts` was shaped like:
 *
 * ```ts
 * leaderLockedCallback('job', ttl, () => {
 *   void doWork().catch(log);
 * }, lockOpts)
 * ```
 *
 * `void doWork()` discards the promise, so the callback returns `undefined`
 * synchronously. `leaderLockedCallback` does `await fn()`, which completes
 * immediately, and then releases the lock — while the work is still running. The
 * lock therefore guaranteed nothing for **any** of these jobs. All nine had the
 * same shape, so this is a class, not one mistake: `goal-dispatch` is just the
 * job where the consequence is visible as two runs for one drift.
 *
 * ## Two halves
 *
 * A source scan alone would pass on a callback that is `async` but still forgets
 * to await inside, and a behavioural test alone would not stop the next
 * registration from being written the old way. Both are here.
 *
 * Evidence class: the source scan reads the real `serve.ts`; the behavioural half
 * uses the real `leaderLockedCallback` with a fake Redis. No live Redis, no cron.
 *
 * **Validates: #455 / reviewer R3 — the lock is held for the duration of the work**
 */

const SERVE = readFileSync(join(__dirname, '..', 'serve.ts'), 'utf8');

describe('serve.ts cron callbacks hold the leader lock', () => {
  it('registers no callback that discards its work with `void`', () => {
    // The exact shape that caused the bug. Matching on it rather than on "does
    // this file contain `void`" keeps the check specific enough to be actionable.
    const discarded = SERVE.match(/\(\) => \{\n\s*void /g) ?? [];
    expect(discarded, 'cron callbacks must await, not `void`, their work').toEqual([]);
  });

  it('every leaderLockedCallback is given an async function', () => {
    const registrations = [...SERVE.matchAll(/leaderLockedCallback\(\s*\n?\s*'([^']+)'[\s\S]{0,200}?\n(\s*)(async )?\(\) => \{/g)];
    expect(registrations.length, 'found the cron registrations').toBeGreaterThanOrEqual(9);

    const notAsync = registrations.filter((m) => m[3] === undefined).map((m) => m[1]);
    expect(notAsync, 'these jobs release the lock before their work finishes').toEqual([]);
  });

  /**
   * `withLeaderLock` is the half that can be observed.
   *
   * `leaderLockedCallback` wraps it and deliberately discards the promise —
   * correct, because `node-cron` does not await its callbacks. So the contract
   * that matters is `withLeaderLock`'s: it releases only after `await fn()`
   * settles. Whether the lock is actually held for the duration therefore depends
   * entirely on whether `fn` returns a promise, which is what the scans above
   * enforce and what these two cases measure.
   */
  function fakeRedis(events: string[]) {
    return {
      set: async () => 'OK',
      eval: async () => {
        events.push('release');
        return 1;
      },
    };
  }

  it('releases the lock only after an awaited function resolves', async () => {
    const events: string[] = [];
    let resolveWork: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });

    const running = withLeaderLock(
      'test-job',
      5_000,
      async () => {
        events.push('work:start');
        await work;
        events.push('work:end');
      },
      { redis: fakeRedis(events) as never, instanceId: 'test' },
    );

    await new Promise((r) => setTimeout(r, 10));
    // Still inside the work: nothing released yet.
    expect(events).toEqual(['work:start']);

    resolveWork!();
    await running;
    expect(events).toEqual(['work:start', 'work:end', 'release']);
  });

  it('releases early for a `void`-style function — the defect, reproduced', async () => {
    // Negative control. If someone "fixes" the helper instead of the callbacks,
    // this shows the helper was never the problem: given a function that returns
    // `undefined`, releasing immediately is the only thing it can do.
    const events: string[] = [];
    let resolveWork: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });

    await withLeaderLock(
      'test-job',
      5_000,
      () => {
        events.push('work:start');
        void work.then(() => events.push('work:end'));
      },
      { redis: fakeRedis(events) as never, instanceId: 'test' },
    );

    // Released while the work is still pending — exactly the measured defect.
    expect(events).toEqual(['work:start', 'release']);

    resolveWork!();
    await work;
  });
});
