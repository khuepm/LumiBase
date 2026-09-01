/**
 * Distributed leader lock for cron / background jobs (high-load-cache-readiness
 * Req 14.2–14.3; design §10.2).
 *
 * Uses Redis `SET key value NX PX ttl`. Lock keys are deployment-scoped
 * (`lumi:cron-lock:${jobName}`) and intentionally omit siteId — jobs fan out
 * per site from DB inside the callback.
 *
 * When Redis is unavailable, runs the callback directly and warns once.
 */
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

const LOCK_PREFIX = 'lumi:cron-lock:';

let noRedisWarned = false;

/** Reset the one-shot warn flag (tests only). */
export function __resetLeaderLockWarningsForTests(): void {
  noRedisWarned = false;
}

export interface LeaderLockRedis {
  set(key: string, value: string, mode: 'PX', ttlMs: number, flag: 'NX'): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  quit?(): Promise<unknown>;
}

export interface WithLeaderLockOptions {
  /** Redis URL. When omitted, fn runs without locking. */
  redisUrl?: string;
  /** Lock owner token. Defaults to HOSTNAME + random suffix. */
  instanceId?: string;
  /** Injectable Redis client (tests). When set, redisUrl is ignored. */
  redis?: LeaderLockRedis;
}

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

function defaultInstanceId(): string {
  const host = process.env.HOSTNAME || process.env.COMPUTERNAME || 'local';
  return `${host}:${randomUUID().slice(0, 8)}`;
}

function lockKey(jobName: string): string {
  return `${LOCK_PREFIX}${jobName}`;
}

/**
 * Acquire a leader lock, run `fn`, then best-effort release.
 * Skips `fn` when another instance holds the lock.
 */
export async function withLeaderLock(
  jobName: string,
  ttlMs: number,
  fn: () => void | Promise<void>,
  options: WithLeaderLockOptions = {},
): Promise<boolean> {
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
  const instanceId = options.instanceId ?? defaultInstanceId();
  const key = lockKey(jobName);

  if (!options.redis && !redisUrl) {
    if (!noRedisWarned) {
      console.warn(
        '[leader-lock] REDIS_URL unset — running cron jobs without distributed lock (every replica will execute)',
      );
      noRedisWarned = true;
    }
    await fn();
    return true;
  }

  const ownedClient = !options.redis;
  const redis: LeaderLockRedis =
    options.redis ??
    new Redis(redisUrl!, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });

  try {
    if (ownedClient && redis instanceof Redis && redis.status === 'wait') {
      await redis.connect();
    }

    const acquired = await redis.set(key, instanceId, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') {
      return false;
    }

    try {
      const renewMs = Math.max(1_000, Math.floor(ttlMs / 3));
      const renewTimer = setInterval(() => {
        void redis.eval(RENEW_SCRIPT, 1, key, instanceId, String(ttlMs)).catch(() => {
          // Best-effort renew; TTL is the safety net.
        });
      }, renewMs);
      if (typeof renewTimer === 'object' && renewTimer && 'unref' in renewTimer) {
        (renewTimer as NodeJS.Timeout).unref();
      }

      try {
        await fn();
      } finally {
        clearInterval(renewTimer);
      }
    } finally {
      try {
        await redis.eval(RELEASE_SCRIPT, 1, key, instanceId);
      } catch {
        // Best-effort release — TTL is the safety net.
      }
    }
    return true;
  } catch (err) {
    console.warn(`[leader-lock] Redis error for job "${jobName}" — running without lock:`, err);
    await fn();
    return true;
  } finally {
    if (ownedClient && typeof redis.quit === 'function') {
      try {
        await redis.quit();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Wrap a cron/interval callback so only the leader instance runs it.
 */
export function leaderLockedCallback(
  jobName: string,
  ttlMs: number,
  fn: () => void | Promise<void>,
  options?: WithLeaderLockOptions,
): () => void {
  return () => {
    void withLeaderLock(jobName, ttlMs, fn, options);
  };
}
