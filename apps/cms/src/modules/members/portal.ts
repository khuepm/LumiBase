/**
 * Member Portal (#717 self-service API, consumed by the #718 widget).
 *
 * Passwordless sign-up / sign-in by magic link:
 *   1. `requestMagicLink` stores the SHA-256 of a random token and emails a
 *      link to an operator-registered landing URI (exact match — never an
 *      attacker-chosen origin, the same rule social login uses).
 *   2. `verifyMagicLink` consumes the token with ONE conditional UPDATE
 *      (`consumed_at IS NULL AND expires_at > now`), so a link mints at most
 *      one session. It creates (signup) or finds the member, provisions a
 *      passwordless subscriber account when needed, links it, and attaches
 *      the tier policy. The route then mints a `frontend`-audience session.
 *
 * A magic link must not become a way around a password + MFA: if the email
 * belongs to an account that is anything more than a subscriber (staff role
 * on any site, bootstrap admin, or second factor enrolled), the member record
 * is still verified but no session is issued — that account signs in through
 * `/auth/login`.
 *
 * Anti-enumeration: request answers the same 202 whether or not the email is
 * a member, and unknown emails on `signin` get no mail.
 */

import { z } from 'zod';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  memberLoginTokens,
  memberSettings,
  memberTiers,
  newsletters,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { ensureSubscriberRole, SUBSCRIBER_SYSTEM_KEY } from '../../services/auth/frontend-role';
import type { EmailService } from '../../services/email/email-service';
import { emailLookup, isEmailIdentityConflict } from '../email-identity/service';
import { normalizeEmail } from '../login-guard/email-normalize';
import { isAllowedRedirect, validateRedirectUri, withResultParams } from '../social-auth/redirect';
import { MemberError, isUniqueViolation } from './errors';
import { MemberService, type MemberServiceDeps } from './member-service';

export const MAGIC_LINK_TTL_MS = 24 * 60 * 60 * 1000;
/** Links per email per window before requests are silently dropped. */
export const MAGIC_LINK_PER_EMAIL = 5;
const MAGIC_LINK_WINDOW_MS = 15 * 60 * 1000;
export const MAGIC_TOKEN_PARAM = 'lumi_member_token';

// ── Settings ──────────────────────────────────────────────────────────────

const copySchema = z
  .object({
    heading: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    placeholder: z.string().max(120).optional(),
    nameLabel: z.string().max(120).optional(),
    button: z.string().max(80).optional(),
    success: z.string().max(500).optional(),
    error: z.string().max(500).optional(),
  })
  .strict();
export type SignupCopy = z.output<typeof copySchema>;

export const memberSettingsSchema = z.object({
  portalEnabled: z.boolean(),
  allowSelfSignup: z.boolean(),
  redirectUris: z.array(z.string()).max(20),
  defaultNewsletterIds: z.array(z.string()).max(50),
  /** `{ [locale]: copy }` — localized signup-card / Portal strings. */
  signupCopy: z.record(z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/), copySchema),
  senderName: z.string().max(100).nullable(),
});
export type MemberSettingsInput = z.output<typeof memberSettingsSchema>;

export interface MemberSettingsView extends MemberSettingsInput {
  configured: boolean;
}

const DEFAULT_SETTINGS: MemberSettingsInput = {
  portalEnabled: false,
  allowSelfSignup: true,
  redirectUris: [],
  defaultNewsletterIds: [],
  signupCopy: {},
  senderName: null,
};

export async function getMemberSettings(db: Database, siteId: string): Promise<MemberSettingsView> {
  const [row] = await db.select().from(memberSettings).where(eq(memberSettings.siteId, siteId)).limit(1);
  if (!row) return { ...DEFAULT_SETTINGS, configured: false };
  return {
    portalEnabled: row.portalEnabled,
    allowSelfSignup: row.allowSelfSignup,
    redirectUris: Array.isArray(row.redirectUris) ? (row.redirectUris as string[]) : [],
    defaultNewsletterIds: Array.isArray(row.defaultNewsletterIds) ? (row.defaultNewsletterIds as string[]) : [],
    signupCopy: (row.signupCopy ?? {}) as Record<string, SignupCopy>,
    senderName: row.senderName,
    configured: true,
  };
}

export async function updateMemberSettings(db: Database, siteId: string, patch: Partial<MemberSettingsInput>): Promise<MemberSettingsView> {
  if (patch.redirectUris) {
    const normalized: string[] = [];
    for (const raw of patch.redirectUris) {
      const v = validateRedirectUri(raw);
      if (!v.ok) throw new MemberError('VALIDATION', 400, `redirectUris: "${String(raw)}" ${v.reason}.`);
      normalized.push(v.uri);
    }
    patch = { ...patch, redirectUris: [...new Set(normalized)] };
  }
  const current = await getMemberSettings(db, siteId);
  const { configured: _c, ...base } = current;
  const next = { ...base, ...patch };
  await db
    .insert(memberSettings)
    .values({ siteId, ...next })
    .onConflictDoUpdate({ target: memberSettings.siteId, set: { ...next, updatedAt: new Date() } });
  return { ...next, configured: true };
}

// ── Tokens ────────────────────────────────────────────────────────────────

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

export function newMagicToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

// ── Request ───────────────────────────────────────────────────────────────

export const magicLinkRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  name: z.string().trim().max(200).optional(),
  /** Newsletter keys or ids to subscribe on signup; omitted = site defaults. */
  newsletters: z.array(z.string().min(1).max(64)).max(20).optional(),
  redirectUri: z.string().max(2000).optional(),
  intent: z.enum(['signup', 'signin']).default('signup'),
  locale: z.string().max(20).optional(),
});
export type MagicLinkRequest = z.output<typeof magicLinkRequestSchema>;

export interface PortalDeps extends MemberServiceDeps {
  emailService: EmailService | null;
}

async function requirePortal(db: Database, siteId: string): Promise<MemberSettingsView> {
  const settings = await getMemberSettings(db, siteId);
  if (!settings.portalEnabled) throw new MemberError('PORTAL_DISABLED', 404, 'The member portal is not enabled for this site.');
  return settings;
}

/** Newsletter keys/ids → ids of active newsletters on this site. */
async function resolveNewsletterRefs(db: Database, siteId: string, refs: readonly string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const rows = await db
    .select({ id: newsletters.id, key: newsletters.key })
    .from(newsletters)
    .where(and(eq(newsletters.siteId, siteId), eq(newsletters.status, 'active')));
  return rows.filter((r) => refs.includes(r.id) || refs.includes(r.key)).map((r) => r.id);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type MagicLinkOutcome = 'sent' | 'skipped' | 'throttled' | 'not_configured';

export async function requestMagicLink(deps: PortalDeps, input: MagicLinkRequest, now = new Date()): Promise<MagicLinkOutcome> {
  const { db, siteId } = deps;
  const settings = await requirePortal(db, siteId);
  const redirectUri = input.redirectUri ?? settings.redirectUris[0];
  if (!redirectUri || !isAllowedRedirect(redirectUri, settings.redirectUris)) {
    throw new MemberError('REDIRECT_NOT_ALLOWED', 400, 'redirectUri is not registered for this site.');
  }
  const emailLower = normalizeEmail(input.email);
  const service = new MemberService(deps);
  const member = await service.findByEmail(emailLower);
  let purpose: 'signup' | 'signin' = member ? 'signin' : 'signup';
  if (!member && (input.intent === 'signin' || !settings.allowSelfSignup)) return 'skipped';

  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(memberLoginTokens)
    .where(
      and(
        eq(memberLoginTokens.siteId, siteId),
        eq(memberLoginTokens.emailLower, emailLower),
        gt(memberLoginTokens.createdAt, new Date(now.getTime() - MAGIC_LINK_WINDOW_MS)),
      ),
    );
  if ((recent?.n ?? 0) >= MAGIC_LINK_PER_EMAIL) return 'throttled';
  if (!deps.emailService) return 'not_configured';

  const newsletterIds = input.newsletters ? await resolveNewsletterRefs(db, siteId, input.newsletters) : undefined;
  const token = newMagicToken();
  await db.insert(memberLoginTokens).values({
    siteId,
    tokenHash: await hashToken(token),
    emailLower,
    purpose,
    payload: { email: input.email, name: input.name ?? null, ...(newsletterIds ? { newsletterIds } : {}) },
    redirectUri,
    expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS),
  });

  const [site] = await db.select({ title: sites.displayTitle, name: sites.name }).from(sites).where(eq(sites.id, siteId)).limit(1);
  const siteName = site?.title ?? site?.name ?? 'our site';
  const link = withResultParams(redirectUri, { [MAGIC_TOKEN_PARAM]: token });
  const verb = purpose === 'signup' ? 'Confirm your subscription' : 'Sign in';
  const result = await deps.emailService.send({
    to: [input.email],
    subject: purpose === 'signup' ? `Confirm your subscription to ${siteName}` : `Your sign-in link for ${siteName}`,
    html: `<p><a href="${escapeHtml(link)}">${verb}</a></p><p>This link works once and expires in 24 hours. If you did not ask for it, ignore this email.</p>`,
    text: `${verb}: ${link}\n\nThis link works once and expires in 24 hours. If you did not ask for it, ignore this email.`,
  });
  return result.ok ? 'sent' : 'not_configured';
}

// ── Verify ────────────────────────────────────────────────────────────────

type UserRow = typeof users.$inferSelect;

export interface VerifyResult {
  memberId: string;
  created: boolean;
  /** Account to mint a session for; null when the account is not subscriber-only. */
  user: UserRow | null;
  sessionRefused?: 'staff_account';
  accessChanged: boolean;
  redirectUri: string | null;
}

/** Subscriber-only = no staff role anywhere, not bootstrap, no second factor. */
async function isSubscriberOnly(db: Database, user: UserRow): Promise<boolean> {
  if (user.isBootstrap) return false;
  const tfa = user.tfa as Record<string, unknown> | null;
  if (tfa && (tfa.enabled === true || tfa.enrolled === true || tfa.verified === true)) return false;
  const memberships = await db
    .select({ systemKey: roles.systemKey })
    .from(userSites)
    .leftJoin(roles, eq(roles.id, userSites.roleId))
    .where(eq(userSites.userId, user.id));
  return memberships.every((m) => m.systemKey === SUBSCRIBER_SYSTEM_KEY);
}

async function ensureSubscriberAccount(db: Database, siteId: string, email: string, name: string | null): Promise<UserRow | null> {
  const emailLower = normalizeEmail(email);
  const where = (await emailLookup(db, emailLower)).where;
  const [existing] = await db.select().from(users).where(where).limit(1);
  const roleId = await ensureSubscriberRole(db, siteId);
  if (existing) {
    if (existing.status !== 'active' && existing.status !== 'invited') return null; // suspended / archived
    if (!(await isSubscriberOnly(db, existing))) return existing; // caller refuses the session
    await db.insert(userSites).values({ userId: existing.id, siteId, roleId }).onConflictDoNothing({ target: [userSites.userId, userSites.siteId] });
    if (existing.status === 'invited') {
      // Clicking the link proves the address, same as /auth/verify-email.
      const [activated] = await db.update(users).set({ status: 'active', updatedAt: new Date() }).where(eq(users.id, existing.id)).returning();
      return activated ?? existing;
    }
    return existing;
  }
  const [first, ...rest] = (name ?? '').trim().split(/\s+/);
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({ email, firstName: first || null, lastName: rest.join(' ') || null, status: 'active' })
        .returning();
      await tx.insert(userSites).values({ userId: created!.id, siteId, roleId });
      return created!;
    });
  } catch (err) {
    if (isUniqueViolation(err) || isEmailIdentityConflict(err)) {
      const [raced] = await db.select().from(users).where(where).limit(1);
      return raced ?? null;
    }
    throw err;
  }
}

export async function verifyMagicLink(deps: PortalDeps, token: string, now = new Date()): Promise<VerifyResult> {
  const { db, siteId } = deps;
  await requirePortal(db, siteId);
  if (!token || token.length > 200) throw new MemberError('MAGIC_LINK_INVALID', 400, 'This link is invalid or has expired.');
  const [consumed] = await db
    .update(memberLoginTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(memberLoginTokens.siteId, siteId),
        eq(memberLoginTokens.tokenHash, await hashToken(token)),
        isNull(memberLoginTokens.consumedAt),
        gt(memberLoginTokens.expiresAt, now),
      ),
    )
    .returning();
  if (!consumed) throw new MemberError('MAGIC_LINK_INVALID', 400, 'This link is invalid, expired or already used.');
  const payload = (consumed.payload ?? {}) as { email?: string; name?: string | null; newsletterIds?: string[] };
  const email = payload.email ?? consumed.emailLower;

  const service = new MemberService(deps);
  let member = await service.findByEmail(consumed.emailLower);
  let created = false;
  if (!member) {
    const settings = await getMemberSettings(db, siteId);
    if (!settings.allowSelfSignup) throw new MemberError('SIGNUP_CLOSED', 403, 'Sign-ups are closed for this site.');
    const defaults = payload.newsletterIds ?? (settings.defaultNewsletterIds.length ? settings.defaultNewsletterIds : undefined);
    try {
      member = await service.create(
        { email, name: payload.name ?? null, status: 'free', labels: [], ...(defaults ? { newsletterIds: defaults } : {}) },
        { source: 'portal', emailVerified: true },
      );
      created = true;
    } catch (err) {
      if (!(err instanceof MemberError && err.code === 'MEMBER_EXISTS')) throw err;
      member = await service.findByEmail(consumed.emailLower);
      if (!member) throw err;
    }
  }

  const user = await ensureSubscriberAccount(db, siteId, email, member.name);
  if (!user) {
    return { memberId: member.id, created, user: null, sessionRefused: 'staff_account', accessChanged: false, redirectUri: consumed.redirectUri };
  }
  if (!(await isSubscriberOnly(db, user))) {
    return { memberId: member.id, created, user: null, sessionRefused: 'staff_account', accessChanged: false, redirectUri: consumed.redirectUri };
  }
  const { accessChanged } = await service.linkUser(member, user.id);
  return { memberId: member.id, created, user, accessChanged, redirectUri: consumed.redirectUri };
}

// ── Self-service ──────────────────────────────────────────────────────────

export const portalUpdateSchema = z.object({
  name: z.string().trim().max(200).nullable().optional(),
  /** `{ newsletterId: subscribed }` toggles. */
  newsletters: z.record(z.string().min(1).max(64), z.boolean()).optional(),
  /** Leave every newsletter and stop every sequence. */
  unsubscribeAll: z.boolean().optional(),
});

export async function memberForUser(deps: MemberServiceDeps, userId: string) {
  const service = new MemberService(deps);
  const row = await service.findByUser(userId);
  if (!row) throw new MemberError('MEMBER_NOT_FOUND', 404, 'No member profile for this account on this site.');
  return { service, row };
}

/** Public, member-facing view: no staff note, no internal ids beyond what the widget needs. */
export async function portalView(deps: MemberServiceDeps, userId: string) {
  const { service, row } = await memberForUser(deps, userId);
  await service.touch(row.id);
  const v = await service.view(row);
  return {
    id: v.id,
    email: v.email,
    name: v.name,
    status: v.status,
    tier: v.tier ? { key: v.tier.key, name: v.tier.name, kind: v.tier.kind } : null,
    tierExpiresAt: v.tierExpiresAt,
    newsletters: v.newsletters,
    createdAt: v.createdAt,
  };
}

export async function publicCatalog(db: Database, siteId: string) {
  const settings = await requirePortal(db, siteId);
  const [nl, tiers] = await Promise.all([
    db
      .select({ id: newsletters.id, key: newsletters.key, name: newsletters.name, description: newsletters.description, audience: newsletters.audience, subscribeOnSignup: newsletters.subscribeOnSignup })
      .from(newsletters)
      .where(and(eq(newsletters.siteId, siteId), eq(newsletters.status, 'active')))
      .orderBy(newsletters.sortOrder),
    db
      .select({
        key: memberTiers.key,
        name: memberTiers.name,
        description: memberTiers.description,
        kind: memberTiers.kind,
        monthlyPriceCents: memberTiers.monthlyPriceCents,
        yearlyPriceCents: memberTiers.yearlyPriceCents,
        currency: memberTiers.currency,
        benefits: memberTiers.benefits,
      })
      .from(memberTiers)
      .where(and(eq(memberTiers.siteId, siteId), eq(memberTiers.active, true)))
      .orderBy(memberTiers.sortOrder),
  ]);
  return { allowSelfSignup: settings.allowSelfSignup, newsletters: nl, tiers, copy: settings.signupCopy };
}

// ── Payment hook (paid tiers) ─────────────────────────────────────────────

export interface CheckoutRequest {
  siteId: string;
  memberId: string;
  email: string;
  tier: { id: string; key: string; externalIds: Record<string, string> };
  interval: 'month' | 'year';
  returnUrl: string;
}

/**
 * Extension point for a payment provider (Stripe in #662): given a paid tier
 * choice, return a hosted checkout URL. The provider's webhook later moves
 * the member to `paid` through `MemberService.update`. Unregistered = paid
 * tier switches answer `402 PAYMENT_PROVIDER_NOT_CONFIGURED`.
 */
export type MembershipCheckoutHook = (req: CheckoutRequest) => Promise<{ checkoutUrl: string }>;

let checkoutHook: MembershipCheckoutHook | null = null;

export function registerMembershipCheckoutHook(hook: MembershipCheckoutHook | null): void {
  checkoutHook = hook;
}

export const tierSwitchSchema = z.object({
  tier: z.string().min(1).max(64),
  interval: z.enum(['month', 'year']).default('month'),
  returnUrl: z.string().max(2000).optional(),
});

export async function switchTier(
  deps: MemberServiceDeps,
  userId: string,
  input: z.output<typeof tierSwitchSchema>,
): Promise<{ status: 'switched'; accessChanged: boolean } | { status: 'checkout'; checkoutUrl: string }> {
  const { service, row } = await memberForUser(deps, userId);
  const [tier] = await deps.db
    .select()
    .from(memberTiers)
    .where(and(eq(memberTiers.siteId, deps.siteId), eq(memberTiers.key, input.tier), eq(memberTiers.active, true)))
    .limit(1);
  if (!tier) throw new MemberError('NOT_FOUND', 404, 'Tier not found.');
  if (tier.kind === 'free') {
    if (row.status === 'comped') throw new MemberError('TIER_MANAGED_BY_STAFF', 409, 'A complimentary membership is managed by the site team.');
    const { accessChanged } = await service.update(row.id, { status: 'free', tierId: tier.id });
    return { status: 'switched', accessChanged };
  }
  if (!checkoutHook) throw new MemberError('PAYMENT_PROVIDER_NOT_CONFIGURED', 402, 'Paid tiers are not available yet.');
  const settings = await getMemberSettings(deps.db, deps.siteId);
  const returnUrl = input.returnUrl ?? settings.redirectUris[0];
  if (!returnUrl || !isAllowedRedirect(returnUrl, settings.redirectUris)) {
    throw new MemberError('REDIRECT_NOT_ALLOWED', 400, 'returnUrl is not registered for this site.');
  }
  const { checkoutUrl } = await checkoutHook({
    siteId: deps.siteId,
    memberId: row.id,
    email: row.email,
    tier: { id: tier.id, key: tier.key, externalIds: (tier.externalIds ?? {}) as Record<string, string> },
    interval: input.interval,
    returnUrl,
  });
  return { status: 'checkout', checkoutUrl };
}
