import { eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { environments, settings, sites, users, type Database } from '@lumibase/database';
import { EnvKeyProvider, MemoryCacheProvider } from '@lumibase/runtime';
import type { AppEnv, AuthPrincipal } from '../../../env';
import { environmentsRouter } from '../../../routes/environments';
import { resetReleaseFlagStateForTests } from '../../../modules/release-flags/service';
import { provisionSite } from '../../site-provisioning';
import { driveFork } from '../fork';
import { forgetEnvironmentSite } from '../isolation';

/** Shared fixture for the Content Environments DB suites (#853). */
export const KEY = Buffer.alloc(32, 43).toString('base64');
export const keyProvider = new EnvKeyProvider(new Map([['v0', KEY]]), 'v0');

export function envHarness(db: () => Database, origin: string, adminId: string) {
  const principal = (): AuthPrincipal => ({ type: 'user', userId: adminId, email: `${adminId}@x.dev`, roles: [], raw: {} });

  function app(siteId = origin, who: AuthPrincipal = principal()) {
    const cache = new MemoryCacheProvider();
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => {
      (c as unknown as { env: Record<string, unknown> }).env = { LUMIBASE_RELEASE_FLAGS: 'content-environments=on' };
      c.set('db', db());
      c.set('siteId', siteId);
      c.set('auth', who);
      c.set('runtime', { cache, keys: keyProvider } as unknown as AppEnv['Variables']['runtime']);
      await next();
    });
    a.route('/environments', environmentsRouter);
    a.onError((err, c) => {
      console.error('[env-test] unhandled', err);
      return c.json({ errors: [{ code: 'INTERNAL', message: String(err) }] }, 500);
    });
    return a;
  }

  async function call(method: string, path: string, body?: unknown, siteId = origin) {
    const res = await app(siteId).request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> & { data?: unknown; errors?: Array<{ code: string; details?: unknown }> } };
  }

  async function reset() {
    resetReleaseFlagStateForTests();
    const children = await db().select({ id: environments.environmentSiteId }).from(environments).where(eq(environments.siteId, origin));
    await db().delete(sites).where(inArray(sites.id, [origin, ...children.map((c) => c.id)])).catch(() => undefined);
    forgetEnvironmentSite();
    await db().insert(users).values({ id: adminId, email: `${adminId}@x.dev`, status: 'active' }).onConflictDoNothing();
    const organizationId = ((await db().execute(sql`SELECT id FROM lumibase_organizations WHERE slug = 'default'`)) as unknown as Array<{ id: string }>)[0]!.id;
    await provisionSite(db(), { id: origin, name: origin, organizationId, creatorUserId: adminId });
    await db().insert(settings).values({ siteId: origin, key: 'release.flags', value: { 'content-environments': true } });
  }

  async function cleanup() {
    const children = await db().select({ id: environments.environmentSiteId }).from(environments).where(eq(environments.siteId, origin));
    await db().delete(sites).where(inArray(sites.id, [origin, ...children.map((c) => c.id)])).catch(() => undefined);
    await db().delete(users).where(eq(users.id, adminId)).catch(() => undefined);
    forgetEnvironmentSite();
  }

  /** POST /environments and drive the fork to `ready`. */
  async function fork(key: string, contentScope: unknown = { mode: 'all' }) {
    const res = await call('POST', '/environments', { key, name: key, contentScope });
    if (res.status !== 202) throw new Error(`fork failed: ${JSON.stringify(res.json)}`);
    const view = res.json.data as { id: string; siteId: string };
    for (let i = 0; i < 100; i++) {
      const [row] = await db().select().from(environments).where(eq(environments.id, view.id));
      if (row!.status === 'ready') return { id: view.id, siteId: view.siteId };
      if (row!.status === 'failed') throw new Error(`fork failed: ${row!.statusReason}`);
      await driveFork({ db: db(), keyProvider }, view.id, 10_000);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('fork did not finish');
  }

  return { app, call, reset, cleanup, fork, principal };
}
