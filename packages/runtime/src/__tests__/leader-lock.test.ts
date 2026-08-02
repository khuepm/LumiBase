import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  __resetLeaderLockWarningsForTests,
  withLeaderLock,
  type LeaderLockRedis,
} from '../leader-lock';

class MemoryRedis implements LeaderLockRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  async set(
    key: string,
    value: string,
    _mode: 'PX',
    ttlMs: number,
    flag: 'NX',
  ): Promise<string | null> {
    if (flag !== 'NX') return null;
    const now = Date.now();
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > now) {
      return null;
    }
    this.store.set(key, { value, expiresAt: now + ttlMs });
    return 'OK';
  }

  async eval(_script: string, _numKeys: number, ...args: string[]): Promise<unknown> {
    const key = args[0];
    const token = args[1];
    const ttl = args[2];
    if (key === undefined || token === undefined) return 0;
    const entry = this.store.get(key);
    if (entry?.value === token) {
      if (ttl !== undefined) {
        entry.expiresAt = Date.now() + Number(ttl);
        return 1;
      }
      this.store.delete(key);
      return 1;
    }
    return 0;
  }
}

describe('withLeaderLock', () => {
  beforeEach(() => {
    __resetLeaderLockWarningsForTests();
    vi.unstubAllEnvs();
  });

  it('runs fn when lock is acquired', async () => {
    const redis = new MemoryRedis();
    const fn = vi.fn();

    const ran = await withLeaderLock('audit-rotation', 5_000, fn, {
      redis,
      instanceId: 'inst-a',
    });

    expect(ran).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('skips fn when another instance holds the lock', async () => {
    const redis = new MemoryRedis();
    let releaseFirst!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = vi.fn(() => hold);
    const second = vi.fn();

    const firstRun = withLeaderLock('scheduler-tick', 5_000, first, { redis, instanceId: 'a' });
    await vi.waitFor(() => expect(first).toHaveBeenCalled());
    const ran = await withLeaderLock('scheduler-tick', 5_000, second, { redis, instanceId: 'b' });
    releaseFirst();
    await firstRun;

    expect(ran).toBe(false);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('runs fn without lock and warns once when Redis is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn();

    await withLeaderLock('pageview-flush', 1_000, fn);
    await withLeaderLock('pageview-flush', 1_000, fn);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('REDIS_URL unset');
  });

  it('two processes × three ticks with shared Redis → three side-effects (Req 14.5)', async () => {
    const redis = new MemoryRedis();
    let sideEffects = 0;
    const tick = () => {
      sideEffects += 1;
    };

    for (let i = 0; i < 3; i++) {
      await Promise.all([
        withLeaderLock('cron-demo', 2_000, tick, { redis, instanceId: 'proc-1' }),
        withLeaderLock('cron-demo', 2_000, tick, { redis, instanceId: 'proc-2' }),
      ]);
    }

    expect(sideEffects).toBe(3);
  });
});
