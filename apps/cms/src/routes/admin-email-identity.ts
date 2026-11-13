/**
 * Email identity policy admin surface (#794). Mounted at
 * `/api/v1/admin/email-identity` under `withAuth`.
 *
 *   GET /           → `{ instanceMode, siteStrict, effective }` for the active site
 *   PUT /instance   body `{ mode: 'exact'|'root', dryRun? }` — bootstrap admin only
 *   PUT /site       body `{ strict: boolean, dryRun? }`      — site admin
 *
 * Tightening (`exact → root`, site `strict: false → true`) first checks existing
 * data and answers 409 `IDENTITY_COLLISION` with the colliding accounts when
 * the new key would be violated; nothing changes. Loosening always succeeds.
 * `dryRun: true` runs the same transaction and rolls it back. Every applied
 * change is audit-logged.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { users } from '@lumibase/database';

import type { AppEnv } from '../env';
import { systemDbFor } from '../middleware/db';
import { requireSiteAdmin } from '../middleware/site-admin';
import { AuditLogger } from '../modules/audit/logger';
import { EMAIL_IDENTITY_MODES } from '../modules/email-identity/normalize';
import {
  loadEmailIdentityMode,
  loadSiteEmailIdentityStrict,
  setInstanceEmailIdentityMode,
  setSiteEmailIdentityStrict,
  type PolicyChangeResult,
} from '../modules/email-identity/service';

export const adminEmailIdentityRouter = new Hono<AppEnv>();

const instanceSchema = z.object({ mode: z.enum(EMAIL_IDENTITY_MODES), dryRun: z.boolean().optional() });
const siteSchema = z.object({ strict: z.boolean(), dryRun: z.boolean().optional() });

function validationError(c: Context<AppEnv>, error: z.ZodError) {
  return c.json({ errors: error.issues.map((i) => ({ code: 'VALIDATION', message: i.message, path: i.path })) }, 400);
}

function changeResponse<T>(c: Context<AppEnv>, result: PolicyChangeResult<T>) {
  if (result.ok) {
    return c.json({ data: { previous: result.previous, current: result.current, changed: result.changed, dryRun: result.dryRun } });
  }
  if (result.code === 'NOT_FOUND') return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({
    errors: [{
      code: 'IDENTITY_COLLISION',
      message: 'Existing accounts share a root mailbox; resolve them before tightening the policy.',
      collisions: result.collisions,
    }],
  }, 409);
}

async function audit(c: Context<AppEnv>, event: string, metadata: Record<string, unknown>) {
  const auth = c.get('auth');
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event,
    actorEmail: auth?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata,
  });
}

adminEmailIdentityRouter.get('/', requireSiteAdmin(), async (c) => {
  const db = c.get('db');
  const [instanceMode, siteStrict] = await Promise.all([
    loadEmailIdentityMode(systemDbFor(c)),
    loadSiteEmailIdentityStrict(db, c.get('siteId')),
  ]);
  const effective = instanceMode === 'root' ? 'root' : siteStrict ? 'site_strict' : 'exact';
  return c.json({ data: { instanceMode, siteStrict, effective } });
});

adminEmailIdentityRouter.put('/instance', async (c) => {
  const auth = c.get('auth');
  const systemDb = systemDbFor(c);
  // Instance-wide: only the bootstrap admin (a person, not an API key).
  const [actor] = auth?.userId && !auth.apiKeyId
    ? await systemDb.select({ bootstrap: users.isBootstrap }).from(users).where(eq(users.id, auth.userId)).limit(1)
    : [];
  if (!actor?.bootstrap) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Only the bootstrap admin can change the instance email identity mode.' }] }, 403);
  }
  const parsed = instanceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return validationError(c, parsed.error);

  const result = await setInstanceEmailIdentityMode(systemDb, parsed.data.mode, { dryRun: parsed.data.dryRun });
  if (result.ok && result.changed && !result.dryRun) {
    await audit(c, 'email_identity_mode_changed', { previous: result.previous, current: result.current });
  }
  return changeResponse(c, result);
});

adminEmailIdentityRouter.put('/site', requireSiteAdmin(), async (c) => {
  const parsed = siteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return validationError(c, parsed.error);
  const siteId = c.get('siteId');

  const result = await setSiteEmailIdentityStrict(c.get('db'), siteId, parsed.data.strict, { dryRun: parsed.data.dryRun });
  if (result.ok && result.changed && !result.dryRun) {
    await audit(c, 'site_email_identity_changed', { siteId, previous: result.previous, current: result.current });
  }
  return changeResponse(c, result);
});
