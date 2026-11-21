/**
 * Member Portal API (`/api/v1/portal/*`, epic #672 N01/N02).
 *
 * Public (no session; listed in {@link isPortalPublicPath} so `withAuth`
 * lets them through — each is safe with `auth === undefined`):
 *   GET  /config?locale=        catalog (newsletters, tiers) + localized copy
 *   GET  /signup-card?locale=   resolved signup-card copy (N05)
 *   POST /magic-link            request a sign-up / sign-in link (202, anti-enumeration, per-IP + per-email brakes)
 *   POST /magic-link/verify     redeem a link → `frontend` session (subscriber realm)
 *
 * Member session (`frontend` audience; staff sessions are refused because a
 * staff account has no member profile):
 *   GET/PATCH/DELETE /me        profile, newsletter toggles, unsubscribe-all, leave
 *   POST             /me/tier   free-tier switch, or a checkout URL from the payment hook
 *
 * Every path is 404 `PORTAL_DISABLED` until the site turns the portal on.
 */

import { Hono, type Context } from 'hono';
import { resolveSignupCopy } from '@lumibase/contracts/members';
import type { AppEnv } from '../../env';
import { checkAuthFlowRate } from '../auth/registration-guard';
import { AuditLogger } from '../audit/logger';
import { extractClientIp } from '../login-guard/ip-extract';
import { completePasswordLoginSession } from '../../services/auth/login-session';
import { TOKEN_AUDIENCE } from '../../services/auth/token-audience';
import { EmailService } from '../../services/email/email-service';
import { bumpPermissionVersion } from '../../services/permission-invalidation';
import { MemberError, memberErrorResponse } from './errors';
import {
  getMemberSettings,
  magicLinkRequestSchema,
  memberForUser,
  portalUpdateSchema,
  portalView,
  publicCatalog,
  requestMagicLink,
  switchTier,
  tierSwitchSchema,
  verifyMagicLink,
} from './portal';

export { PORTAL_PREFIX, isPortalPublicPath } from './portal-paths';

/** Per-IP brake on link requests (scripted signup floods, mail bombing). */
const MAGIC_LINK_RATE = { maxPerWindow: 10, windowSeconds: 600 } as const;
const VERIFY_RATE = { maxPerWindow: 30, windowSeconds: 600 } as const;

export const portalRouter = new Hono<AppEnv>();

function h(fn: (c: Context<AppEnv>) => Promise<Response>) {
  return async (c: Context<AppEnv>) => {
    try {
      return await fn(c);
    } catch (err) {
      return memberErrorResponse(c, err);
    }
  };
}

function deps(c: Context<AppEnv>) {
  return { db: c.get('db'), siteId: c.get('siteId'), queue: c.get('runtime')?.queue };
}

function requireMemberSession(c: Context<AppEnv>): string {
  const auth = c.get('auth');
  if (!auth?.userId || auth.type === 'api_key' || auth.type === 'anonymous') {
    throw new MemberError('UNAUTHENTICATED', 401, 'Sign in with your member link first.');
  }
  return auth.userId;
}

async function limited(c: Context<AppEnv>, scope: string, limit: { maxPerWindow: number; windowSeconds: number }): Promise<Response | null> {
  const verdict = await checkAuthFlowRate(c.get('runtime'), scope, c.get('siteId'), extractClientIp(c), limit);
  if (verdict.allowed) return null;
  return c.json(
    { errors: [{ code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.', retryAfterSeconds: verdict.retryAfterSeconds }] },
    429,
    { 'retry-after': String(verdict.retryAfterSeconds) },
  );
}

function audit(c: Context<AppEnv>, event: string, metadata: Record<string, unknown>, email: string | null) {
  return new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event,
    actorEmail: email,
    ip: extractClientIp(c) ?? null,
    userAgent: c.req.header('user-agent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata,
  });
}

// ── Public ────────────────────────────────────────────────────────────────

portalRouter.get(
  '/config',
  h(async (c) => {
    const catalog = await publicCatalog(c.get('db'), c.get('siteId'));
    const copy = resolveSignupCopy(c.req.query('locale'), catalog.copy);
    return c.json({ data: { allowSelfSignup: catalog.allowSelfSignup, newsletters: catalog.newsletters, tiers: catalog.tiers, copy } });
  }),
);

portalRouter.get(
  '/signup-card',
  h(async (c) => {
    const settings = await getMemberSettings(c.get('db'), c.get('siteId'));
    if (!settings.portalEnabled) throw new MemberError('PORTAL_DISABLED', 404, 'The member portal is not enabled for this site.');
    return c.json({ data: resolveSignupCopy(c.req.query('locale'), settings.signupCopy) });
  }),
);

portalRouter.post(
  '/magic-link',
  h(async (c) => {
    const blocked = await limited(c, 'member-link', MAGIC_LINK_RATE);
    if (blocked) return blocked;
    const input = magicLinkRequestSchema.parse(await c.req.json().catch(() => ({})));
    const outcome = await requestMagicLink({ ...deps(c), emailService: EmailService.fromEnv(c.env) }, input);
    if (outcome === 'sent') await audit(c, 'member_magic_link_sent', { intent: input.intent }, input.email);
    // Same answer for every outcome but a misconfigured runtime.
    if (outcome === 'not_configured') {
      return c.json({ errors: [{ code: 'EMAIL_NOT_CONFIGURED', message: 'Email is not configured for this site.' }] }, 503);
    }
    return c.json({ data: { status: 'pending', message: 'If this address can sign in, a link is on its way.' } }, 202);
  }),
);

portalRouter.post(
  '/magic-link/verify',
  h(async (c) => {
    const blocked = await limited(c, 'member-verify', VERIFY_RATE);
    if (blocked) return blocked;
    const { token } = (await c.req.json().catch(() => ({}))) as { token?: unknown };
    const result = await verifyMagicLink({ ...deps(c), emailService: null }, typeof token === 'string' ? token : '');
    if (result.accessChanged) await bumpPermissionVersion(c);
    if (!result.user) {
      await audit(c, 'member_session_refused', { memberId: result.memberId, reason: result.sessionRefused }, null);
      return c.json(
        { errors: [{ code: 'PASSWORD_LOGIN_REQUIRED', message: 'This email belongs to a team account; sign in with your password instead.' }] },
        409,
      );
    }
    await audit(c, result.created ? 'member_signed_up' : 'member_signed_in', { memberId: result.memberId, userId: result.user.id }, result.user.email);
    return completePasswordLoginSession(c, {
      user: result.user,
      siteId: c.get('siteId'),
      audience: TOKEN_AUDIENCE.frontend,
      amr: ['email'],
    });
  }),
);

// ── Member session ────────────────────────────────────────────────────────

portalRouter.get(
  '/me',
  h(async (c) => {
    const userId = requireMemberSession(c);
    const settings = await getMemberSettings(c.get('db'), c.get('siteId'));
    if (!settings.portalEnabled) throw new MemberError('PORTAL_DISABLED', 404, 'The member portal is not enabled for this site.');
    return c.json({ data: await portalView(deps(c), userId) });
  }),
);

portalRouter.patch(
  '/me',
  h(async (c) => {
    const userId = requireMemberSession(c);
    const input = portalUpdateSchema.parse(await c.req.json().catch(() => ({})));
    const { service, row } = await memberForUser(deps(c), userId);
    if (input.name !== undefined) await service.update(row.id, { name: input.name });
    if (input.unsubscribeAll) {
      await service.unsubscribeAll(row.id, 'portal');
      await audit(c, 'member_unsubscribed', { memberId: row.id, source: 'portal' }, row.email);
    } else if (input.newsletters) {
      for (const [newsletterId, subscribed] of Object.entries(input.newsletters)) {
        await service.setNewsletter(row.id, newsletterId, subscribed);
      }
    }
    return c.json({ data: await portalView(deps(c), userId) });
  }),
);

portalRouter.delete(
  '/me',
  h(async (c) => {
    const userId = requireMemberSession(c);
    const { service, row } = await memberForUser(deps(c), userId);
    const { accessChanged } = await service.delete(row.id);
    if (accessChanged) await bumpPermissionVersion(c);
    await audit(c, 'member_left', { memberId: row.id }, row.email);
    return c.json({ data: null });
  }),
);

portalRouter.post(
  '/me/tier',
  h(async (c) => {
    const userId = requireMemberSession(c);
    const input = tierSwitchSchema.parse(await c.req.json().catch(() => ({})));
    const result = await switchTier(deps(c), userId, input);
    if (result.status === 'switched' && result.accessChanged) await bumpPermissionVersion(c);
    return c.json({ data: result });
  }),
);
