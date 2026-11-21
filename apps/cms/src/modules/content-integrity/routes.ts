/**
 * `GET /api/v1/admin/security/content-integrity/digest?days=7` (#989) — the
 * "what went live" digest for the active site: items first published in the
 * window (1–31 days, default 7) by account, and the window's
 * `content_integrity_alert` rows by signal. Site admins only, like the
 * security audit log next to it. The policy itself is the `contentIntegrity`
 * site setting, edited through `/api/v1/settings`.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { buildContentDigest } from './digest';

export const contentIntegrityRouter = new Hono<AppEnv>();

contentIntegrityRouter.get('/content-integrity/digest', async (c) => {
  const auth = c.get('auth');
  const roles = Array.isArray(auth?.roles) ? (auth.roles as string[]) : [];
  if (!roles.includes('admin')) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }] }, 403);
  }
  const raw = c.req.query('days');
  const days = raw === undefined ? 7 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 31) {
    return c.json({ errors: [{ code: 'VALIDATION_ERROR', message: '`days` must be an integer from 1 to 31.' }] }, 400);
  }
  const digest = await buildContentDigest({ db: c.get('db'), siteId: c.get('siteId'), days });
  return c.json({ data: digest });
});
