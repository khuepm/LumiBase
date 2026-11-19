import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, like, sql } from 'drizzle-orm';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { memberNewsletters, members, sites, users, type Database } from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { membersRouter } from '../routes';
import { portalRouter } from '../portal-routes';
import { memberEmailPublicRouter } from '../email-public-routes';
import { createNewsletter } from '../newsletters';
import { signUnsubscribeToken } from '../mailer';
import { MemberService } from '../member-service';
import { MAGIC_TOKEN_PARAM, requestMagicLink, updateMemberSettings } from '../portal';
import { EmailService } from '../../../services/email/email-service';
import type { EmailMessage, EmailTransport } from '../../../services/email/transport';

/**
 * The Portal and member-mail routers over real PostgreSQL, wired the way
 * `index.ts` mounts them (minus the global chain, which is covered by the
 * wiring tripwires). Email goes to an SMTP URL that is never dialled: the
 * magic-link request is checked up to the 202 and the token is minted
 * directly through the service in the session test.
 */

const A = 'site_members_rt_a';
const B = 'site_members_rt_b';
const DOMAIN = 'members-rt.test';
const SECRET = 'members-routes-secret-0123456789abcdef';

describe.skipIf(!hasDbIntegrationUrl)('members routes — DB integration', () => {
  let db: Database;
  const cache = new MemoryCacheProvider();

  function app(siteId: string, auth?: AuthPrincipal) {
    const root = new Hono<AppEnv>();
    root.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', siteId);
      c.set('runtime', { cache } as never);
      if (auth) c.set('auth', auth);
      await next();
    });
    root.route('/api/v1/portal/email', memberEmailPublicRouter);
    root.route('/api/v1/portal', portalRouter);
    root.route('/api/v1/members', membersRouter);
    const env = { JWT_SECRET: SECRET, LUMIBASE_MAIL_ENABLED: 'false' };
    return { request: (path: string, init?: RequestInit) => root.request(path, init, env) };
  }
  const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    db = await connectDbIntegration('members-routes');
  });
  const cleanup = async () => {
    await db.delete(sites).where(sql`${sites.id} IN (${A}, ${B})`);
    await db.delete(users).where(like(users.email, `%@${DOMAIN}`));
  };
  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
  });
  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId: org, id: A, name: 'RT A' },
      { organizationId: org, id: B, name: 'RT B' },
    ]);
  });

  it('answers 404 PORTAL_DISABLED until the site enables the portal', async () => {
    const res = await app(A).request('/api/v1/portal/config?locale=vi');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('PORTAL_DISABLED');
  });

  it('serves the catalog with localized copy and tolerates a malformed locale', async () => {
    await updateMemberSettings(db, A, { portalEnabled: true, signupCopy: { vi: { button: 'Theo dõi' } } });
    await createNewsletter(db, A, { key: 'weekly', name: 'Weekly', status: 'active', audience: 'members', subscribeOnSignup: true, trackOpens: false, trackClicks: false, sortOrder: 0 });
    const res = await app(A).request('/api/v1/portal/config?locale=vi');
    const body = (await res.json()) as { data: { copy: { button: string; placeholder: string }; newsletters: Array<{ key: string }> } };
    expect(body.data.copy).toMatchObject({ button: 'Theo dõi', placeholder: 'ban@example.com' });
    expect(body.data.newsletters.map((n) => n.key)).toEqual(['weekly']);
    const bad = await app(A).request('/api/v1/portal/signup-card?locale=%22%3E%3Cscript%3E');
    expect(bad.status).toBe(200);
    expect(((await bad.json()) as { data: { button: string } }).data.button).toBe('Subscribe');
    // Site B's settings are its own.
    expect((await app(B).request('/api/v1/portal/config')).status).toBe(404);
  });

  it('validates magic-link requests before touching mail', async () => {
    await updateMemberSettings(db, A, { portalEnabled: true, redirectUris: ['https://blog.example.test/in'] });
    expect((await app(A).request('/api/v1/portal/magic-link', post({ email: 'not-an-email' }))).status).toBe(400);
    const evil = await app(A).request('/api/v1/portal/magic-link', post({ email: `x@${DOMAIN}`, redirectUri: 'https://evil.example/' }));
    expect(evil.status).toBe(400);
    expect(((await evil.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('REDIRECT_NOT_ALLOWED');
    // Unknown sign-in: same 202 as a real one, no account created.
    const ghost = await app(A).request('/api/v1/portal/magic-link', post({ email: `ghost@${DOMAIN}`, intent: 'signin' }));
    expect(ghost.status).toBe(202);
    const verify = await app(A).request('/api/v1/portal/magic-link/verify', post({ token: 'nope' }));
    expect(verify.status).toBe(400);
  });

  it('redeems a magic link into a frontend session exactly once', async () => {
    await updateMemberSettings(db, A, { portalEnabled: true, redirectUris: ['https://blog.example.test/in'] });
    const sent: EmailMessage[] = [];
    const transport: EmailTransport = { kind: 'smtp', send: async (m) => (sent.push(m), { ok: true }) };
    await requestMagicLink({ db, siteId: A, emailService: new EmailService(transport, { from: 'n@example.test' }) }, { email: `new@${DOMAIN}`, name: 'New', intent: 'signup' });
    const token = new RegExp(`${MAGIC_TOKEN_PARAM}=([A-Za-z0-9_-]+)`).exec(sent[0]!.text!)![1]!;

    const res = await app(A).request('/api/v1/portal/magic-link/verify', post({ token }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(JSON.stringify(body.data)).toContain('token');
    const [member] = await db.select().from(members).where(and(eq(members.siteId, A), eq(members.emailLower, `new@${DOMAIN}`)));
    expect(member?.userId).toBeTruthy();
    expect((await app(A).request('/api/v1/portal/magic-link/verify', post({ token }))).status).toBe(400);
  });

  it('lets a signed-in member toggle newsletters and leave; refuses staff routes', async () => {
    await updateMemberSettings(db, A, { portalEnabled: true });
    const weekly = await createNewsletter(db, A, { key: 'weekly', name: 'Weekly', status: 'active', audience: 'members', subscribeOnSignup: true, trackOpens: false, trackClicks: false, sortOrder: 0 });
    const [user] = await db.insert(users).values({ email: `reader@${DOMAIN}`, status: 'active' }).returning();
    const service = new MemberService({ db, siteId: A });
    const member = await service.create({ email: `reader@${DOMAIN}`, status: 'free', labels: [] });
    await service.linkUser(member, user!.id);
    const auth: AuthPrincipal = { userId: user!.id, email: user!.email, roles: ['subscriber'], raw: { aud: 'frontend' } } as AuthPrincipal;

    const me = await app(A, auth).request('/api/v1/portal/me');
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { data: { newsletters: Array<{ key: string }>; email: string } };
    expect(meBody.data.newsletters.map((n) => n.key)).toEqual(['weekly']);
    expect(meBody.data).not.toHaveProperty('note');

    const off = await app(A, auth).request('/api/v1/portal/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newsletters: { [weekly.id]: false } }) });
    expect(((await off.json()) as { data: { newsletters: unknown[] } }).data.newsletters).toEqual([]);

    // The same session has no member on site B.
    expect((await app(B, auth).request('/api/v1/portal/me')).status).toBe(404);
    // A subscriber is not a site admin.
    expect((await app(A, auth).request('/api/v1/members')).status).toBe(403);
    // Anonymous /me is 401.
    expect((await app(A).request('/api/v1/portal/me')).status).toBe(401);
  });

  it('GET never unsubscribes; POST unsubscribes only the token’s site, member and newsletter', async () => {
    const weekly = await createNewsletter(db, A, { key: 'weekly', name: 'Weekly', status: 'active', audience: 'members', subscribeOnSignup: true, trackOpens: false, trackClicks: false, sortOrder: 0 });
    const daily = await createNewsletter(db, A, { key: 'daily', name: 'Daily', status: 'active', audience: 'members', subscribeOnSignup: true, trackOpens: false, trackClicks: false, sortOrder: 1 });
    await createNewsletter(db, B, { key: 'weekly', name: 'Weekly B', status: 'active', audience: 'members', subscribeOnSignup: true, trackOpens: false, trackClicks: false, sortOrder: 0 });
    const member = await new MemberService({ db, siteId: A }).create({ email: `unsub@${DOMAIN}`, status: 'free', labels: [] });
    const other = await new MemberService({ db, siteId: A }).create({ email: `other@${DOMAIN}`, status: 'free', labels: [] });
    const onB = await new MemberService({ db, siteId: B }).create({ email: `unsub@${DOMAIN}`, status: 'free', labels: [] });
    const subsOf = async (siteId: string, memberId: string) =>
      (await db.select().from(memberNewsletters).where(and(eq(memberNewsletters.siteId, siteId), eq(memberNewsletters.memberId, memberId)))).map((r) => r.newsletterId).sort();
    const before = { member: await subsOf(A, member.id), other: await subsOf(A, other.id), onB: await subsOf(B, onB.id) };
    expect(before.member).toEqual([daily.id, weekly.id].sort());

    const token = await signUnsubscribeToken({ siteId: A, memberId: member.id, newsletterId: weekly.id }, SECRET);
    const url = `/api/v1/portal/email/unsubscribe?token=${encodeURIComponent(token)}`;

    // A scanner / prefetcher GET (repeated) changes nothing and only renders a form.
    for (let i = 0; i < 3; i += 1) {
      const res = await app(A).request(url);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<form method="post"');
      expect(html).not.toContain('You have been unsubscribed');
    }
    expect(await subsOf(A, member.id)).toEqual(before.member);
    expect((await app(A).request('/api/v1/portal/email/unsubscribe?token=forged')).status).toBe(400);

    // RFC 8058 one-click POST — arriving on site B's host: the token, not the request, names the site.
    const res = await app(B).request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    expect(res.status).toBe(200);
    expect(await subsOf(A, member.id)).toEqual([daily.id]);
    expect(await subsOf(A, other.id)).toEqual(before.other);
    expect(await subsOf(B, onB.id)).toEqual(before.onB);
    expect(await db.select().from(members).where(eq(members.id, member.id))).toHaveLength(1);

    // The confirmation form's POST answers with a page.
    const confirmed = await app(A).request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=1' });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.text()).toContain('You have been unsubscribed');
    expect((await app(A).request('/api/v1/portal/email/unsubscribe?token=forged', { method: 'POST', body: 'List-Unsubscribe=One-Click' })).status).toBe(400);

    // Pixel never breaks, click needs a signed URL.
    const pixel = await app(A).request('/api/v1/portal/email/o?t=garbage');
    expect(pixel.headers.get('content-type')).toBe('image/gif');
    expect((await app(A).request('/api/v1/portal/email/c?t=garbage')).status).toBe(400);
  });
});
