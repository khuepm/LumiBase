import { releaseManifests, settings, sites, type Database } from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { readDecisionSettings } from '../../../services/decision-governance';
import { getContentOsFlags } from '../../../services/feature-flags';
import { rememberReleaseEnv } from '../gate';
import {
  acceptReleaseManifest,
  evaluateReleaseFlags,
  invalidateSiteReleaseValues,
  loadSiteReleaseValues,
  resetReleaseFlagStateForTests,
  saveSiteReleaseValues,
  type ReleaseEnv,
} from '../service';
import { iso, makeSigner } from './signing';

/**
 * #896 against real Postgres: the Content OS and AI-decision switches keep
 * their stored values and their behaviour, and become withdrawable by the
 * release gate. Every case compares the feature's own reader before (the
 * stored value alone) and after (through the gate).
 */

const SITE = 'rf-legacy-a';
const OTHER = 'rf-legacy-b';
const NOW = Date.now();
const signer = makeSigner('lumibase-release-legacy');
const keysEnv: ReleaseEnv = { LUMIBASE_RELEASE_PUBLIC_KEYS: JSON.stringify(signer.publicKeys) };

async function store(db: Database, siteId: string, key: string, value: Record<string, unknown>) {
  await db
    .insert(settings)
    .values({ siteId, key, value, scope: 'site' })
    .onConflictDoUpdate({ target: [settings.siteId, settings.key], set: { value } });
}

describe.skipIf(!hasDbIntegrationUrl)('legacy switches under the registry — DB integration (#896)', () => {
  let db: Database;
  let saved: (typeof releaseManifests.$inferSelect)[] = [];

  beforeAll(async () => {
    db = await connectDbIntegration('release-flags-legacy');
    saved = await db.select().from(releaseManifests);
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db
      .insert(sites)
      .values([
        { id: SITE, name: SITE, organizationId: org },
        { id: OTHER, name: OTHER, organizationId: org },
      ])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    rememberReleaseEnv(null);
    if (!db) return;
    await db.delete(settings).where(inArray(settings.siteId, [SITE, OTHER]));
    await db.delete(sites).where(inArray(sites.id, [SITE, OTHER]));
    await db.delete(releaseManifests);
    if (saved.length) await db.insert(releaseManifests).values(saved);
  });

  beforeEach(async () => {
    resetReleaseFlagStateForTests();
    rememberReleaseEnv({});
    await db.delete(releaseManifests);
    await db.delete(settings).where(inArray(settings.siteId, [SITE, OTHER]));
  });

  afterEach(() => rememberReleaseEnv(null));

  it('no manifest, no override: Content OS flags read exactly the stored values', async () => {
    expect(await getContentOsFlags(db, SITE)).toEqual({ reconciler: false, vetoWindow: false, agentReview: false, mcp: false });
    await store(db, SITE, 'contentOs', { reconciler: true, vetoWindow: false, mcp: 'true', agentReviewMinConfidence: 0.9 });
    expect(await getContentOsFlags(db, SITE)).toEqual({ reconciler: true, vetoWindow: false, agentReview: false, mcp: false });
    await store(db, SITE, 'contentOs', { reconciler: true, vetoWindow: true, agentReview: true, mcp: true });
    expect(await getContentOsFlags(db, SITE)).toEqual({ reconciler: true, vetoWindow: true, agentReview: true, mcp: true });
    // The other site is untouched.
    expect(await getContentOsFlags(db, OTHER)).toEqual({ reconciler: false, vetoWindow: false, agentReview: false, mcp: false });
  });

  it('no manifest, no override: AI decision flows/drift read exactly the stored values', async () => {
    await store(db, SITE, 'aiDecisions', { enabled: true, flows: true, drift: false, requestsPerHour: 10 });
    expect(await readDecisionSettings(db, SITE)).toMatchObject({ enabled: true, flows: true, drift: false, requestsPerHour: 10 });
    // Malformed object reads all-off, as before.
    await store(db, SITE, 'aiDecisions', { enabled: 'yes', flows: true });
    expect(await readDecisionSettings(db, SITE)).toMatchObject({ enabled: false, flows: false, drift: false });
  });

  it('LUMIBASE_RELEASE_FLAGS withdraws a switch on the deployment without touching the stored value', async () => {
    await store(db, SITE, 'contentOs', { reconciler: true, mcp: true });
    await store(db, SITE, 'aiDecisions', { enabled: true, flows: true, drift: true });
    rememberReleaseEnv({ LUMIBASE_RELEASE_FLAGS: 'content-os.mcp=off,ai-decisions.drift=off' });
    expect(await getContentOsFlags(db, SITE)).toMatchObject({ reconciler: true, mcp: false });
    expect(await readDecisionSettings(db, SITE)).toMatchObject({ enabled: true, flows: true, drift: false });
    const [row] = await db
      .select()
      .from(settings)
      .where(and(eq(settings.siteId, SITE), eq(settings.key, 'contentOs')));
    expect(row?.value).toEqual({ reconciler: true, mcp: true });
    // Turning the gate on never turns a site's switch on.
    rememberReleaseEnv({ LUMIBASE_RELEASE_FLAGS: 'content-os.veto-window=on' });
    expect((await getContentOsFlags(db, SITE)).vetoWindow).toBe(false);
  });

  it('a signed manifest withdraws a switch; a failed read keeps the last manifest', async () => {
    await store(db, SITE, 'contentOs', { mcp: true, agentReview: true });
    rememberReleaseEnv(keysEnv);
    const accepted = await acceptReleaseManifest({
      systemDb: db,
      env: keysEnv,
      input: signer.envelope({ v: 1, issuedAt: iso(NOW - 1000), audience: '*', flags: { 'content-os.mcp': false } }),
      source: 'push',
      actorUserId: null,
      now: NOW,
    });
    expect(accepted.ok).toBe(true);
    expect(await getContentOsFlags(db, SITE)).toMatchObject({ mcp: false, agentReview: true });

    // The database read fails (cache expired, connection lost): the last
    // manifest this process read still applies — no silent re-enable.
    resetReleaseFlagStateForTests();
    expect((await getContentOsFlags(db, SITE)).mcp).toBe(false);
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select') {
          return (...args: unknown[]) => {
            const real = (target.select as (...a: unknown[]) => { from: (t: unknown) => unknown })(...args);
            return {
              from: (table: unknown) => {
                if (table === releaseManifests) throw new Error('connection lost');
                return real.from(table);
              },
            };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Database;
    const { clearManifestCache } = await import('../state');
    clearManifestCache();
    expect((await getContentOsFlags(broken, SITE)).mcp).toBe(false);
  });

  it('PUT /release-flags/site semantics: a legacy switch is written to its original object', async () => {
    await store(db, SITE, 'contentOs', { reconciler: true, agentReviewMinConfidence: 0.8 });
    const cache = new MemoryCacheProvider();
    const stored = await saveSiteReleaseValues(db, cache, SITE, {
      'content-os.mcp': true,
      'content-os.reconciler': null,
      'content-environments': true,
    });
    expect(stored).toEqual({ 'content-os.mcp': true, 'content-environments': true });
    const rows = await db.select().from(settings).where(eq(settings.siteId, SITE));
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey.contentOs).toEqual({ mcp: true, agentReviewMinConfidence: 0.8 });
    expect(byKey['release.flags']).toEqual({ 'content-environments': true });
    expect(await getContentOsFlags(db, SITE)).toMatchObject({ mcp: true, reconciler: false });

    const states = await evaluateReleaseFlags({ systemDb: db, db, cache, siteId: SITE, env: {} });
    expect(states.get('content-os.mcp')).toMatchObject({ released: true, releasedBy: 'stage', enabled: true, enabledBy: 'site', siteValue: true });
    expect(states.get('content-os.reconciler')).toMatchObject({ enabled: false, enabledBy: 'site-default', siteValue: null });
  });

  it('a write outside the release-flag API is visible once the cache entry is dropped', async () => {
    const cache = new MemoryCacheProvider();
    expect(await loadSiteReleaseValues(db, cache, SITE)).toEqual({});
    await store(db, SITE, 'aiDecisions', { enabled: true, flows: true });
    expect(await loadSiteReleaseValues(db, cache, SITE)).toEqual({}); // cached
    await invalidateSiteReleaseValues(cache, SITE);
    expect(await loadSiteReleaseValues(db, cache, SITE)).toEqual({ 'ai-decisions.flows': true });
  });
});
