import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { IntentService, IntentServiceError, intentInputSchema } from '../services/intent-service';
import { createConfiguredLLMProvider } from '../services/llm-provider';

/**
 * Content intent (SLO) API — /api/v1/agent/intents.
 *
 * Reads require an authenticated session (api middleware chain).
 * Mutations require the `intents:write` capability (admin role or an
 * explicit grant), mirroring how the AI chat route derives capabilities.
 */
export const intentsRouter = new Hono<AppEnv>();

const compileSchema = z.object({
  description: z.string().min(1).max(4000),
  collection: z.string().min(1).max(120),
});

function service(c: Context<AppEnv>) {
  return new IntentService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    userId: c.get('auth').userId ?? null,
    llm: createConfiguredLLMProvider(c.env as unknown as Record<string, string | undefined>),
  });
}

function canWriteIntents(c: Context<AppEnv>): boolean {
  const roles = c.get('auth').roles ?? [];
  return roles.includes('admin') || roles.includes('intents:write') || roles.includes('*');
}

function forbidden(c: Context<AppEnv>) {
  return c.json(
    { errors: [{ code: 'FORBIDDEN', message: 'Capability "intents:write" is required.' }] },
    403,
  );
}

function handleError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof IntentServiceError) {
    return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
  }
  if (err instanceof z.ZodError) {
    return c.json(
      {
        errors: err.issues.map((issue) => ({
          code: 'VALIDATION',
          message: issue.message,
          path: issue.path.map(String),
        })),
      },
      400,
    );
  }
  throw err;
}

intentsRouter.get('/', async (c) => {
  const data = await service(c).list();
  return c.json({ data });
});

intentsRouter.get('/:id', async (c) => {
  try {
    const data = await service(c).get(c.req.param('id'));
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});

intentsRouter.post('/', async (c) => {
  if (!canWriteIntents(c)) return forbidden(c);
  const parsed = intentInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return handleError(c, parsed.error);
  try {
    const data = await service(c).create(parsed.data);
    return c.json({ data }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

intentsRouter.patch('/:id', async (c) => {
  if (!canWriteIntents(c)) return forbidden(c);
  const parsed = intentInputSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return handleError(c, parsed.error);
  try {
    const data = await service(c).update(c.req.param('id'), parsed.data);
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});

intentsRouter.delete('/:id', async (c) => {
  if (!canWriteIntents(c)) return forbidden(c);
  try {
    const data = await service(c).remove(c.req.param('id'));
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});

intentsRouter.post('/:id/pause', async (c) => {
  if (!canWriteIntents(c)) return forbidden(c);
  try {
    const data = await service(c).pause(c.req.param('id'));
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});

intentsRouter.post('/:id/resume', async (c) => {
  if (!canWriteIntents(c)) return forbidden(c);
  try {
    const data = await service(c).resume(c.req.param('id'));
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});

/** Open/assigned/resolved drifts detected for an intent. */
intentsRouter.get('/:id/drifts', async (c) => {
  try {
    const { DriftService } = await import('../services/drift-service');
    const drift = new DriftService({ db: c.get('db'), siteId: c.get('siteId') });
    const status = c.req.query('status');
    const data = await drift.listDrifts({
      intentId: c.req.param('id'),
      ...(status ? { status } : {}),
    });
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});

/**
 * Manual reconciliation cycle: drift scan + goal generation. The same cycle
 * runs on schedule via the Flows `drift-scan` operation.
 */
intentsRouter.post('/:id/scan', async (c) => {
  if (!canWriteIntents(c)) return forbidden(c);
  try {
    const { DriftService, DriftServiceError } = await import('../services/drift-service');
    const { ReconcilerService } = await import('../services/reconciler-service');
    const deps = { db: c.get('db'), siteId: c.get('siteId') };
    try {
      const scan = await new DriftService(deps).scanIntent(c.req.param('id'));
      const reconcile = await new ReconcilerService(deps).reconcileIntent(c.req.param('id'));
      return c.json({ data: { scan, reconcile } });
    } catch (err) {
      if (err instanceof DriftServiceError) {
        return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
      }
      throw err;
    }
  } catch (err) {
    return handleError(c, err);
  }
});

/** Compile natural language into rules; returns a draft, never persists. */
intentsRouter.post('/compile', async (c) => {
  if (!canWriteIntents(c)) return forbidden(c);
  const parsed = compileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return handleError(c, parsed.error);
  try {
    const data = await service(c).compile(parsed.data.description, parsed.data.collection);
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});
