import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, like, sql } from 'drizzle-orm';
import {
  collections,
  emailSuppressions,
  memberNewsletters,
  members,
  newsletterDeliveries,
  roles,
  sequenceEnrollments,
  sites,
  userPolicies,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { EmailService } from '../../../services/email/email-service';
import type { EmailMessage, EmailTransport } from '../../../services/email/transport';
import { PermissionService } from '../../../services/permission-service';
import { ensureSubscriberRole } from '../../../services/auth/frontend-role';
import { MemberService } from '../member-service';
import { MemberMailer, verifyUnsubscribeToken } from '../mailer';
import {
  createNewsletter,
  createSend,
  getSend,
  recordOpen,
  runNewsletterTick,
  toSendView,
} from '../newsletters';
import { MAGIC_TOKEN_PARAM, requestMagicLink, updateMemberSettings, verifyMagicLink } from '../portal';
import { countSegment, createSegment, getSegment, listSegments, parseSegmentFilter } from '../segments';
import {
  completeRotationIfReady,
  checkSendingDomain,
  createSendingDomain,
  dkimRecordValue,
  resolveDkimForSender,
  startRotation,
  DNS_PROPAGATION_GRACE_MS,
  type DnsResolver,
} from '../sending-domains';
import { createSequenceFromTemplate, runSequenceTick, updateSequence } from '../sequences';
import { createTier, ensureFreeTier, grantTierAccess } from '../tiers';
import { mailerFactory } from '../tick';

/**
 * Memberships & newsletters (epic #672) against REAL PostgreSQL, two sites.
 * No mail leaves the process: a capturing transport stands in for SMTP /
 * MailChannels, and DNS is an in-memory resolver.
 */

const A = 'site_members_a';
const B = 'site_members_b';
const EMAIL_DOMAIN = 'members-it.test';
const SECRET = 'members-integration-secret-0123456789';
const LINK_BASE = 'https://cms.example.test';

class CapturingTransport implements EmailTransport {
  readonly kind = 'smtp' as const;
  sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
    return { ok: true } as const;
  }
}

const keys: KeyProvider = {
  getActiveKey: async () => ({ keyId: 'v1', key: Buffer.alloc(32, 7).toString('base64') }),
  getKey: async () => Buffer.alloc(32, 7).toString('base64'),
  listKeys: async () => [],
};

describe.skipIf(!hasDbIntegrationUrl)('members — DB integration', () => {
  let db: Database;
  let transport: CapturingTransport;
  let emailService: EmailService;

  const svc = (siteId = A) => new MemberService({ db, siteId });
  const mailerFor = () => mailerFactory({ db, emailService, secret: SECRET, keys });
  const addr = (local: string) => `${local}@${EMAIL_DOMAIN}`;

  beforeAll(async () => {
    db = await connectDbIntegration('members');
  });
  const cleanup = async () => {
    await db.delete(sites).where(sql`${sites.id} IN (${A}, ${B})`);
    await db.delete(users).where(like(users.email, `%@${EMAIL_DOMAIN}`));
  };
  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
  });
  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId: org, id: A, name: 'Members A' },
      { organizationId: org, id: B, name: 'Members B' },
    ]);
    transport = new CapturingTransport();
    emailService = new EmailService(transport, { from: 'news@example.test' });
  });

  // ── N01 ──────────────────────────────────────────────────────────────────

  describe('members & tiers', () => {
    it('puts free members on the free tier and requires a paid tier for paid/comped', async () => {
      const m = await svc().create({ email: addr('free'), status: 'free', labels: [] });
      const free = await ensureFreeTier(db, A);
      expect(m.tierId).toBe(free.id);
      expect(free.policyId).toBeTruthy();

      await expect(svc().create({ email: addr('comped'), status: 'comped', labels: [] })).rejects.toMatchObject({ code: 'TIER_REQUIRED' });
      await expect(svc().create({ email: addr('comped'), status: 'comped', tierId: free.id, labels: [] })).rejects.toMatchObject({ code: 'TIER_STATUS_MISMATCH' });
      const gold = await createTier(db, A, { key: 'gold', name: 'Gold', kind: 'paid', active: true, benefits: [], externalIds: {}, sortOrder: 1 });
      const comped = await svc().create({ email: addr('comped'), status: 'comped', tierId: gold.id, labels: ['vip'] });
      expect(comped.status).toBe('comped');
      await expect(svc().create({ email: addr('FREE'), status: 'free', labels: [] })).rejects.toMatchObject({ code: 'MEMBER_EXISTS' });
    });

    it('isolates members and tiers per site (same email and tier key on both sites)', async () => {
      await svc(A).create({ email: addr('same'), status: 'free', labels: [] });
      await svc(B).create({ email: addr('same'), status: 'free', labels: [] });
      const goldA = await createTier(db, A, { key: 'gold', name: 'Gold A', kind: 'paid', active: true, benefits: [], externalIds: {}, sortOrder: 0 });
      const goldB = await createTier(db, B, { key: 'gold', name: 'Gold B', kind: 'paid', active: true, benefits: [], externalIds: {}, sortOrder: 0 });
      expect(goldA.policyId).not.toBe(goldB.policyId);
      // Site A cannot put its member on site B's tier.
      const [mA] = await db.select().from(members).where(eq(members.siteId, A));
      await expect(svc(A).update(mA!.id, { status: 'paid', tierId: goldB.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await svc(A).list({})).meta.total).toBe(1);
      expect((await svc(B).list({})).meta.total).toBe(1);
      await expect(svc(B).get(mA!.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('attaches the tier policy to the subscriber account so gated reads follow the tier', async () => {
      const [premium] = await db.insert(collections).values({ siteId: A, name: 'premium_posts' }).returning();
      expect(premium).toBeTruthy();
      const gold = await createTier(db, A, { key: 'gold', name: 'Gold', kind: 'paid', active: true, benefits: [], externalIds: {}, sortOrder: 1 });
      await grantTierAccess(db, A, gold.id, { collection: 'premium_posts' });

      const roleId = await ensureSubscriberRole(db, A);
      const [user] = await db.insert(users).values({ email: addr('reader'), status: 'active' }).returning();
      await db.insert(userSites).values({ userId: user!.id, siteId: A, roleId });
      const member = await svc().create({ email: addr('reader'), status: 'free', labels: [] });
      await svc().linkUser(member, user!.id);

      const canRead = async () => {
        const bundle = await new PermissionService({
          db,
          ctx: { userId: user!.id, siteId: A, roleId, user: { id: user!.id, roles: [roleId] }, ip: null, headers: {}, apiKey: null },
        }).bundle();
        return !!bundle.byKey['premium_posts::read'];
      };
      expect(await canRead()).toBe(false);

      const { accessChanged } = await svc().update(member.id, { status: 'paid', tierId: gold.id });
      expect(accessChanged).toBe(true);
      expect(await canRead()).toBe(true);
      const held = await db.select().from(userPolicies).where(and(eq(userPolicies.userId, user!.id), eq(userPolicies.siteId, A)));
      expect(held.map((h) => h.policyId)).toEqual([gold.policyId]);

      // Expired comp/paid access is not attached.
      await svc().update(member.id, { tierExpiresAt: new Date(Date.now() - 1000).toISOString() });
      expect(await canRead()).toBe(false);

      // Downgrade detaches; delete detaches.
      await svc().update(member.id, { tierExpiresAt: null });
      expect(await canRead()).toBe(true);
      await svc().update(member.id, { status: 'free' });
      expect(await canRead()).toBe(false);
      // Tier policy attachments never leak onto site B.
      expect(await db.select().from(userPolicies).where(eq(userPolicies.siteId, B))).toHaveLength(0);
    });
  });

  // ── N07 ──────────────────────────────────────────────────────────────────

  describe('segments', () => {
    it('counts live as members change, with site-bound sub-selects', async () => {
      const weekly = await createNewsletter(db, A, { key: 'weekly', name: 'Weekly', status: 'active', audience: 'members', subscribeOnSignup: true, trackOpens: false, trackClicks: false, sortOrder: 0 });
      await createNewsletter(db, B, { key: 'weekly', name: 'Weekly B', status: 'active', audience: 'members', subscribeOnSignup: true, trackOpens: false, trackClicks: false, sortOrder: 0 });
      const seg = await createSegment(
        db,
        A,
        { name: 'Engaged VIPs', filter: { match: 'all', conditions: [{ field: 'label', op: 'has', value: 'vip' }, { field: 'newsletter', op: 'subscribed', value: 'weekly' }] } },
        null,
      );
      expect(seg.count).toBe(0);

      await svc(A).create({ email: addr('v1'), status: 'free', labels: ['vip'] }); // auto-subscribed to weekly
      await svc(A).create({ email: addr('v2'), status: 'free', labels: ['vip'], newsletterIds: [] });
      await svc(B).create({ email: addr('v3'), status: 'free', labels: ['vip'] }); // site B: never counted
      expect((await getSegment(db, A, seg.id)).count).toBe(1);

      const v2 = await svc(A).findByEmail(addr('v2'));
      await svc(A).setNewsletter(v2!.id, weekly.id, true);
      expect((await listSegments(db, A))[0]!.count).toBe(2);

      // Relative dates move with the clock.
      const recent = parseSegmentFilter({ conditions: [{ field: 'created_at', op: 'within_days', value: 1 }] });
      expect(await countSegment(db, A, recent)).toBe(2);
      expect(await countSegment(db, A, recent, new Date(Date.now() + 3 * 86_400_000))).toBe(0);
    });

    it('rejects malformed filters', () => {
      expect(() => parseSegmentFilter({ conditions: [{ field: 'status', op: 'in', value: ['gold'] }] })).toThrow();
      expect(() => parseSegmentFilter({ conditions: [{ field: 'nope', op: 'eq', value: 1 }] })).toThrow();
      expect(() => parseSegmentFilter({ conditions: [{ field: 'last_seen_at', op: 'within_days' }] })).toThrow();
    });
  });

  // ── Portal ───────────────────────────────────────────────────────────────

  describe('portal magic link', () => {
    const deps = () => ({ db, siteId: A, emailService });

    beforeEach(async () => {
      await updateMemberSettings(db, A, { portalEnabled: true, redirectUris: ['https://blog.example.test/welcome'] });
    });

    function tokenFromLastMail(): string {
      const msg = transport.sent.at(-1)!;
      const m = new RegExp(`${MAGIC_TOKEN_PARAM}=([A-Za-z0-9_-]+)`).exec(msg.text ?? '');
      return m![1]!;
    }

    it('signs up a visitor once per link and links a subscriber account', async () => {
      expect(await requestMagicLink(deps(), { email: addr('newbie'), name: 'New Bie', intent: 'signup' })).toBe('sent');
      const token = tokenFromLastMail();
      expect(transport.sent.at(-1)!.text).toContain('https://blog.example.test/welcome?');

      const first = await verifyMagicLink(deps(), token);
      expect(first.created).toBe(true);
      expect(first.user?.email).toBe(addr('newbie'));
      const member = await svc().findByEmail(addr('newbie'));
      expect(member?.userId).toBe(first.user!.id);
      expect(member?.source).toBe('portal');

      await expect(verifyMagicLink(deps(), token)).rejects.toMatchObject({ code: 'MAGIC_LINK_INVALID' });
      // The token is site-bound.
      await updateMemberSettings(db, B, { portalEnabled: true, redirectUris: ['https://b.example.test/'] });
      await expect(verifyMagicLink({ db, siteId: B, emailService }, token)).rejects.toMatchObject({ code: 'MAGIC_LINK_INVALID' });
    });

    it('refuses unregistered redirects, is silent for unknown sign-ins, and throttles per email', async () => {
      await expect(requestMagicLink(deps(), { email: addr('x'), intent: 'signup', redirectUri: 'https://evil.example/' })).rejects.toMatchObject({ code: 'REDIRECT_NOT_ALLOWED' });
      expect(await requestMagicLink(deps(), { email: addr('ghost'), intent: 'signin' })).toBe('skipped');
      expect(transport.sent).toHaveLength(0);
      for (let i = 0; i < 5; i += 1) expect(await requestMagicLink(deps(), { email: addr('spam'), intent: 'signup' })).toBe('sent');
      expect(await requestMagicLink(deps(), { email: addr('spam'), intent: 'signup' })).toBe('throttled');
    });

    it('never mints a session for a staff account', async () => {
      const [role] = await db.insert(roles).values({ siteId: A, key: 'editor', name: 'Editor', appAccess: true }).returning();
      const [staff] = await db.insert(users).values({ email: addr('editor'), status: 'active' }).returning();
      await db.insert(userSites).values({ userId: staff!.id, siteId: A, roleId: role!.id });
      await requestMagicLink(deps(), { email: addr('editor'), intent: 'signup' });
      const result = await verifyMagicLink(deps(), tokenFromLastMail());
      expect(result.user).toBeNull();
      expect(result.sessionRefused).toBe('staff_account');
    });

    it('is off until the site enables it', async () => {
      await expect(requestMagicLink({ db, siteId: B, emailService }, { email: addr('b'), intent: 'signup' })).rejects.toMatchObject({ code: 'PORTAL_DISABLED' });
    });
  });

  // ── N03 ──────────────────────────────────────────────────────────────────

  describe('newsletter sends', () => {
    it('sends a 10k-member issue through the tick exactly once each, with RFC 8058 headers', async () => {
      const nl = await createNewsletter(db, A, { key: 'daily', name: 'Daily', status: 'active', audience: 'members', subscribeOnSignup: true, trackOpens: true, trackClicks: false, sortOrder: 0 });
      const free = await ensureFreeTier(db, A);
      const N = 10_000;
      for (let i = 0; i < N; i += 1000) {
        const batch = Array.from({ length: Math.min(1000, N - i) }, (_, j) => {
          const n = i + j;
          return { id: `m${String(n).padStart(6, '0')}`, siteId: A, email: addr(`r${n}`), emailLower: addr(`r${n}`), status: 'free', tierId: free.id, source: 'import' };
        });
        await db.insert(members).values(batch);
        await db.insert(memberNewsletters).values(batch.map((m) => ({ siteId: A, memberId: m.id, newsletterId: nl.id })));
      }
      // One suppressed address and one member on site B never get mail.
      await db.insert(emailSuppressions).values({ siteId: A, emailLower: addr('r42'), reason: 'unsubscribe', source: 'one_click' });
      await svc(B).create({ email: addr('b-only'), status: 'free', labels: [] });

      const send = await createSend(db, A, { newsletterId: nl.id, collection: 'posts', itemId: 'p1', composed: { subject: 'Issue 1', html: '<p>Hello {{member.first_name}}</p>', text: null }, linkBase: LINK_BASE }, null);
      expect(toSendView(send).counters.recipients).toBe(N);
      await expect(
        createSend(db, A, { newsletterId: nl.id, collection: 'posts', itemId: 'p1', composed: { subject: 'again', html: '<p>x</p>', text: null }, linkBase: LINK_BASE }, null),
      ).rejects.toMatchObject({ code: 'ALREADY_SENT' });

      let guard = 0;
      while ((await getSend(db, A, send.id)).status !== 'sent' && guard < 200) {
        await runNewsletterTick({ db, mailerFor: mailerFor(), chunkSize: 500 }, { budgetMs: 60_000 });
        guard += 1;
      }
      const done = toSendView(await getSend(db, A, send.id));
      expect(done.status).toBe('sent');
      expect(done.counters).toMatchObject({ sent: N - 1, skipped: 1, failed: 0 });
      expect(transport.sent).toHaveLength(N - 1);
      expect(new Set(transport.sent.map((m) => m.to[0])).size).toBe(N - 1);
      expect(transport.sent.some((m) => m.to[0] === addr('b-only'))).toBe(false);

      const msg = transport.sent[0]!;
      expect(msg.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      const url = /<([^>]+)>/.exec(msg.headers!['List-Unsubscribe']!)![1]!;
      expect(url.startsWith(`${LINK_BASE}/api/v1/portal/email/unsubscribe?token=`)).toBe(true);
      const claims = await verifyUnsubscribeToken(decodeURIComponent(url.split('token=')[1]!), SECRET);
      expect(claims).toMatchObject({ siteId: A, newsletterId: nl.id });
      expect(msg.html).toContain('/api/v1/portal/email/o?t=');

      // Opens count once per member.
      expect(await recordOpen(db, A, send.id, claims!.memberId)).toBe(true);
      expect(await recordOpen(db, A, send.id, claims!.memberId)).toBe(false);
      expect(toSendView(await getSend(db, A, send.id)).counters.opened).toBe(1);
      const [deliveryCount] = await db.select({ n: sql<number>`count(*)::int` }).from(newsletterDeliveries).where(eq(newsletterDeliveries.sendId, send.id));
      expect(deliveryCount!.n).toBe(N);
    }, 300_000);

    it('narrows the audience by a frozen segment and skips members who unsubscribe mid-send', async () => {
      const nl = await createNewsletter(db, A, { key: 'n', name: 'N', status: 'active', audience: 'members', subscribeOnSignup: true, trackOpens: false, trackClicks: false, sortOrder: 0 });
      const a = await svc().create({ email: addr('seg-a'), status: 'free', labels: ['x'] });
      await svc().create({ email: addr('seg-b'), status: 'free', labels: [] });
      const c = await svc().create({ email: addr('seg-c'), status: 'free', labels: ['x'] });
      const seg = await createSegment(db, A, { name: 'x', filter: { conditions: [{ field: 'label', op: 'has', value: 'x' }] } }, null);
      const send = await createSend(db, A, { newsletterId: nl.id, collection: 'posts', itemId: 'p2', segmentId: seg.id, composed: { subject: 'S', html: '<p>x</p>', text: null }, linkBase: LINK_BASE }, null);
      expect(toSendView(send).counters.recipients).toBe(2);
      await svc().unsubscribeAll(c.id, 'test');
      await runNewsletterTick({ db, mailerFor: mailerFor() }, { budgetMs: 10_000 });
      expect(transport.sent.map((m) => m.to[0])).toEqual([a.email]);
    });

    it('refuses a sender on an unverified domain', async () => {
      const nl = await createNewsletter(db, A, { key: 's', name: 'S', senderEmail: 'news@mail.example.test', status: 'active', audience: 'members', subscribeOnSignup: true, trackOpens: false, trackClicks: false, sortOrder: 0 });
      await expect(
        createSend(db, A, { newsletterId: nl.id, collection: 'posts', itemId: 'p3', composed: { subject: 'S', html: '<p>x</p>', text: null }, linkBase: LINK_BASE }, null),
      ).rejects.toMatchObject({ code: 'SENDER_DOMAIN_UNVERIFIED' });
    });
  });

  // ── N04 ──────────────────────────────────────────────────────────────────

  describe('email sequences', () => {
    it('runs a 3-step welcome over days and stops on unsubscribe', async () => {
      const seq = await createSequenceFromTemplate(db, A, 'welcome', {});
      expect(seq.status).toBe('draft');
      await updateSequence(db, A, seq.id, { status: 'active' });

      const t0 = new Date();
      const m = await new MemberService({ db, siteId: A, now: () => t0 }).create({ email: addr('welcome'), name: 'Wel Come', status: 'free', labels: [] });
      const other = await new MemberService({ db, siteId: A, now: () => t0 }).create({ email: addr('stays'), status: 'free', labels: [] });
      // Site B member is never enrolled into site A's sequence.
      await svc(B).create({ email: addr('welcome-b'), status: 'free', labels: [] });
      expect(await db.select().from(sequenceEnrollments).where(eq(sequenceEnrollments.siteId, B))).toHaveLength(0);

      const tick = (at: Date) => runSequenceTick({ db, mailerFor: mailerFor(), linkBase: LINK_BASE }, { now: at });
      expect((await tick(t0)).sent).toBe(2);
      expect(transport.sent[0]!.subject).toBe('Welcome, Wel!');
      expect((await tick(new Date(t0.getTime() + 86_400_000))).sent).toBe(0);
      expect((await tick(new Date(t0.getTime() + 2 * 86_400_000 + 60_000))).sent).toBe(2);

      await new MemberService({ db, siteId: A }).unsubscribeAll(m.id, 'portal');
      const r = await tick(new Date(t0.getTime() + 8 * 86_400_000));
      expect(r.sent).toBe(1); // only the member who stayed
      const rows = await db.select().from(sequenceEnrollments).where(eq(sequenceEnrollments.siteId, A));
      expect(rows.find((e) => e.memberId === m.id)).toMatchObject({ status: 'stopped', stoppedReason: 'portal' });
      expect(rows.find((e) => e.memberId === other.id)).toMatchObject({ status: 'completed', stepIndex: 3 });
      expect(transport.sent.filter((s) => s.to[0] === addr('welcome'))).toHaveLength(2);
    });
  });

  // ── N06 ──────────────────────────────────────────────────────────────────

  describe('sending domains', () => {
    it('verifies SPF/DKIM/DMARC, signs mail, and rotates DKIM without a gap', async () => {
      const txt = new Map<string, string[]>();
      const resolver: DnsResolver = { resolveTxt: async (name) => txt.get(name) ?? [] };
      const t0 = new Date();
      const row = await createSendingDomain(db, A, keys, 'mail.example.test', t0);
      expect(row.dkimPublicKey.length).toBeGreaterThan(300); // 2048-bit SPKI

      let checked = await checkSendingDomain(db, A, row.id, resolver, 'mailchannels', t0);
      expect(checked.status).toBe('pending');

      txt.set('mail.example.test', ['v=spf1 a mx include:relay.mailchannels.net ~all']);
      txt.set(`${row.dkimSelector}._domainkey.mail.example.test`, [dkimRecordValue(row.dkimPublicKey)]);
      txt.set('_dmarc.mail.example.test', ['v=DMARC1; p=quarantine; adkim=s']);
      await createNewsletter(db, A, { key: 'sub', name: 'Sub', senderEmail: 'hi@news.mail.example.test', status: 'active', audience: 'members', subscribeOnSignup: false, trackOpens: false, trackClicks: false, sortOrder: 0 });
      checked = await checkSendingDomain(db, A, row.id, resolver, 'mailchannels', t0);
      expect(checked.status).toBe('verified');
      const checks = checked.checks as { dmarcAligned?: boolean; misalignedSenders?: string[] };
      expect(checks.dmarcAligned).toBe(false); // strict alignment, subdomain sender
      expect(checks.misalignedSenders).toEqual(['hi@news.mail.example.test']);

      const dkim = await resolveDkimForSender(db, A, keys, 'news@mail.example.test');
      expect(dkim).toMatchObject({ domainName: 'mail.example.test', keySelector: row.dkimSelector });
      expect(dkim!.privateKey).toContain('BEGIN PRIVATE KEY');
      // Site B cannot use site A's domain.
      expect(await resolveDkimForSender(db, B, keys, 'news@mail.example.test')).toBeNull();

      // Rotation: publish next, wait past the grace, switch; old key stays listed.
      const rotating = await startRotation(db, A, row.id, keys, t0);
      expect(rotating.nextSelector).toBeTruthy();
      txt.set(`${rotating.nextSelector}._domainkey.mail.example.test`, [dkimRecordValue(rotating.nextPublicKey!)]);
      const seen = await checkSendingDomain(db, A, row.id, resolver, 'mailchannels', t0);
      expect(await completeRotationIfReady(db, seen, new Date(t0.getTime() + 60_000))).toBeNull();
      const switched = await completeRotationIfReady(db, seen, new Date(t0.getTime() + DNS_PROPAGATION_GRACE_MS + 1000));
      expect(switched?.dkimSelector).toBe(rotating.nextSelector);
      expect(switched?.previousSelector).toBe(row.dkimSelector);
      const signed = await resolveDkimForSender(db, A, keys, 'news@mail.example.test');
      expect(signed?.keySelector).toBe(rotating.nextSelector);

      // The mailer signs with it.
      const member = await svc().create({ email: addr('dkim'), status: 'free', labels: [] });
      const mailer = new MemberMailer({ db, siteId: A, emailService, secret: SECRET, keys });
      expect((await mailer.send({ member, subject: 's', html: '<p>x</p>', from: 'news@mail.example.test', linkBase: LINK_BASE })).status).toBe('sent');
      expect(transport.sent.at(-1)!.dkim?.keySelector).toBe(rotating.nextSelector);
    });
  });
});
