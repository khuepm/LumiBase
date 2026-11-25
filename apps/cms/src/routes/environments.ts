/**
 * Content Environments (#853) — mounted at `/api/v1/environments`.
 *
 *   GET    /                               environments of this (origin) site
 *   POST   /                               fork (202): { key, name, contentScope }
 *   GET    /:key                           detail + originChanged / changedItems
 *   DELETE /:key                           delete the environment's child site
 *   POST   /:key/retry                     resume a failed fork from its cursor
 *   POST   /:key/promote/schema            { dryRun, resolutions?, confirmRiskyChange?, migrationPlans? }
 *   POST   /:key/promote/content           { dryRun, items? }
 *   GET    /:key/merge-runs                applied promotes, newest first
 *
 * Guards, outermost first:
 *   1. `content-environments` release flag (dark): 404 while off, like an
 *      unknown route (Req 14.1).
 *   2. Control-plane guard (path listed in control-plane-access-guard.ts) and
 *      `requireSiteAdmin()` on the request's site — the ORIGIN (Req 5.5, 11.4).
 *   3. Staff users only: an API key, even one with `schema:write`, is refused
 *      on every route (Req 11.5).
 *
 * The request never names a second site: the environment is loaded by
 * `(site_id = request site, key)` inside the service (Req 11.1).
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { formatSafeError } from '@lumibase/contracts/utils';
import type { AppEnv } from '../env';
import { runDetached } from '../lib/detached';
import { systemDbFor } from '../middleware/db';
import { requireSiteAdmin } from '../middleware/site-admin';
import { requireReleaseFlag } from '../modules/release-flags';
import { isFrontendAudience } from '../services/auth/token-audience';
import { EnvironmentError } from '../services/environments/errors';
import { EnvironmentService, toEnvironmentView } from '../services/environments/environment-service';
import { driveFork, type ForkDeps } from '../services/environments/fork';

export const environmentsRouter = new Hono<AppEnv>();

/** Time the creating request spends forking before the minute tick takes over. */
export const FIRST_RUN_BUDGET_MS = 20_000;

/** Staff user only: no API key, no anonymous or frontend-realm principal (Req 11.5). */
export const requireStaffUser = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const auth = c.get('auth');
  if (!auth?.userId || auth.apiKeyId || auth.apiKey || auth.type === 'anonymous' || isFrontendAudience(auth.raw?.aud)) {
    return c.json({ errors: [{ code: 'STAFF_USER_REQUIRED', message: 'Environments are managed by signed-in staff users, not API keys.' }] }, 403);
  }
  return next();
};

environmentsRouter.use('*', requireReleaseFlag('content-environments'));
environmentsRouter.use('*', requireStaffUser());
environmentsRouter.use('*', requireSiteAdmin());

export function forkDepsFor(c: Context<AppEnv>): ForkDeps {
  const runtime = c.get('runtime');
  return {
    db: systemDbFor(c),
    keyProvider: runtime?.keys,
    encryptionKey: c.env?.ENCRYPTION_KEY || (typeof process !== 'undefined' ? process.env.ENCRYPTION_KEY : undefined),
  };
}

export function environmentServiceFor(c: Context<AppEnv>): EnvironmentService {
  return new EnvironmentService({
    db: c.get('db'),
    systemDb: systemDbFor(c),
    siteId: c.get('siteId'),
    userId: c.get('auth')!.userId!,
    cache: c.get('runtime')?.cache,
  });
}

export function environmentError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof EnvironmentError) {
    return c.json({ errors: [{ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }] }, err.status);
  }
  throw err;
}

function validation(c: Context<AppEnv>, error: z.ZodError) {
  return c.json({ errors: error.issues.map((i) => ({ code: 'VALIDATION', message: `${i.path.join('.') || 'body'}: ${i.message}` })) }, 400);
}

const contentScopeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('all') }).strict(),
  z.object({ mode: z.literal('collections'), collections: z.array(z.string().min(1).max(100)).min(1).max(200) }).strict(),
]);

const createSchema = z
  .object({
    key: z.string().min(2).max(40),
    name: z.string().trim().min(1).max(120),
    contentScope: contentScopeSchema.default({ mode: 'none' }),
  })
  .strict();

environmentsRouter.get('/', async (c) => {
  return c.json({ data: await environmentServiceFor(c).list() });
});

environmentsRouter.post('/', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return validation(c, parsed.error);
  try {
    const env = await environmentServiceFor(c).create(parsed.data);
    runDetached(
      c,
      driveFork(forkDepsFor(c), env.id, FIRST_RUN_BUDGET_MS).catch((err) =>
        console.error('[environments] first fork run failed', { environmentId: env.id, err: formatSafeError(err) }),
      ),
    );
    return c.json({ data: toEnvironmentView(env) }, 202);
  } catch (err) {
    return environmentError(c, err);
  }
});

environmentsRouter.get('/:key', async (c) => {
  try {
    return c.json({ data: await environmentServiceFor(c).get(c.req.param('key')) });
  } catch (err) {
    return environmentError(c, err);
  }
});

environmentsRouter.delete('/:key', async (c) => {
  try {
    await environmentServiceFor(c).delete(c.req.param('key'));
    return c.json({ data: null });
  } catch (err) {
    return environmentError(c, err);
  }
});

environmentsRouter.post('/:key/retry', async (c) => {
  try {
    const env = await environmentServiceFor(c).retry(c.req.param('key'));
    runDetached(
      c,
      driveFork(forkDepsFor(c), env.id, FIRST_RUN_BUDGET_MS).catch((err) =>
        console.error('[environments] fork retry failed', { environmentId: env.id, err: formatSafeError(err) }),
      ),
    );
    return c.json({ data: toEnvironmentView(env) }, 202);
  } catch (err) {
    return environmentError(c, err);
  }
});
