import { auditLog, releaseManifests, settings, sites, type Database } from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { defineReleaseFlags } from '../registry';
import {
  acceptReleaseManifest,
  evaluateReleaseFlags,
  loadAcceptedManifest,
  pullReleaseManifest,
  resetReleaseFlagStateForTests,
  saveSiteReleaseValues,
  SITE_RELEASE_FLAGS_KEY,
  type ReleaseEnv,
} from '../service';
import { iso, makeSigner } from './signing';

/**
 * Release flags against real Postgres (#869): the conditional upsert that
 * refuses older manifests, behaviour on a schema without the manifest table
 * (N-1 upgrade window), per-site isolation of site choices, and cache
 * invalidation after a write.
 */

const SITE_A = 'rf-site-a';
const SITE_B = 'rf-site-b';
const NOW = Date.parse('2026-11-17T10:00:00Z');
const signer = makeSigner('lumibase-release-v1');
const env: ReleaseEnv = { LUMIBASE_RELEASE_PUBLIC_KEYS: JSON.stringify(signer.publicKeys) };
const registry = defineReleaseFlags([
  { key: 'dark-one', description: 'd', stage: 'dark', siteToggle: true, siteDefault: false, owner: '#869', removeBy: '2099-01-01' },
  { key: 'ga-one', description: 'g', stage: 'ga', siteToggle: false, siteDefault: true, owner: '#869', removeBy: '2099-01-01' },
]);
const manifest = (issuedAtMs: number, flags: Record<string, boolean>) =>
  signer.envelope({ v: 1, issuedAt: iso(issuedAtMs), audience: '*', flags });

describe.skipIf(!hasDbIntegrationUrl)('release flags — DB integration', () => {
  let db: Database;
  let saved: (typeof releaseManifests.$inferSelect)[] = [];

  beforeAll(async () => {
    db = await connectDbIntegration('release-flags');
    saved = await db.select().from(releaseManifests);
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db
      .insert(sites)
      .values([
        { id: SITE_A, name: SITE_A, organizationId: org },
        { id: SITE_B, name: SITE_B, organizationId: org },
      ])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(settings).where(inArray(settings.siteId, [SITE_A, SITE_B]));
    await db.delete(sites).where(inArray(sites.id, [SITE_A, SITE_B]));
    await db.delete(releaseManifests);
    if (saved.length) await db.insert(releaseManifests).values(saved);
  });

  beforeEach(async () => {
    resetReleaseFlagStateForTests();
    await db.delete(releaseManifests);
    await db.delete(settings).where(inArray(settings.siteId, [SITE_A, SITE_B]));
  });

  const accept = (input: unknown, now = NOW) =>
    acceptReleaseManifest({ systemDb: db, env, input, source: 'push', actorUserId: null, now, registry });

  it('stores a verified manifest and releases the flag', async () => {
    const outcome = await accept(manifest(NOW - 1000, { 'dark-one': true, 'not-declared': true }));
    expect(outcome).toMatchObject({ ok: true, unchanged: false, unknownKeys: ['not-declared'] });

    const stored = await loadAcceptedManifest(db);
    expect(stored).toMatchObject({ issuedAtMs: NOW - 1000, flags: { 'dark-one': true }, source: 'push' });

    const states = await evaluateReleaseFlags({ systemDb: db, db, cache: null, siteId: SITE_A, env, registry });
    expect(states.get('dark-one')).toMatchObject({ released: true, releasedBy: 'manifest', enabled: false });
  });

  it('refuses an older manifest after a newer one (rollback by replay)', async () => {
    const older = manifest(NOW - 5000, { 'dark-one': false });
    expect((await accept(manifest(NOW - 1000, { 'dark-one': true }))).ok).toBe(true);
    expect(await accept(older)).toEqual({ ok: false, reason: 'STALE' });
    expect((await loadAcceptedManifest(db))?.flags).toEqual({ 'dark-one': true });
  });

  it('the database refuses an older write even when the caller read a stale state (race)', async () => {
    // Replica A has stored a newer manifest. Replica B read the state before
    // that write landed, so its own verification sees no manifest and passes.
    // Only the conditional upsert stands between B and a rollback.
    await accept(manifest(NOW - 1000, { 'dark-one': true }));
    resetReleaseFlagStateForTests();

    let reads = 0;
    const staleFirstRead = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select' && reads++ === 0) {
          const empty = { from: () => empty, where: () => empty, limit: async () => [] };
          return () => empty;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Database;

    const outcome = await acceptReleaseManifest({
      systemDb: staleFirstRead,
      env,
      input: manifest(NOW - 3000, { 'dark-one': false }),
      source: 'pull',
      actorUserId: null,
      now: NOW,
      registry,
    });
    expect(outcome).toEqual({ ok: false, reason: 'STALE' });
    resetReleaseFlagStateForTests();
    expect(await loadAcceptedManifest(db)).toMatchObject({ issuedAtMs: NOW - 1000, flags: { 'dark-one': true } });
  });

  it('two replicas accepting the same new manifest at once both succeed (no spurious STALE)', async () => {
    const m = manifest(NOW - 1000, { 'dark-one': true });
    const outcomes = await Promise.all([accept(m), accept(m), accept(m)]);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.filter((o) => o.ok && !o.unchanged)).toHaveLength(1);
  });

  it('withdraws a stored manifest once its signing key is no longer trusted', async () => {
    await accept(manifest(NOW - 1000, { 'dark-one': true }));
    const evaluate = (e: ReleaseEnv) =>
      evaluateReleaseFlags({ systemDb: db, db, cache: null, siteId: SITE_A, env: e, registry });
    expect((await evaluate(env)).get('dark-one')).toMatchObject({ released: true, releasedBy: 'manifest' });

    const rotated = makeSigner('lumibase-release-v2');
    expect((await evaluate({ LUMIBASE_RELEASE_PUBLIC_KEYS: JSON.stringify(rotated.publicKeys) })).get('dark-one'))
      .toMatchObject({ released: false, releasedBy: 'stage' });
    // Same key id, different PEM (key replaced) also counts as revoked.
    const swapped = { LUMIBASE_RELEASE_PUBLIC_KEYS: JSON.stringify({ [signer.keyId]: rotated.publicKeyPem }) };
    expect((await evaluate(swapped)).get('dark-one')).toMatchObject({ released: false, releasedBy: 'stage' });
  });

  it('audits every accepted manifest at instance scope, including background pulls', async () => {
    const before = await db.select().from(auditLog).where(eq(auditLog.event, 'release_flags.manifest_accepted'));
    await pullReleaseManifest({
      systemDb: db,
      env: { ...env, LUMIBASE_RELEASE_MANIFEST_URL: 'https://releases.example.test/m.json' },
      now: NOW,
      fetchImpl: async () => new Response(JSON.stringify(manifest(NOW - 1000, { 'dark-one': true }))),
    });
    const after = await db.select().from(auditLog).where(eq(auditLog.event, 'release_flags.manifest_accepted'));
    const added = after.filter((row) => !before.some((b) => b.id === row.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ siteId: null, metadata: { source: 'pull', flags: { 'dark-one': true } } });
    await db.delete(auditLog).where(inArray(auditLog.id, added.map((r) => r.id)));
  });

  it('refuses to follow a redirect on pull and asks fetch not to follow one', async () => {
    let seen: RequestInit | undefined;
    const outcome = await pullReleaseManifest({
      systemDb: db,
      env: { ...env, LUMIBASE_RELEASE_MANIFEST_URL: 'https://releases.example.test/m.json' },
      now: NOW,
      fetchImpl: async (_url, init) => {
        seen = init;
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/m.json' } });
      },
    });
    expect(outcome).toEqual({ ok: false, reason: 'REDIRECT_REFUSED' });
    expect(seen?.redirect).toBe('manual');
  });

  it('concurrent site writes to different flags keep both choices', async () => {
    await Promise.all([
      saveSiteReleaseValues(db, null, SITE_A, { 'dark-one': true }),
      saveSiteReleaseValues(db, null, SITE_A, { 'other-flag': false }),
      saveSiteReleaseValues(db, null, SITE_A, { 'third-flag': true }),
    ]);
    const [row] = await db.select().from(settings).where(eq(settings.siteId, SITE_A));
    expect(row?.value).toEqual({ 'dark-one': true, 'other-flag': false, 'third-flag': true });
    await saveSiteReleaseValues(db, null, SITE_A, { 'other-flag': null });
    const [after] = await db.select().from(settings).where(eq(settings.siteId, SITE_A));
    expect(after?.value).toEqual({ 'dark-one': true, 'third-flag': true });
  });

  it('accepting the same manifest twice is a no-op', async () => {
    const same = manifest(NOW - 1000, { 'dark-one': true });
    await accept(same);
    expect(await accept(same)).toMatchObject({ ok: true, unchanged: true });
  });

  it('refuses everything while no trusted key is configured', async () => {
    const outcome = await acceptReleaseManifest({
      systemDb: db, env: {}, input: manifest(NOW, {}), source: 'push', actorUserId: null, now: NOW, registry,
    });
    expect(outcome).toEqual({ ok: false, reason: 'KEYS_NOT_CONFIGURED' });
  });

  it('pulls from the configured URL and keeps the stored manifest when the pull fails', async () => {
    const pullEnv: ReleaseEnv = { ...env, LUMIBASE_RELEASE_MANIFEST_URL: 'https://releases.example.test/m.json' };
    const ok = await pullReleaseManifest({
      systemDb: db,
      env: pullEnv,
      now: NOW,
      fetchImpl: async () => new Response(JSON.stringify(manifest(NOW - 1000, { 'dark-one': true }))),
    });
    expect(ok).toMatchObject({ ok: true, unchanged: false });

    const down = await pullReleaseManifest({
      systemDb: db,
      env: pullEnv,
      now: NOW + 1,
      fetchImpl: async () => new Response('bad gateway', { status: 502 }),
    });
    expect(down).toEqual({ ok: false, reason: 'HTTP_502' });
    expect((await loadAcceptedManifest(db))?.flags).toEqual({ 'dark-one': true });
  });

  it('refuses a plain-http pull URL that is not loopback', async () => {
    const outcome = await pullReleaseManifest({
      systemDb: db,
      env: { ...env, LUMIBASE_RELEASE_MANIFEST_URL: 'http://releases.example.test/m.json' },
      fetchImpl: async () => { throw new Error('must not be called'); },
    });
    expect(outcome).toEqual({ ok: false, reason: 'PULL_NOT_CONFIGURED' });
  });

  it('keeps site choices isolated between sites', async () => {
    await accept(manifest(NOW - 1000, { 'dark-one': true }));
    await saveSiteReleaseValues(db, null, SITE_A, { 'dark-one': true });

    const a = await evaluateReleaseFlags({ systemDb: db, db, cache: null, siteId: SITE_A, env, registry });
    const b = await evaluateReleaseFlags({ systemDb: db, db, cache: null, siteId: SITE_B, env, registry });
    expect(a.get('dark-one')).toMatchObject({ enabled: true, enabledBy: 'site' });
    expect(b.get('dark-one')).toMatchObject({ enabled: false, enabledBy: 'site-default', siteValue: null });

    const rows = await db.select().from(settings).where(eq(settings.key, SITE_RELEASE_FLAGS_KEY));
    expect(rows.filter((r) => r.siteId === SITE_B)).toEqual([]);
  });

  it('a site write is visible on the next evaluation through a shared cache', async () => {
    await accept(manifest(NOW - 1000, { 'dark-one': true }));
    const cache = new MemoryCacheProvider();
    const evaluate = () => evaluateReleaseFlags({ systemDb: db, db, cache, siteId: SITE_A, env, registry });

    expect((await evaluate()).get('dark-one')?.enabled).toBe(false); // populates the cache
    await saveSiteReleaseValues(db, cache, SITE_A, { 'dark-one': true });
    expect((await evaluate()).get('dark-one')?.enabled).toBe(true);
    await saveSiteReleaseValues(db, cache, SITE_A, { 'dark-one': null });
    expect((await evaluate()).get('dark-one')).toMatchObject({ enabled: false, enabledBy: 'site-default' });
  });

  it('an env override wins over the stored manifest', async () => {
    await accept(manifest(NOW - 1000, { 'ga-one': false }));
    const states = await evaluateReleaseFlags({
      systemDb: db, db, cache: null, siteId: SITE_A, env: { ...env, LUMIBASE_RELEASE_FLAGS: 'ga-one=on' }, registry,
    });
    expect(states.get('ga-one')).toMatchObject({ released: true, releasedBy: 'env', enabled: true });
  });
});

describe.skipIf(!hasDbIntegrationUrl)('release flags — schema without the manifest table (N-1)', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('release-flags-n-minus-1');
  });

  // During a rolling upgrade the new image can run against the previous
  // schema, where `lumibase_release_manifests` does not exist yet. Flag
  // evaluation must degrade to stage defaults instead of failing requests.
  // Simulated inside a transaction that renames the table and is rolled back.
  it('evaluates flags from stage defaults when the table is missing', async () => {
    resetReleaseFlagStateForTests();
    const rollback = new Error('rollback');
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE lumibase_release_manifests RENAME TO lumibase_release_manifests_hidden`);
        const states = await evaluateReleaseFlags({
          systemDb: tx as unknown as Database, db: tx as unknown as Database, cache: null, siteId: null, env, registry,
        });
        expect(states.get('dark-one')).toMatchObject({ released: false, releasedBy: 'stage' });
        expect(states.get('ga-one')).toMatchObject({ released: true, releasedBy: 'stage' });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    resetReleaseFlagStateForTests();
  });
});
