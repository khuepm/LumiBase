/**
 * Editorial workflow routes (regulated-content-readiness task 8.3; Req 9).
 *
 *   POST /api/v1/editorial/:collection/:id/submit-review  body `{ assignedTo? }`
 *   POST /api/v1/editorial/:collection/:id/approve        body `{ reason? }`
 *   POST /api/v1/editorial/:collection/:id/reject         body `{ reason? }`
 *
 * Mounted under `withAuth`. Human editorial sign-off only — independent of the
 * AI veto-window (Req 9.5). Errors map EditorialError → `{ errors:[{code}] }`.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { EditorialService, EditorialError } from '../services/editorial-service';

export const editorialRouter = new Hono<AppEnv>();

const submitSchema = z.object({ assignedTo: z.string().min(1).max(128).nullable().optional() });
const decideSchema = z.object({ reason: z.string().max(2000).optional() });

const buildService = (c: Context<AppEnv>) => {
  const auth = c.get('auth');
  return new EditorialService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    userId: auth?.userId ?? null,
    actorEmail: typeof auth?.email === 'string' ? auth.email : null,
  });
};

const toError = (err: unknown) => {
  if (err instanceof EditorialError) {
    return { status: err.status, body: { errors: [{ code: err.code, message: err.message }] } };
  }
  return { status: 500, body: { errors: [{ code: 'INTERNAL', message: 'Unhandled editorial error.' }] } };
};

editorialRouter.post('/:collection/:id/submit-review', async (c) => {
  const parsed = submitSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).submitReview(c.req.param('collection'), c.req.param('id'), parsed.data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

editorialRouter.post('/:collection/:id/approve', async (c) => {
  const parsed = decideSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).approve(c.req.param('collection'), c.req.param('id'), parsed.data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

editorialRouter.post('/:collection/:id/reject', async (c) => {
  const parsed = decideSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).reject(c.req.param('collection'), c.req.param('id'), parsed.data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});
