import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { AuditLogger } from '../modules/audit/logger';
import {
  SuppressionService,
  verifyUnsubscribeToken,
} from '../modules/email/suppression';

/**
 * `emailPublicRouter` — UNAUTHENTICATED unsubscribe surface (CAN-SPAM).
 * Mounted at `/api/v1/email` on the top-level app (before the authenticated
 * `api` sub-app) so the opaque token in the link resolves the site without a
 * session. Only `/unsubscribe` is defined here; every other `/email/*` path
 * falls through to the authenticated `emailRouter`.
 *
 * - `GET /unsubscribe?token=…`  — human click; suppresses + returns an HTML
 *   confirmation page.
 * - `POST /unsubscribe`         — RFC 8058 one-click (List-Unsubscribe-Post);
 *   suppresses + returns 200 with no body.
 */
export const emailPublicRouter = new Hono<AppEnv>();

function htmlPage(title: string, message: string, status: 200 | 400): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${title}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">`
    + `<h1 style="font-size:1.25rem">${title}</h1><p>${message}</p></body></html>`;
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function processUnsubscribe(
  c: import('hono').Context<AppEnv>,
  token: string | undefined,
): Promise<{ ok: boolean; siteId?: string }> {
  if (!token) return { ok: false };
  const secret = c.env.JWT_SECRET || process.env.JWT_SECRET;
  if (!secret) return { ok: false };

  const claims = await verifyUnsubscribeToken(token, secret);
  if (!claims) return { ok: false };

  const service = new SuppressionService({ db: c.get('db') });
  const { alreadySuppressed } = await service.suppress({
    siteId: claims.siteId,
    email: claims.email,
    reason: 'unsubscribe',
    source: 'one_click',
  });

  if (!alreadySuppressed) {
    await new AuditLogger({ db: c.get('db'), siteId: claims.siteId }).write({
      event: 'email_unsubscribed',
      targetEmail: claims.email,
      ip: c.get('ip') ?? null,
      userAgent: c.get('userAgent') ?? null,
      requestId: c.get('requestId') ?? null,
      metadata: { source: 'one_click' },
    });
  }

  return { ok: true, siteId: claims.siteId };
}

emailPublicRouter.get('/unsubscribe', async (c) => {
  const { ok } = await processUnsubscribe(c, c.req.query('token'));
  if (!ok) {
    return htmlPage(
      'Unsubscribe link invalid',
      'This unsubscribe link is invalid or has expired. Please use the link from a recent email.',
      400,
    );
  }
  return htmlPage(
    'You have been unsubscribed',
    'You will no longer receive marketing emails. You can re-subscribe at any time from your account settings.',
    200,
  );
});

// RFC 8058 one-click. Mail clients POST here without user interaction.
emailPublicRouter.post('/unsubscribe', async (c) => {
  // The token may arrive in the query string or as a form field.
  let token = c.req.query('token');
  if (!token) {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const fromForm = form['token'];
    if (typeof fromForm === 'string') token = fromForm;
  }
  const { ok } = await processUnsubscribe(c, token);
  return c.body(null, ok ? 200 : 400);
});
