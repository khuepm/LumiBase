import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { roles, sites, systemState, userSites, users, type Database } from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';

import type { AppEnv } from '../../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { adminEmailIdentityRouter } from '../../../routes/admin-email-identity';
import { authRouter } from '../../../routes/auth';
import { hashPassword } from '../../../services/auth/password';
import { loadLockoutPolicyFromSettings } from '../../login-guard/middleware';
import { emailRoot } from '../normalize';
import { inviteUserToSite } from '../invite';
import {
  isEmailIdentityConflict,
  loadEmailIdentityMode,
  setInstanceEmailIdentityMode,
  setSiteEmailIdentityStrict,
} from '../service';
import { EMAIL_ROOT_FIXTURES } from './fixtures';

/**
 * Email identity policy (#794 PR 1) against real Postgres: the SQL
 * `lumibase_email_root()` mirror, the derived-column triggers, the guarded
 * instance/site policy changes, strict-site membership, invite, register and
 * alias login/lockout.
 *
 * Every row this suite writes is tagged `eidit` (in the local part or the
 * `eid-it.test` domain) so cleanup never touches another suite's data. The
 * instance mode is a global singleton: it is reset to `exact` before each test
 * and restored at the end.
 */

const DOMAIN = 'eid-it.test';
const SITE_STRICT = 'site_eid_it_strict';
const SITE_OPEN = 'site_eid_it_open';
const JWT_SECRET = 'eid-it-secret-do-not-use';
const PASSWORD = 'CorrectHorseBatteryStaple!42';

describe.skipIf(!hasDbIntegrationUrl)('Email identity policy — DB integration', () => {
  let db: Database;
  let insertedSingleton = false;
  let previousMode: 'exact' | 'root' = 'exact';

  async function cleanup(): Promise<void> {
    await db.delete(userSites).where(inArray(userSites.siteId, [SITE_STRICT, SITE_OPEN]));
    await db.execute(sql`DELETE FROM lumibase_login_attempts WHERE email_lower LIKE '%eidit%' OR email_lower LIKE ${`%@${DOMAIN}`}`);
    await db.execute(sql`DELETE FROM lumibase_users WHERE lower(email) LIKE '%eidit%' OR lower(email) LIKE ${`%@${DOMAIN}`}`);
    await db.delete(roles).where(inArray(roles.siteId, [SITE_STRICT, SITE_OPEN]));
    await db.delete(sites).where(inArray(sites.id, [SITE_STRICT, SITE_OPEN]));
  }

  async function addUser(email: string, extra: Partial<typeof users.$inferInsert> = {}) {
    const [row] = await db
      .insert(users)
      .values({ email, status: 'active', ...extra })
      .returning({ id: users.id, email: users.email, canonical: users.emailCanonical, root: users.emailRoot });
    return row!;
  }

  async function userRow(id: string) {
    const [row] = await db
      .select({ email: users.email, canonical: users.emailCanonical, root: users.emailRoot, lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.id, id));
    return row;
  }

  async function countEmail(email: string): Promise<number> {
    const rows = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
    return rows.length;
  }

  beforeAll(async () => {
    db = await connectDbIntegration('email-identity');
    const inserted = await db.execute(sql`
      INSERT INTO lumibase_system_state (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING RETURNING id`);
    insertedSingleton = (inserted as unknown as unknown[]).length > 0;
    previousMode = await loadEmailIdentityMode(db);
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await setInstanceEmailIdentityMode(db, previousMode);
    if (insertedSingleton) await db.delete(systemState).where(eq(systemState.id, 'singleton'));
  });

  beforeEach(async () => {
    await cleanup();
    const reset = await setInstanceEmailIdentityMode(db, 'exact');
    expect(reset.ok).toBe(true);
    // Several tests switch the (global) instance to `root`, which is refused —
    // correctly — while ANY two accounts share a root mailbox. CI runs every
    // suite on one database, so name a foreign collision explicitly instead of
    // failing later with an opaque `{ ok: false }` mismatch.
    const foreign = await setInstanceEmailIdentityMode(db, 'root', { dryRun: true });
    if (!foreign.ok) {
      throw new Error(
        `email-identity suite precondition: the shared database already holds accounts that share a root mailbox ` +
          `(not created by this suite), so switching to root mode is refused: ${JSON.stringify(foreign)}`,
      );
    }
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId: org, id: SITE_STRICT, name: 'EID strict' },
      { organizationId: org, id: SITE_OPEN, name: 'EID open' },
    ]);
    await db.update(sites).set({ emailIdentityStrict: true }).where(eq(sites.id, SITE_STRICT));
  });

  // ── normaliser parity ────────────────────────────────────────────────

  it('SQL lumibase_email_root() matches TS emailRoot() on every fixture', async () => {
    for (const [input, expected] of EMAIL_ROOT_FIXTURES) {
      const rows = await db.execute(sql`SELECT lumibase_email_root(${input}) AS root`);
      const sqlRoot = (rows as unknown as Array<{ root: string }>)[0]?.root;
      expect({ input, root: sqlRoot }).toEqual({ input, root: emailRoot(input) });
      expect(sqlRoot).toBe(expected);
    }
  });

  // ── triggers ─────────────────────────────────────────────────────────

  it('trigger fills email_root / email_canonical on insert and on email change', async () => {
    const u = await addUser(`Foo.Bar+News@EID-IT.test`);
    expect(u.root).toBe(`foo.bar@${DOMAIN}`);
    expect(u.canonical).toBe(`foo.bar+news@${DOMAIN}`); // exact: case-folded only

    await db.update(users).set({ email: `baz+x@${DOMAIN}` }).where(eq(users.id, u.id));
    expect(await userRow(u.id)).toMatchObject({ root: `baz@${DOMAIN}`, canonical: `baz+x@${DOMAIN}` });

    expect((await setInstanceEmailIdentityMode(db, 'root')).ok).toBe(true);
    const g = await addUser('EidIt.Probe+Promo@GoogleMail.com');
    expect(g.root).toBe('eiditprobe@gmail.com');
    expect(g.canonical).toBe('eiditprobe@gmail.com'); // root: canonical = root mailbox
  });

  it('under root mode the unique index rejects a second alias of the same mailbox', async () => {
    expect((await setInstanceEmailIdentityMode(db, 'root')).ok).toBe(true);
    await addUser('eidit.one@gmail.com');
    const err = await addUser('eiditone+x@googlemail.com').catch((e: unknown) => e);
    expect(isEmailIdentityConflict(err)).toBe(true);
  });

  // ── instance mode change ─────────────────────────────────────────────

  it('exact → root refuses with the colliding accounts and changes nothing', async () => {
    const a = await addUser('eidit.one@gmail.com');
    const b = await addUser('eiditone+x@gmail.com');
    await addUser(`solo@${DOMAIN}`);

    const result = await setInstanceEmailIdentityMode(db, 'root');
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'IDENTITY_COLLISION') throw new Error('expected IDENTITY_COLLISION');
    const group = result.collisions.find((c) => c.root === 'eiditone@gmail.com');
    expect(group?.accounts.map((x) => x.userId).sort()).toEqual([a.id, b.id].sort());
    expect(result.collisions.some((c) => c.root === `solo@${DOMAIN}`)).toBe(false);

    expect(await loadEmailIdentityMode(db)).toBe('exact');
    expect((await userRow(b.id))?.canonical).toBe('eiditone+x@gmail.com');
  });

  it('exact → root succeeds without collisions and re-keys email_canonical', async () => {
    const a = await addUser('EidIt.Two+tag@gmail.com');
    const result = await setInstanceEmailIdentityMode(db, 'root');
    expect(result).toMatchObject({ ok: true, changed: true, dryRun: false, previous: 'exact', current: 'root' });
    expect(await loadEmailIdentityMode(db)).toBe('root');
    expect((await userRow(a.id))?.canonical).toBe('eidittwo@gmail.com');
  });

  it('root → exact always succeeds and restores lower(email)', async () => {
    const a = await addUser('EidIt.Three+tag@gmail.com');
    expect((await setInstanceEmailIdentityMode(db, 'root')).ok).toBe(true);
    const result = await setInstanceEmailIdentityMode(db, 'exact');
    expect(result).toMatchObject({ ok: true, changed: true, previous: 'root', current: 'exact' });
    expect((await userRow(a.id))?.canonical).toBe('eidit.three+tag@gmail.com');
  });

  it('dryRun reports the outcome but leaves mode and data untouched', async () => {
    const a = await addUser('eidit.four+tag@gmail.com');
    const ok = await setInstanceEmailIdentityMode(db, 'root', { dryRun: true });
    expect(ok).toMatchObject({ ok: true, changed: true, dryRun: true, current: 'root' });
    expect(await loadEmailIdentityMode(db)).toBe('exact');
    expect((await userRow(a.id))?.canonical).toBe('eidit.four+tag@gmail.com');

    await addUser('eiditfour@gmail.com');
    const refused = await setInstanceEmailIdentityMode(db, 'root', { dryRun: true });
    expect(refused).toMatchObject({ ok: false, code: 'IDENTITY_COLLISION' });
    expect(await loadEmailIdentityMode(db)).toBe('exact');
  });

  it('PUT /admin/email-identity/instance: 409 + collisions, bootstrap-only, 200 on success', async () => {
    // `users_is_bootstrap_unique` allows one bootstrap admin per instance, and
    // an earlier suite on the shared database may already have created it —
    // act as that one when present rather than assume a fresh instance.
    const [existingBootstrap] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isBootstrap, true))
      .limit(1);
    const admin = existingBootstrap ?? (await addUser(`boot@${DOMAIN}`, { isBootstrap: true }));
    const other = await addUser(`plain@${DOMAIN}`);
    await addUser('eidit.five@gmail.com');
    const dupe = await addUser('eiditfive+x@gmail.com');

    const app = new Hono<AppEnv>();
    let actor = admin.id;
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('systemDb', db);
      c.set('siteId', SITE_OPEN);
      c.set('auth', { type: 'user', userId: actor, email: `x@${DOMAIN}` } as AppEnv['Variables']['auth']);
      await next();
    });
    app.route('/admin/email-identity', adminEmailIdentityRouter);
    const put = (body: unknown) =>
      app.request('/admin/email-identity/instance', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    actor = other.id;
    expect((await put({ mode: 'root' })).status).toBe(403);

    actor = admin.id;
    const refused = await put({ mode: 'root' });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { errors: Array<{ code: string; collisions: Array<{ root: string }> }> };
    expect(body.errors[0]?.code).toBe('IDENTITY_COLLISION');
    expect(body.errors[0]?.collisions.map((c) => c.root)).toContain('eiditfive@gmail.com');

    await db.delete(users).where(eq(users.id, dupe.id));
    const applied = await put({ mode: 'root' });
    expect(applied.status).toBe(200);
    expect(((await applied.json()) as { data: unknown }).data).toMatchObject({ previous: 'exact', current: 'root', changed: true });
  });

  // ── site strict ──────────────────────────────────────────────────────

  it('a strict site rejects a second membership for the same root mailbox; an open site allows it', async () => {
    const a = await addUser(`member+a@${DOMAIN}`);
    const b = await addUser(`member+b@${DOMAIN}`);
    await db.insert(userSites).values({ userId: a.id, siteId: SITE_STRICT });
    const err = await db.insert(userSites).values({ userId: b.id, siteId: SITE_STRICT }).catch((e: unknown) => e);
    expect(isEmailIdentityConflict(err)).toBe(true);

    await db.insert(userSites).values([{ userId: a.id, siteId: SITE_OPEN }, { userId: b.id, siteId: SITE_OPEN }]);
    const open = await db.select({ key: userSites.identityKey }).from(userSites).where(eq(userSites.siteId, SITE_OPEN));
    expect(open.map((r) => r.key)).toEqual([null, null]);
  });

  it('an email change re-keys strict memberships (and refuses to land on a taken mailbox)', async () => {
    const a = await addUser(`k1@${DOMAIN}`);
    const b = await addUser(`k2@${DOMAIN}`);
    await db.insert(userSites).values([{ userId: a.id, siteId: SITE_STRICT }, { userId: b.id, siteId: SITE_STRICT }]);

    await db.update(users).set({ email: `k3+x@${DOMAIN}` }).where(eq(users.id, a.id));
    const [m] = await db.select({ key: userSites.identityKey }).from(userSites).where(eq(userSites.userId, a.id));
    expect(m?.key).toBe(`k3@${DOMAIN}`);

    const err = await db.update(users).set({ email: `k2+z@${DOMAIN}` }).where(eq(users.id, a.id)).catch((e: unknown) => e);
    expect(isEmailIdentityConflict(err)).toBe(true);
  });

  it('site strict: tightening refuses on collisions, loosening always succeeds, dryRun is side-effect free', async () => {
    await db.update(sites).set({ emailIdentityStrict: false }).where(eq(sites.id, SITE_STRICT));
    const a = await addUser(`dup+a@${DOMAIN}`);
    const b = await addUser(`dup+b@${DOMAIN}`);
    await db.insert(userSites).values([{ userId: a.id, siteId: SITE_STRICT }, { userId: b.id, siteId: SITE_STRICT }]);

    const refused = await setSiteEmailIdentityStrict(db, SITE_STRICT, true);
    expect(refused).toMatchObject({ ok: false, code: 'IDENTITY_COLLISION' });

    await db.delete(userSites).where(eq(userSites.userId, b.id));
    const dry = await setSiteEmailIdentityStrict(db, SITE_STRICT, true, { dryRun: true });
    expect(dry).toMatchObject({ ok: true, changed: true, dryRun: true });
    const [afterDry] = await db.select({ key: userSites.identityKey }).from(userSites).where(eq(userSites.userId, a.id));
    expect(afterDry?.key).toBeNull();

    expect(await setSiteEmailIdentityStrict(db, SITE_STRICT, true)).toMatchObject({ ok: true, changed: true });
    const [keyed] = await db.select({ key: userSites.identityKey }).from(userSites).where(eq(userSites.userId, a.id));
    expect(keyed?.key).toBe(`dup@${DOMAIN}`);

    expect(await setSiteEmailIdentityStrict(db, SITE_STRICT, false)).toMatchObject({ ok: true, changed: true, current: false });
    const [cleared] = await db.select({ key: userSites.identityKey }).from(userSites).where(eq(userSites.userId, a.id));
    expect(cleared?.key).toBeNull();
  });

  // ── invite ───────────────────────────────────────────────────────────

  it('invite looks the account up case-insensitively (finding 1) and returns public fields only', async () => {
    const existing = await addUser(`casey@${DOMAIN}`, { passwordHash: 'secret-hash' });
    const result = await inviteUserToSite(db, { siteId: SITE_OPEN, email: `Casey@EID-IT.test` });
    if (!result.ok) throw new Error(`expected invite to succeed, got ${result.code}`);
    expect(result.created).toBe(false);
    expect(result.user.id).toBe(existing.id);
    expect(Object.keys(result.user).sort()).toEqual(['email', 'firstName', 'id', 'lastName', 'status']);
    expect(await countEmail(`casey@${DOMAIN}`)).toBe(1);
  });

  it('invite of an alias of a strict-site member is refused without leaving an orphan account', async () => {
    const a = await addUser(`inv@${DOMAIN}`);
    await db.insert(userSites).values({ userId: a.id, siteId: SITE_STRICT });
    const result = await inviteUserToSite(db, { siteId: SITE_STRICT, email: `inv+alias@${DOMAIN}` });
    expect(result).toEqual({ ok: false, code: 'EMAIL_IDENTITY_CONFLICT' });
    expect(await countEmail(`inv+alias@${DOMAIN}`)).toBe(0);
  });

  // ── register / login through the real router ─────────────────────────

  function authApp(siteId: string): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    const cache = new MemoryCacheProvider();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('systemDb', db);
      c.set('siteId', siteId);
      c.set('runtime', { cache } as unknown as AppEnv['Variables']['runtime']);
      c.set('requestId', `req_eid_${Math.random().toString(36).slice(2)}`);
      await next();
    });
    app.route('/auth', authRouter);
    return app;
  }

  function post(app: Hono<AppEnv>, path: string, body: unknown, ip = '203.0.113.79') {
    return app.request(
      path,
      { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) },
      { JWT_SECRET } as AppEnv['Bindings'],
    );
  }

  it('register: an alias refused by a strict site still answers the generic 202 and leaves no orphan user', async () => {
    const app = authApp(SITE_STRICT);
    const first = await post(app, '/auth/register', { email: `reg@${DOMAIN}`, password: PASSWORD });
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    expect(await countEmail(`reg@${DOMAIN}`)).toBe(1);

    const alias = await post(app, '/auth/register', { email: `reg+alias@${DOMAIN}`, password: PASSWORD });
    expect(alias.status).toBe(202);
    expect(await alias.json()).toEqual(firstBody);
    expect(await countEmail(`reg+alias@${DOMAIN}`)).toBe(0);
  });

  it('register under root mode: an alias of an existing account answers 202 and creates nothing', async () => {
    expect((await setInstanceEmailIdentityMode(db, 'root')).ok).toBe(true);
    await addUser('eidit.six@gmail.com');
    const res = await post(authApp(SITE_OPEN), '/auth/register', { email: 'EiditSix+new@googlemail.com', password: PASSWORD });
    expect(res.status).toBe(202);
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.emailRoot, 'eiditsix@gmail.com'));
    expect(rows).toHaveLength(1);
  });

  it('login under root mode: any alias resolves to the account, and lockout is per account row', async () => {
    expect((await setInstanceEmailIdentityMode(db, 'root')).ok).toBe(true);
    const u = await addUser('eidit.seven@gmail.com', { passwordHash: await hashPassword(PASSWORD) });
    await db.insert(userSites).values({ userId: u.id, siteId: SITE_OPEN });
    const app = authApp(SITE_OPEN);

    const ok = await post(app, '/auth/login', { email: 'EiditSeven+anything@googlemail.com', password: PASSWORD });
    expect(ok.status).toBe(200);

    // The threshold comes from whatever `login_security_policy` the shared
    // database holds (another suite may have installed a custom one), so read
    // it instead of assuming the Standard preset's 5. Each attempt uses its own
    // IP so a low `ipMaxFailedAttempts` cannot answer 429 before the user lock.
    const policy = await loadLockoutPolicyFromSettings(db);
    // N failures, each through a different alias, must lock the one row.
    for (let i = 0; i < policy.userMaxFailedAttempts; i += 1) {
      const res = await post(
        app,
        '/auth/login',
        { email: `eidit.seven+try${i}@gmail.com`, password: 'wrong-password' },
        `203.0.113.${100 + i}`,
      );
      expect(res.status).toBe(401);
    }
    const locked = await userRow(u.id);
    expect(locked?.lockedUntil).toBeInstanceOf(Date);
    expect(locked!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // A fresh alias (even with the right password) is blocked by the row lock.
    const blocked = await post(app, '/auth/login', { email: 'eiditseven+fresh@gmail.com', password: PASSWORD }, '203.0.113.200');
    expect(blocked.status).toBe(423);
  }, 120_000);
});
