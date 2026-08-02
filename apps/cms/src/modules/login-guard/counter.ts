/**
 * Sliding-window failure counters for the Login Guard.
 *
 * Default: Postgres-backed reads from `login_attempts`. When Redis is
 * available via the runtime cache, {@link RedisCounterStore} uses INCR for
 * O(1) reads with Postgres fallback on cache errors.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import { loginAttempts, type Database } from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';

import { normalizeEmail } from './email-normalize';

export interface CounterStore {
  userFailedCount(email: string, windowSeconds: number): Promise<number>;
  ipFailedCount(ip: string, windowSeconds: number): Promise<number>;
  /** Bump hot counters after a failure row is inserted. No-op for Postgres-only. */
  onFailureRecorded?(email: string, ip: string, windowSeconds: number): Promise<void>;
}

export class PostgresCounterStore implements CounterStore {
  constructor(private readonly db: Database) {}

  async userFailedCount(email: string, windowSeconds: number): Promise<number> {
    const emailLower = normalizeEmail(email);
    if (emailLower.length === 0) return 0;

    const window = clampWindowSeconds(windowSeconds);
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.emailLower, emailLower),
          eq(loginAttempts.result, 'fail'),
          gte(
            loginAttempts.createdAt,
            sql`now() - (${String(window)} || ' seconds')::interval`,
          ),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async ipFailedCount(ip: string, windowSeconds: number): Promise<number> {
    const trimmedIp = (ip ?? '').trim();
    if (trimmedIp.length === 0) return 0;

    const window = clampWindowSeconds(windowSeconds);
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.ip, trimmedIp),
          eq(loginAttempts.result, 'fail'),
          gte(
            loginAttempts.createdAt,
            sql`now() - (${String(window)} || ' seconds')::interval`,
          ),
        ),
      );
    return rows[0]?.count ?? 0;
  }
}

/**
 * Redis-backed counter using {@link CacheProvider.increment}. Falls back to
 * Postgres reads when cache get/increment fails.
 */
export class RedisCounterStore implements CounterStore {
  private readonly postgres: PostgresCounterStore;

  constructor(
    private readonly cache: CacheProvider,
    db: Database,
  ) {
    this.postgres = new PostgresCounterStore(db);
  }

  private userKey(email: string): string {
    return `lg:fail:user:${normalizeEmail(email)}`;
  }

  private ipKey(ip: string): string {
    return `lg:fail:ip:${(ip ?? '').trim()}`;
  }

  async onFailureRecorded(email: string, ip: string, windowSeconds: number): Promise<void> {
    const window = clampWindowSeconds(windowSeconds);
    const emailLower = normalizeEmail(email);
    const trimmedIp = (ip ?? '').trim();
    const ops: Promise<unknown>[] = [];
    if (emailLower.length > 0) {
      ops.push(this.cache.increment(this.userKey(emailLower), 1, { ttl: window }));
    }
    if (trimmedIp.length > 0) {
      ops.push(this.cache.increment(this.ipKey(trimmedIp), 1, { ttl: window }));
    }
    await Promise.allSettled(ops);
  }

  async userFailedCount(email: string, windowSeconds: number): Promise<number> {
    const emailLower = normalizeEmail(email);
    if (emailLower.length === 0) return 0;
    try {
      const raw = await this.cache.get(this.userKey(emailLower));
      if (raw !== null) {
        const n = Number.parseInt(String(raw), 10);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    } catch {
      // fall through to Postgres
    }
    return this.postgres.userFailedCount(email, windowSeconds);
  }

  async ipFailedCount(ip: string, windowSeconds: number): Promise<number> {
    const trimmedIp = (ip ?? '').trim();
    if (trimmedIp.length === 0) return 0;
    try {
      const raw = await this.cache.get(this.ipKey(trimmedIp));
      if (raw !== null) {
        const n = Number.parseInt(String(raw), 10);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    } catch {
      // fall through to Postgres
    }
    return this.postgres.ipFailedCount(ip, windowSeconds);
  }
}

export function userFailedCount(
  db: Database,
  email: string,
  windowSeconds: number,
): Promise<number> {
  return new PostgresCounterStore(db).userFailedCount(email, windowSeconds);
}

export function ipFailedCount(
  db: Database,
  ip: string,
  windowSeconds: number,
): Promise<number> {
  return new PostgresCounterStore(db).ipFailedCount(ip, windowSeconds);
}

export interface CounterStoreEnv {
  readonly LUMIBASE_REDIS_URL?: string;
  readonly REDIS_URL?: string;
}

export interface CounterStoreDeps {
  readonly cache?: CacheProvider;
}

export function createCounterStore(
  db: Database,
  env: CounterStoreEnv = {},
  deps: CounterStoreDeps = {},
): CounterStore {
  if (deps.cache && hasRedisCounterBackend(env)) {
    return new RedisCounterStore(deps.cache, db);
  }
  return new PostgresCounterStore(db);
}

function hasRedisCounterBackend(env: CounterStoreEnv): boolean {
  const redisUrl = env.LUMIBASE_REDIS_URL ?? env.REDIS_URL;
  return typeof redisUrl === 'string' && redisUrl.length > 0;
}

function clampWindowSeconds(input: number): number {
  if (!Number.isFinite(input)) return 1;
  const floored = Math.floor(input);
  return floored >= 1 ? floored : 1;
}
