import { describe, expect, it } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import type { Context } from 'hono';
import type { CacheProvider } from '@lumibase/runtime';
import type { AppEnv } from '../../../env';
import { issuerCacheKey, tryExternalJwt } from '../adapter';
import type { TrustedIssuer } from '../verifier';

/**
 * Trusted-issuer cache tests (Req 8.6, 2.6, 12.1 — task 6.3). DB-free: the
 * adapter must serve `getTrustedIssuers` from `runtime.cache` on a hit (no DB
 * query), and populate the cache with TTL ≤ 60s on a miss. The invalidation
 * side (issuer CRUD drops the key) is locked by the DB-integration suite.
 *
 * **Validates: Requirements 8.6, 2.6, 12.1**
 */

const SITE = 'site_cache_1';

/** A trusted issuer that will NOT match the test token (forces `skip`). */
const CACHED_ISSUER: TrustedIssuer = {
  id: 'iss_cached',
  issuer: 'https://cached-idp.example.com/',
  jwksUri: 'https://cached-idp.example.com/jwks',
  discoveryUrl: null,
  audience: 'lumibase-api',
  algorithms: ['RS256'],
  claimMapping: { email: 'email', roles: 'roles', externalId: 'sub' },
  roleMapping: {},
  defaultRoleId: null,
  jitProvisioning: false,
  clockSkewSeconds: 60,
};

interface FakeCache extends CacheProvider {
  gets: string[];
  sets: Array<{ key: string; value: string; ttl?: number }>;
  deletes: string[];
}

function makeFakeCache(preload: Record<string, unknown> = {}): FakeCache {
  const store = new Map<string, string>(Object.entries(preload).map(([k, v]) => [k, JSON.stringify(v)]));
  const cache: FakeCache = {
    gets: [],
    sets: [],
    deletes: [],
    async get<T>(key: string): Promise<T | null> {
      cache.gets.push(key);
      const raw = store.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async set(key: string, value: string, options?: { ttl?: number }): Promise<void> {
      cache.sets.push({ key, value, ttl: options?.ttl });
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      cache.deletes.push(key);
      store.delete(key);
    },
    async increment(key: string, by = 1): Promise<number> {
      const next = Number(store.get(key) ?? '0') + by;
      store.set(key, String(next));
      return next;
    },
    async getEntry<T>(key: string) {
      const raw = store.get(key);
      if (raw === undefined) return { state: 'miss' as const };
      return { state: 'hit' as const, value: JSON.parse(raw) as T };
    },
    async setNegative(key: string, options?: { ttl?: number }) {
      await cache.set(key, JSON.stringify({ __lumi: 'neg', v: 1 }), options);
    },
  };
  return cache;
}

/** Minimal fake Hono context: tryExternalJwt only reads request variables. */
function makeContext(vars: Record<string, unknown>): Context<AppEnv> {
  return { get: (key: string) => vars[key] } as unknown as Context<AppEnv>;
}

/** Fake drizzle `db.select().from().where()` chain that counts queries. */
function makeCountingDb(rows: unknown[] = []) {
  const db = {
    hits: 0,
    select() {
      db.hits++;
      return { from: () => ({ where: async () => rows }) };
    },
  };
  return db;
}

async function makeUnmatchedToken(): Promise<string> {
  const { privateKey } = await generateKeyPair('RS256');
  return new SignJWT({ roles: ['editor'] })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer('https://unmatched-idp.example.com/')
    .setAudience('lumibase-api')
    .setSubject('ext-cache-1')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

describe('external-auth trusted-issuer cache (task 6.3)', () => {
  it('serves issuers from runtime.cache without querying the DB on a hit', async () => {
    const cache = makeFakeCache({ [issuerCacheKey(SITE)]: [CACHED_ISSUER] });
    const db = makeCountingDb();
    const c = makeContext({ db, siteId: SITE, runtime: { cache } });

    const outcome = await tryExternalJwt(c, await makeUnmatchedToken());

    expect(outcome.kind).toBe('skip'); // cached issuer ≠ token iss
    expect(cache.gets).toContain(issuerCacheKey(SITE));
    expect(db.hits).toBe(0); // the whole point: no DB round-trip on a hit
  });

  it('populates the cache with TTL ≤ 60s on a miss', async () => {
    const cache = makeFakeCache();
    const db = makeCountingDb([]);
    const c = makeContext({ db, siteId: SITE, runtime: { cache } });

    const outcome = await tryExternalJwt(c, await makeUnmatchedToken());

    expect(outcome.kind).toBe('skip'); // no issuers configured
    expect(db.hits).toBe(1);
    const entry = cache.sets.find((s) => s.key === issuerCacheKey(SITE));
    expect(entry).toBeDefined();
    expect(JSON.parse(entry!.value)).toEqual([]);
    expect(entry!.ttl).toBeDefined();
    expect(entry!.ttl!).toBeLessThanOrEqual(60);
  });

  it('keys the cache per site (no cross-tenant issuer reuse)', async () => {
    expect(issuerCacheKey('site_a')).not.toBe(issuerCacheKey('site_b'));
    expect(issuerCacheKey(SITE)).toBe(`auth:issuers:${SITE}`);
  });
});
