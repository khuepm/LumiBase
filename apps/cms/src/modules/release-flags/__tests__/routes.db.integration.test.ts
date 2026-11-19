import { auditLog, releaseManifests, settings, sites, users, type Database } from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import type { AppEnv, AuthPrincipal } from '../../../env';
import { requireReleaseFlag } from '../middleware';
import { releaseFlagsRouter } from '../routes';
import { resetReleaseFlagStateForTests } from '../service';
import { iso, makeSigner } from './signing';

/**
 * Route guards for `/api/v1/release-flags` (#869; DoD §2c) on real Postgres:
 * who may read, who may change a site's choices, who may submit a manifest,
 * and that a gated route answers 404 until the flag is released and chosen.
 */

const SITE = 'rf-routes-site';
const OTHER_SITE = 'rf-routes-other';
const signer = makeSigner('lumibase-release-v1');
const ENV = { LUMIBASE_RELEASE_PUBLIC_KEYS: JSON.stringify(signer.publicKeys) };
const manifest = (issuedAtMs: number, flags: Record<string, boolean>) =>
  signer.envelope({ v: 1, issuedAt: iso(issuedAtMs), audience: '*', flags });

describe.skipIf(!hasDbIntegrationUrl)('/release-flags routes — DB integration', () => {
  let db: Database;
  let bootstrapId = '';
  let memberId = '';
  let savedManifests: (typeof releaseManifests.$inferSelect)[] = [];
  /** The instance's real bootstrap admin, demoted for the test and restored after. */
  let previousBootstrapId: string | null = null;

  const principals = {
    member: (): AuthPrincipal => ({ type: 'user', userId: memberId, email: 'member@rf.test', roles: [], raw: {} }),
    siteAdmin: (): AuthPrincipal => ({ email: 'dev@rf.test', roles: ['admin'], raw: { dev: true } }),
    bootstrap: (): AuthPrincipal => ({ type: 'user', userId: bootstrapId, email: 'boot@rf.test', roles: ['admin'], raw: {} }),
    bootstrapViaApiKey: (): AuthPrincipal => ({
      type: 'api_key', userId: bootstrapId, apiKeyId: 'key-1', roles: ['admin'], raw: {},
    }),
  };

  function app(principal: AuthPrincipal, siteId = SITE) {
    const cache = new MemoryCacheProvider();
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', siteId);
      c.set('auth', principal);
      c.set('runtime', { cache } as unknown as AppEnv['Variables']['runtime']);
      await next();
    });
    a.route('/release-flags', releaseFlagsRouter);
    a.get('/gated', requireReleaseFlag('content-environments'), (c) => c.json({ ok: true }));
    return a;
  }

  const call = (principal: AuthPrincipal, method: string, path: string, body?: unknown, siteId?: string) =>
    app(principal, siteId).request(
      path,
      { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
      ENV,
    );

  beforeAll(async () => {
    db = await connectDbIntegration('release-flags-routes');
    savedManifests = await db.select().from(releaseManifests);
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { id: SITE, name: SITE, organizationId: org },
      { id: OTHER_SITE, name: OTHER_SITE, organizationId: org },
    ]).onConflictDoNothing();
    const [boot] = await db.insert(users).values({ email: 'boot@rf.test', status: 'active', isBootstrap: false }).returning({ id: users.id });
    const [member] = await db.insert(users).values({ email: 'member@rf.test', status: 'active' }).returning({ id: users.id });
    bootstrapId = boot!.id;
    memberId = member!.id;
    // `users_is_bootstrap_unique` allows one bootstrap user per instance, so the
    // existing one (if any) is demoted for the duration and restored in afterAll.
    const [previous] = await db.select({ id: users.id }).from(users).where(eq(users.isBootstrap, true)).limit(1);
    previousBootstrapId = previous?.id ?? null;
    await db.update(users).set({ isBootstrap: false }).where(eq(users.isBootstrap, true));
    await db.update(users).set({ isBootstrap: true }).where(eq(users.id, bootstrapId));
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(settings).where(inArray(settings.siteId, [SITE, OTHER_SITE]));
    await db.delete(auditLog).where(inArray(auditLog.siteId, [SITE, OTHER_SITE]));
    await db.delete(users).where(inArray(users.id, [bootstrapId, memberId].filter(Boolean)));
    if (previousBootstrapId) {
      await db.update(users).set({ isBootstrap: true }).where(eq(users.id, previousBootstrapId));
    }
    await db.delete(sites).where(inArray(sites.id, [SITE, OTHER_SITE]));
    await db.delete(releaseManifests);
    if (savedManifests.length) await db.insert(releaseManifests).values(savedManifests);
  });

  beforeEach(async () => {
    resetReleaseFlagStateForTests();
    await db.delete(releaseManifests);
    await db.delete(settings).where(inArray(settings.siteId, [SITE, OTHER_SITE]));
  });

  it('members see only released flags as key + enabled; site admins see the full state', async () => {
    const member = await call(principals.member(), 'GET', '/release-flags');
    expect(member.status).toBe(200);
    const memberBody = (await member.json()) as { data: Array<Record<string, unknown>> };
    // Dark and not released: the key itself stays hidden from members.
    expect(memberBody.data.find((f) => f.key === 'content-environments')).toBeUndefined();
    // Site admins see every declared flag, released or not.
    const admin = await call(principals.siteAdmin(), 'GET', '/release-flags');
    const adminBody = (await admin.json()) as { data: Array<Record<string, unknown>> };
    expect(adminBody.data.find((f) => f.key === 'content-environments')).toMatchObject({
      stage: 'dark', released: false, releasedBy: 'stage', siteToggle: true, owner: '#853',
    });

    await call(principals.bootstrap(), 'PUT', '/release-flags/manifest', manifest(Date.now() - 1000, { 'content-environments': true }));
    resetReleaseFlagStateForTests();
    const released = (await (await call(principals.member(), 'GET', '/release-flags')).json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(released.data).toContainEqual({ key: 'content-environments', enabled: false });
    expect(Object.keys(released.data[0]!).sort()).toEqual(['enabled', 'key']);

  });

  it('PUT /site is site-admin only and validates keys', async () => {
    expect((await call(principals.member(), 'PUT', '/release-flags/site', { flags: { 'content-environments': true } })).status).toBe(403);

    const unknown = await call(principals.siteAdmin(), 'PUT', '/release-flags/site', { flags: { nope: true } });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { errors: Array<{ code: string }> }).errors[0]?.code).toBe('UNKNOWN_FLAG');

    expect((await call(principals.siteAdmin(), 'PUT', '/release-flags/site', { flags: {} })).status).toBe(400);
    expect((await call(principals.siteAdmin(), 'PUT', '/release-flags/site', { flags: { 'content-environments': 'yes' } })).status).toBe(400);

    const ok = await call(principals.siteAdmin(), 'PUT', '/release-flags/site', { flags: { 'content-environments': true } });
    expect(ok.status).toBe(200);
    // Stored but not effective: the release gate is still closed.
    expect(await ok.json()).toMatchObject({
      data: { stored: { 'content-environments': true }, flags: [{ key: 'content-environments', released: false, enabled: false, siteValue: true }] },
    });
    const audits = await db.select().from(auditLog).where(eq(auditLog.siteId, SITE));
    expect(audits.some((a) => a.event === 'release_flags.site_updated')).toBe(true);
  });

  it('manifest endpoints refuse members, site admins and API keys', async () => {
    for (const principal of [principals.member(), principals.siteAdmin(), principals.bootstrapViaApiKey()]) {
      expect((await call(principal, 'GET', '/release-flags/manifest')).status).toBe(403);
      expect((await call(principal, 'PUT', '/release-flags/manifest', manifest(Date.now(), {}))).status).toBe(403);
      expect((await call(principal, 'POST', '/release-flags/manifest/pull')).status).toBe(403);
    }
  });

  it('the bootstrap admin can submit a signed manifest; tampering and replays are refused', async () => {
    const now = Date.now();
    const accepted = await call(principals.bootstrap(), 'PUT', '/release-flags/manifest', manifest(now - 1000, { 'content-environments': true }));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ data: { accepted: true, unchanged: false, flags: { 'content-environments': true } } });

    const forged = makeSigner('lumibase-release-v1').envelope({ v: 1, issuedAt: iso(now), audience: '*', flags: {} });
    const bad = await call(principals.bootstrap(), 'PUT', '/release-flags/manifest', forged);
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ errors: [{ code: 'MANIFEST_REJECTED', reason: 'BAD_SIGNATURE' }] });

    const replay = await call(principals.bootstrap(), 'PUT', '/release-flags/manifest', manifest(now - 5000, { 'content-environments': false }));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ errors: [{ reason: 'STALE' }] });

    const status = await call(principals.bootstrap(), 'GET', '/release-flags/manifest');
    expect(await status.json()).toMatchObject({
      data: {
        configuration: { trustedKeyIds: ['lumibase-release-v1'], pullConfigured: false },
        manifest: { keyId: 'lumibase-release-v1', source: 'push', flags: { 'content-environments': true }, trusted: true },
      },
    });
    // Accepted and rejected manifests are audited at instance scope (no site).
    const instanceAudits = await db.select().from(auditLog).where(isNull(auditLog.siteId));
    expect(instanceAudits.some((a) => a.event === 'release_flags.manifest_accepted' && a.actorEmail === 'boot@rf.test')).toBe(true);
    expect(instanceAudits.some((a) => a.event === 'release_flags.manifest_rejected')).toBe(true);
    await db.delete(auditLog).where(and(isNull(auditLog.siteId), inArray(auditLog.event, ['release_flags.manifest_accepted', 'release_flags.manifest_rejected'])));

    const pull = await call(principals.bootstrap(), 'POST', '/release-flags/manifest/pull');
    expect(pull.status).toBe(409);
    expect(await pull.json()).toMatchObject({ errors: [{ code: 'PULL_NOT_CONFIGURED' }] });
  });

  it('a gated route is 404 until released AND chosen by the site, per site', async () => {
    const gated = (siteId = SITE) => call(principals.member(), 'GET', '/gated', undefined, siteId);
    expect((await gated()).status).toBe(404);
    expect(await (await gated()).json()).toEqual({ errors: [{ code: 'NOT_FOUND', message: 'Route not found.' }] });

    await call(principals.bootstrap(), 'PUT', '/release-flags/manifest', manifest(Date.now() - 1000, { 'content-environments': true }));
    expect((await gated()).status).toBe(404); // released, but siteDefault is false

    await call(principals.siteAdmin(), 'PUT', '/release-flags/site', { flags: { 'content-environments': true } });
    expect((await gated()).status).toBe(200);
    expect((await gated(OTHER_SITE)).status).toBe(404);
  });
});
