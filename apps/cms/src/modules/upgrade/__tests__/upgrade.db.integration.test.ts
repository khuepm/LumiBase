import { auditLog, sites, upgradeRequests, users, type Database } from '@lumibase/database';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import type { AppEnv, AuthPrincipal } from '../../../env';
import { upgradeRouter, setUpgradeFetchForTests } from '../routes';
import { OVERDUE_AFTER_MS } from '../service';

/**
 * `/api/v1/system/upgrade` on real Postgres (#898): who may call it, the
 * preflight, one hook call per target version, failure and retry, and
 * completion once the deployment reports the target version.
 */

const SITE = 'upg-site';
const RELEASES_URL = 'https://releases.example.test/releases.json';
const HOOK_URL = 'https://ci.example.test/upgrade';
const BASE_ENV = {
  LUMIBASE_VERSION: '2.2.0',
  LUMIBASE_RELEASES_URL: RELEASES_URL,
  LUMIBASE_UPGRADE_PROVIDER: 'webhook',
  LUMIBASE_UPGRADE_WEBHOOK_URL: HOOK_URL,
  LUMIBASE_UPGRADE_WEBHOOK_SECRET: 'hook-secret',
  LUMIBASE_INSTANCE_ID: 'lumibase-staging',
};

function releases(version: string, minimum = '2.0.0', migrationWarning = true) {
  const channel = { version, releaseDate: '2026-12-01', changelogUrl: 'https://x/changelog', minimumSafeUpgradeVersion: minimum, migrationWarning };
  return { stable: channel, edge: channel };
}

describe.skipIf(!hasDbIntegrationUrl)('/system/upgrade — DB integration (#898)', () => {
  let db: Database;
  let bootstrapId = '';
  let memberId = '';
  let previousBootstrapId: string | null = null;
  let hookCalls: Array<{ body: Record<string, unknown> }> = [];
  let hookResponse: () => Response = () => new Response(JSON.stringify({ reference: 'run-1' }), { status: 202 });
  let latest = releases('2.3.0');

  const principals = {
    bootstrap: (): AuthPrincipal => ({ type: 'user', userId: bootstrapId, email: 'boot@upg.test', roles: ['admin'], raw: {} }),
    member: (): AuthPrincipal => ({ type: 'user', userId: memberId, email: 'member@upg.test', roles: ['admin'], raw: {} }),
    apiKey: (): AuthPrincipal => ({ type: 'api_key', userId: bootstrapId, apiKeyId: 'key-1', roles: ['admin'], raw: {} }),
  };

  function call(principal: AuthPrincipal, method: string, path: string, body?: unknown, env: Record<string, string> = BASE_ENV) {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('systemDb', db);
      c.set('siteId', SITE);
      c.set('auth', principal);
      await next();
    });
    app.route('/system/upgrade', upgradeRouter);
    return app.request(
      path,
      { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
      env,
    );
  }

  beforeAll(async () => {
    db = await connectDbIntegration('upgrade');
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values({ id: SITE, name: SITE, organizationId: org }).onConflictDoNothing();
    const [boot] = await db.insert(users).values({ email: 'boot@upg.test', status: 'active', isBootstrap: false }).returning({ id: users.id });
    const [member] = await db.insert(users).values({ email: 'member@upg.test', status: 'active' }).returning({ id: users.id });
    bootstrapId = boot!.id;
    memberId = member!.id;
    const [previous] = await db.select({ id: users.id }).from(users).where(eq(users.isBootstrap, true)).limit(1);
    previousBootstrapId = previous?.id ?? null;
    await db.update(users).set({ isBootstrap: false }).where(eq(users.isBootstrap, true));
    await db.update(users).set({ isBootstrap: true }).where(eq(users.id, bootstrapId));
  });

  afterAll(async () => {
    setUpgradeFetchForTests(undefined);
    if (!db) return;
    await db.delete(upgradeRequests);
    await db.delete(auditLog).where(and(isNull(auditLog.siteId), inArray(auditLog.event, ['system.upgrade_requested', 'system.upgrade_request_failed'])));
    await db.delete(users).where(inArray(users.id, [bootstrapId, memberId].filter(Boolean)));
    if (previousBootstrapId) await db.update(users).set({ isBootstrap: true }).where(eq(users.id, previousBootstrapId));
    await db.delete(sites).where(eq(sites.id, SITE));
  });

  beforeEach(async () => {
    await db.delete(upgradeRequests);
    hookCalls = [];
    latest = releases('2.3.0');
    hookResponse = () => new Response(JSON.stringify({ reference: 'run-1' }), { status: 202 });
    setUpgradeFetchForTests(async (url, init) => {
      if (String(url) === RELEASES_URL) return new Response(JSON.stringify(latest));
      if (String(url) === HOOK_URL) {
        hookCalls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return hookResponse();
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
  });

  afterEach(() => setUpgradeFetchForTests(undefined));

  it('refuses everyone but the bootstrap admin as a person', async () => {
    for (const principal of [principals.member(), principals.apiKey()]) {
      for (const [method, path] of [['GET', '/system/upgrade/preflight'], ['GET', '/system/upgrade'], ['POST', '/system/upgrade']] as const) {
        const res = await call(principal, method, path, method === 'POST' ? { targetVersion: '2.3.0', backupAcknowledged: true } : undefined);
        expect(res.status, `${principal.type} ${method} ${path}`).toBe(403);
      }
    }
    expect(hookCalls).toHaveLength(0);
  });

  it('preflight: versions, minimum safe version, migrations, who runs them', async () => {
    const res = await call(principals.bootstrap(), 'GET', '/system/upgrade/preflight');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> & { checks: Array<{ id: string; ok: boolean }> } };
    expect(data).toMatchObject({
      currentVersion: '2.2.0',
      targetVersion: '2.3.0',
      migrationWarning: true,
      backupAcknowledgementRequired: true,
      canUpgrade: true,
      deployment: { runtime: 'docker', provider: 'webhook', configured: true, migrationsRunner: 'startup' },
      migrations: { pending: [], databaseAhead: false },
      request: null,
    });
    expect(data.checks.every((c) => c.ok)).toBe(true);

    latest = releases('2.3.0', '2.2.5');
    const blocked = (await (await call(principals.bootstrap(), 'GET', '/system/upgrade/preflight')).json()) as {
      data: { canUpgrade: boolean; checks: Array<{ id: string; ok: boolean }> };
    };
    expect(blocked.data.canUpgrade).toBe(false);
    expect(blocked.data.checks.find((c) => c.id === 'minimum-safe-version')?.ok).toBe(false);

    const unconfigured = (await (
      await call(principals.bootstrap(), 'GET', '/system/upgrade/preflight', undefined, { LUMIBASE_VERSION: '2.2.0', LUMIBASE_RELEASES_URL: RELEASES_URL })
    ).json()) as { data: { canUpgrade: boolean; deployment: { configured: boolean } } };
    expect(unconfigured.data).toMatchObject({ canUpgrade: false, deployment: { configured: false } });
  });

  it('requires the backup acknowledgement and the preflight target', async () => {
    const noAck = await call(principals.bootstrap(), 'POST', '/system/upgrade', { targetVersion: '2.3.0', backupAcknowledged: false });
    expect(noAck.status).toBe(422);
    const wrong = await call(principals.bootstrap(), 'POST', '/system/upgrade', { targetVersion: '9.9.9', backupAcknowledged: true });
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('TARGET_MISMATCH');
    expect(hookCalls).toHaveLength(0);
  });

  it('fires the hook once per target version, audits it, and completes when the target answers', async () => {
    const first = await call(principals.bootstrap(), 'POST', '/system/upgrade', { targetVersion: '2.3.0', backupAcknowledged: true });
    expect(first.status).toBe(202);
    const created = (await first.json()) as { data: { id: string; status: string; hookReference: string }; meta: { idempotent: boolean } };
    expect(created).toMatchObject({ data: { status: 'requested', hookReference: 'run-1' }, meta: { idempotent: false } });
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.body).toMatchObject({ fromVersion: '2.2.0', targetVersion: '2.3.0', instanceId: 'lumibase-staging', requestId: created.data.id });

    const again = await call(principals.bootstrap(), 'POST', '/system/upgrade', { targetVersion: '2.3.0', backupAcknowledged: true });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { meta: { idempotent: boolean } }).meta.idempotent).toBe(true);
    // Concurrent duplicates also fire nothing.
    await Promise.all([1, 2, 3].map(() => call(principals.bootstrap(), 'POST', '/system/upgrade', { targetVersion: '2.3.0', backupAcknowledged: true })));
    expect(hookCalls).toHaveLength(1);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(isNull(auditLog.siteId), eq(auditLog.event, 'system.upgrade_requested')))
      .orderBy(sql`${auditLog.timestamp} desc`)
      .limit(1);
    expect(audit?.metadata).toMatchObject({ targetVersion: '2.3.0', fromVersion: '2.2.0', provider: 'webhook' });

    // Still on 2.2.0: in progress, and the preflight reports it in flight.
    const progress = (await (await call(principals.bootstrap(), 'GET', '/system/upgrade')).json()) as { data: { status: string } };
    expect(progress.data.status).toBe('requested');

    // The new version answers.
    const done = (await (
      await call(principals.bootstrap(), 'GET', '/system/upgrade', undefined, { ...BASE_ENV, LUMIBASE_VERSION: '2.3.0' })
    ).json()) as { data: { status: string; completedAt: string | null } };
    expect(done.data.status).toBe('completed');
    expect(done.data.completedAt).not.toBeNull();
  });

  it('a refused hook fails the request; retry fires it again only when asked', async () => {
    hookResponse = () => new Response('denied', { status: 403 });
    const failed = await call(principals.bootstrap(), 'POST', '/system/upgrade', { targetVersion: '2.3.0', backupAcknowledged: true });
    expect(failed.status).toBe(502);
    const body = (await failed.json()) as { errors: Array<{ code: string }>; meta: { request: { status: string; error: string } } };
    expect(body.errors[0]!.code).toBe('UPGRADE_HOOK_FAILED');
    expect(body.meta.request).toMatchObject({ status: 'failed', error: 'HTTP_403' });

    const noRetry = await call(principals.bootstrap(), 'POST', '/system/upgrade', { targetVersion: '2.3.0', backupAcknowledged: true });
    expect(noRetry.status).toBe(409);
    expect(hookCalls).toHaveLength(1);

    hookResponse = () => new Response(null, { status: 204 });
    const retried = await call(principals.bootstrap(), 'POST', '/system/upgrade', { targetVersion: '2.3.0', backupAcknowledged: true, retry: true });
    expect(retried.status).toBe(202);
    expect(((await retried.json()) as { data: { status: string; attempts: number } }).data).toMatchObject({ status: 'requested', attempts: 2 });
    expect(hookCalls).toHaveLength(2);
  });

  it('blocks a second target while one is in flight, and lets an overdue request be retried', async () => {
    await call(principals.bootstrap(), 'POST', '/system/upgrade', { targetVersion: '2.3.0', backupAcknowledged: true });
    latest = releases('2.4.0');
    const other = await call(principals.bootstrap(), 'POST', '/system/upgrade', { targetVersion: '2.4.0', backupAcknowledged: true });
    expect(other.status).toBe(409);
    expect(((await other.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('PREFLIGHT_FAILED');

    // The 2.3.0 request never completed: after the overdue window it can be retried.
    latest = releases('2.3.0');
    await db.update(upgradeRequests).set({ requestedAt: new Date(Date.now() - OVERDUE_AFTER_MS - 60_000) });
    const status = (await (await call(principals.bootstrap(), 'GET', '/system/upgrade')).json()) as { data: { overdue: boolean } };
    expect(status.data.overdue).toBe(true);
    const retried = await call(principals.bootstrap(), 'POST', '/system/upgrade', { targetVersion: '2.3.0', backupAcknowledged: true, retry: true });
    expect(retried.status).toBe(202);
    expect(hookCalls).toHaveLength(2);
  });
});
