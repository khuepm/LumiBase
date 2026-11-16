/**
 * Public member-mail endpoints (`/api/v1/portal/email/*`, epic #672 N03).
 *
 * Mounted on the top-level app BEFORE the authenticated `api` (like the
 * CAN-SPAM `/email/unsubscribe`): links in mail carry no session and no
 * `X-Lumi-Site` header. The signed token names the site, and the handler
 * scopes its DB handle to that site (`scopedDbFor`, B130).
 *
 *   GET  /unsubscribe?token=  human click → confirmation FORM only (no side effect:
 *                             mail scanners and link prefetchers issue GETs)
 *   POST /unsubscribe?token=  the only mutation: RFC 8058 one-click
 *                             (`List-Unsubscribe=One-Click` → 200, no body) or the
 *                             confirmation form (→ confirmation page)
 *   GET  /o?t=                open pixel (1×1 GIF, no-store) — opt-in per newsletter
 *   GET  /c?t=                click redirect to the SIGNED destination only
 */

import { Hono, type Context } from 'hono';
import type { AppEnv } from '../../env';
import { scopedDbFor } from '../../middleware/db';
import { AuditLogger } from '../audit/logger';
import { MemberService } from './member-service';
import { verifyTrackToken, verifyUnsubscribeToken } from './mailer';
import { recordClick, recordOpen } from './newsletters';

export const memberEmailPublicRouter = new Hono<AppEnv>();

const PIXEL = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (ch) => ch.charCodeAt(0));

function secretOf(c: Context<AppEnv>): string | null {
  return c.env?.JWT_SECRET || process.env.JWT_SECRET || null;
}

function page(title: string, message: string, status: 200 | 400): Response {
  const body =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${title}</title></head>` +
    '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">' +
    `<h1 style="font-size:1.25rem">${title}</h1><p>${message}</p></body></html>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function unsubscribe(c: Context<AppEnv>, token: string | undefined): Promise<boolean> {
  const secret = secretOf(c);
  if (!token || !secret) return false;
  const claims = await verifyUnsubscribeToken(token, secret);
  if (!claims) return false;
  const db = scopedDbFor(c, claims.siteId);
  const service = new MemberService({ db, siteId: claims.siteId, queue: c.get('runtime')?.queue });
  let member;
  try {
    member = await service.getRow(claims.memberId);
  } catch {
    return true; // member already gone: nothing left to unsubscribe from
  }
  if (claims.newsletterId) await service.setNewsletter(member.id, claims.newsletterId, false);
  else await service.unsubscribeAll(member.id, 'one_click');
  await new AuditLogger({ db, siteId: claims.siteId }).write({
    event: 'member_unsubscribed',
    targetEmail: member.email,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: { memberId: member.id, newsletterId: claims.newsletterId ?? null, source: 'one_click' },
  });
  return true;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// GET never mutates: it checks the token and renders a form that POSTs back.
memberEmailPublicRouter.get('/unsubscribe', async (c) => {
  const token = c.req.query('token');
  const secret = secretOf(c);
  const valid = !!token && !!secret && !!(await verifyUnsubscribeToken(token, secret));
  if (!valid) return page('Unsubscribe link invalid', 'This link is invalid. Please use the link from a recent email.', 400);
  const action = `?token=${encodeURIComponent(token!)}`;
  return page(
    'Unsubscribe?',
    'Confirm that you no longer want to receive these emails.' +
      `<form method="post" action="${escapeAttr(action)}" style="margin-top:1rem">` +
      '<input type="hidden" name="confirm" value="1">' +
      '<button type="submit" style="padding:.5rem 1rem">Unsubscribe</button></form>',
    200,
  );
});

memberEmailPublicRouter.post('/unsubscribe', async (c) => {
  const body = await c.req.text().catch(() => '');
  const oneClick = /(^|&)List-Unsubscribe=One-Click(&|$)/.test(body.trim());
  const ok = await unsubscribe(c, c.req.query('token'));
  if (oneClick) {
    return ok ? c.body(null, 200) : c.json({ errors: [{ code: 'INVALID_TOKEN', message: 'Invalid unsubscribe token.' }] }, 400);
  }
  return ok
    ? page('You have been unsubscribed', 'You will no longer receive these emails. You can re-subscribe from your account at any time.', 200)
    : page('Unsubscribe link invalid', 'This link is invalid. Please use the link from a recent email.', 400);
});

memberEmailPublicRouter.get('/o', async (c) => {
  const secret = secretOf(c);
  const t = c.req.query('t');
  if (secret && t) {
    const claims = await verifyTrackToken('open', t, secret);
    if (claims) {
      await recordOpen(scopedDbFor(c, claims.siteId), claims.siteId, claims.sendId, claims.memberId).catch(() => false);
    }
  }
  // Always the pixel: a bad token must not break the rendered email.
  return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, max-age=0' } });
});

memberEmailPublicRouter.get('/c', async (c) => {
  const secret = secretOf(c);
  const t = c.req.query('t');
  const claims = secret && t ? await verifyTrackToken('click', t, secret) : null;
  if (!claims?.url || !/^https?:\/\//i.test(claims.url)) {
    return page('Link expired', 'This link is no longer valid.', 400);
  }
  await recordClick(scopedDbFor(c, claims.siteId), claims.siteId, claims.sendId, claims.memberId).catch(() => false);
  return c.redirect(claims.url, 302);
});
