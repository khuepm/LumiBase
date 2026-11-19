import { releaseManifests, type Database } from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { register } from '../../../routes/metrics';
import { readPullHealth } from '../pull-status';
import {
  loadAcceptedManifest,
  resetReleaseFlagStateForTests,
  runScheduledReleasePull,
  type ReleaseEnv,
} from '../service';
import { iso, makeSigner } from './signing';

/**
 * #897: the pull that does not wait for traffic. Real Postgres for the
 * accepted manifest, an in-memory cache standing in for the shared runtime
 * cache (Redis / KV) that carries the deployment-wide pull history.
 */

const NOW = Date.parse('2026-11-19T10:00:00Z');
const signer = makeSigner('lumibase-release-sched');
const env: ReleaseEnv = {
  LUMIBASE_RELEASE_PUBLIC_KEYS: JSON.stringify(signer.publicKeys),
  LUMIBASE_RELEASE_MANIFEST_URL: 'https://releases.example.test/flags/lumibase-staging.json',
  LUMIBASE_RELEASE_MANIFEST_REFRESH_S: '300',
  LUMIBASE_INSTANCE_ID: 'lumibase-staging',
};
const manifest = (issuedAtMs: number, flags: Record<string, boolean>) =>
  signer.envelope({ v: 1, issuedAt: iso(issuedAtMs), audience: ['lumibase-staging'], flags });
const serve = (body: unknown): typeof fetch => async () => new Response(JSON.stringify(body));
const down: typeof fetch = async () => new Response('unavailable', { status: 503 });

async function pullsCounter(outcome: string): Promise<number> {
  const metric = await register.getSingleMetric('lumibase_release_manifest_pulls_total')?.get();
  return metric?.values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
}

describe.skipIf(!hasDbIntegrationUrl)('scheduled release-manifest pull — DB integration (#897)', () => {
  let db: Database;
  let saved: (typeof releaseManifests.$inferSelect)[] = [];
  let cache: MemoryCacheProvider;

  beforeAll(async () => {
    db = await connectDbIntegration('release-flags-scheduled');
    saved = await db.select().from(releaseManifests);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(releaseManifests);
    if (saved.length) await db.insert(releaseManifests).values(saved);
  });

  beforeEach(async () => {
    resetReleaseFlagStateForTests();
    cache = new MemoryCacheProvider();
    await db.delete(releaseManifests);
  });

  it('does nothing and records nothing while the pull is not configured', async () => {
    const result = await runScheduledReleasePull({
      systemDb: db,
      env: { ...env, LUMIBASE_RELEASE_MANIFEST_URL: undefined },
      cache,
      now: NOW,
      fetchImpl: serve(manifest(NOW - 1000, { 'content-environments': true })),
    });
    expect(result).toEqual({ status: 'not-configured' });
    expect(await readPullHealth(cache)).toMatchObject({ lastAttemptAt: null, consecutiveFailures: 0 });
    expect(await loadAcceptedManifest(db)).toBeNull();
  });

  it('pulls on an idle instance, then waits out the interval across replicas', async () => {
    const acceptedBefore = await pullsCounter('accepted');
    const first = await runScheduledReleasePull({
      systemDb: db, env, cache, now: NOW, fetchImpl: serve(manifest(NOW - 1000, { 'content-environments': true })),
    });
    expect(first).toMatchObject({ status: 'pulled', outcome: { ok: true, unchanged: false } });
    expect((await loadAcceptedManifest(db))?.flags).toEqual({ 'content-environments': true });
    expect(await readPullHealth(cache)).toEqual({
      lastAttemptAt: iso(NOW),
      lastSuccessAt: iso(NOW),
      acceptedIssuedAt: iso(NOW - 1000),
      consecutiveFailures: 0,
      lastError: null,
    });
    expect(await pullsCounter('accepted')).toBe(acceptedBefore + 1);

    // Another replica (fresh process state, same shared cache) one minute later.
    resetReleaseFlagStateForTests();
    let fetched = false;
    const second = await runScheduledReleasePull({
      systemDb: db, env, cache, now: NOW + 60_000,
      fetchImpl: async () => {
        fetched = true;
        return new Response('{}');
      },
    });
    expect(second).toEqual({ status: 'not-due', lastAttemptAt: iso(NOW) });
    expect(fetched).toBe(false);
  });

  it('a failing pull keeps the accepted manifest and counts consecutive failures until a success', async () => {
    await runScheduledReleasePull({
      systemDb: db, env, cache, now: NOW, fetchImpl: serve(manifest(NOW - 1000, { 'content-environments': true })),
    });
    const later = (n: number) => NOW + n * 301_000;

    const f1 = await runScheduledReleasePull({ systemDb: db, env, cache, now: later(1), fetchImpl: down });
    expect(f1).toMatchObject({ status: 'pulled', outcome: { ok: false, reason: 'HTTP_503' } });
    await runScheduledReleasePull({ systemDb: db, env, cache, now: later(2), fetchImpl: down });
    expect(await readPullHealth(cache)).toMatchObject({
      lastAttemptAt: iso(later(2)),
      lastSuccessAt: iso(NOW),
      acceptedIssuedAt: iso(NOW - 1000),
      consecutiveFailures: 2,
      lastError: 'HTTP_503',
    });
    expect((await loadAcceptedManifest(db))?.flags).toEqual({ 'content-environments': true });

    const ok = await runScheduledReleasePull({
      systemDb: db, env, cache, now: later(3),
      fetchImpl: serve(manifest(later(3) - 1000, { 'content-environments': false })),
    });
    expect(ok).toMatchObject({ status: 'pulled', outcome: { ok: true } });
    expect(await readPullHealth(cache)).toMatchObject({
      consecutiveFailures: 0,
      lastError: null,
      acceptedIssuedAt: iso(later(3) - 1000),
    });
  });

  it('a manifest for another audience is a failure, not an acceptance', async () => {
    const other = signer.envelope({
      v: 1, issuedAt: iso(NOW - 1000), audience: ['lumibase-production'], flags: { 'content-environments': true },
    });
    const result = await runScheduledReleasePull({ systemDb: db, env, cache, now: NOW, fetchImpl: serve(other) });
    expect(result).toMatchObject({ status: 'pulled', outcome: { ok: false, reason: 'WRONG_AUDIENCE' } });
    expect(await loadAcceptedManifest(db)).toBeNull();
    expect((await readPullHealth(cache)).consecutiveFailures).toBe(1);
  });

  it('never throws when the cache is down', async () => {
    const broken = new MemoryCacheProvider();
    broken.get = async () => {
      throw new Error('cache down');
    };
    broken.set = async () => {
      throw new Error('cache down');
    };
    const result = await runScheduledReleasePull({
      systemDb: db, env, cache: broken, now: NOW, fetchImpl: serve(manifest(NOW - 1000, { 'content-environments': true })),
    });
    expect(result).toMatchObject({ status: 'pulled', outcome: { ok: true } });
  });
});
