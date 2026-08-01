import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  DeploymentTargetCreateSchema,
  DeploymentTargetUpdateSchema,
  DeployTriggerSchema,
} from '@lumibase/contracts';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { DeploymentError, DeploymentService } from '../services/deployment/deployment-service';
import { getProvider } from '../services/deployment/providers';
import { ConfigService } from '../services/config-service';

/**
 * Deployment integrations API (spec: deployment-integrations, design §7).
 *
 * Targets CRUD + manual trigger + deployment list/detail/logs/refresh +
 * inbound provider webhook. Tenant-management surface, so the whole router is
 * behind `requireSiteAdmin` (matching webhooks/extensions); the inbound
 * webhook is mounted separately because it authenticates via provider
 * signature, not a bearer token.
 */

function service(c: Context<AppEnv>): DeploymentService {
  return new DeploymentService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    keys: c.get('runtime').keys,
  });
}

/**
 * Per-site inbound-webhook secret for a provider, stored under the settings key
 * `deployment.webhook.<provider>` (value `{ secret: string }`). Returns '' when
 * not configured, which makes `verifyWebhook` reject every request.
 */
async function webhookSecret(c: Context<AppEnv>, providerKey: string): Promise<string> {
  const config = new ConfigService({ db: c.get('db'), siteId: c.get('siteId') });
  const rows = await config.listSettings();
  const row = rows.find((r) => r.key === `deployment.webhook.${providerKey}`);
  const value = row?.value as { secret?: unknown } | undefined;
  return typeof value?.secret === 'string' ? value.secret : '';
}

function fail(c: Context<AppEnv>, err: unknown) {
  if (err instanceof DeploymentError) {
    const httpStatus = err.code === 'NOT_FOUND' ? 404 : err.code === 'TRIGGER_FAILED' ? 502 : 400;
    return c.json({ errors: [{ code: err.code, message: err.message }] }, httpStatus);
  }
  const message = err instanceof Error ? err.message : 'Unexpected error.';
  return c.json({ errors: [{ code: 'INTERNAL', message }] }, 500);
}

// ── Authenticated admin router ───────────────────────────────────────────────

export const deploymentsRouter = new Hono<AppEnv>();
deploymentsRouter.use('*', requireSiteAdmin());

// Targets ----------------------------------------------------------------------

deploymentsRouter.get('/targets', async (c) => {
  const data = await service(c).listTargets();
  return c.json({ data });
});

deploymentsRouter.post('/targets', async (c) => {
  const parsed = DeploymentTargetCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION', message: parsed.error.message }] }, 400);
  }
  try {
    const data = await service(c).createTarget(parsed.data, c.get('auth')?.email);
    return c.json({ data }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

deploymentsRouter.patch('/targets/:id', async (c) => {
  const parsed = DeploymentTargetUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION', message: parsed.error.message }] }, 400);
  }
  try {
    const data = await service(c).updateTarget(c.req.param('id'), parsed.data, c.get('auth')?.email);
    if (!data) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
    return c.json({ data });
  } catch (err) {
    return fail(c, err);
  }
});

deploymentsRouter.delete('/targets/:id', async (c) => {
  const ok = await service(c).deleteTarget(c.req.param('id'), c.get('auth')?.email);
  if (!ok) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: null });
});

// Trigger ----------------------------------------------------------------------

deploymentsRouter.post('/targets/:id/deploy', async (c) => {
  const parsed = DeployTriggerSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION', message: parsed.error.message }] }, 400);
  }
  try {
    const row = await service(c).trigger(c.req.param('id'), {
      branch: parsed.data.branch,
      reason: parsed.data.reason,
      source: 'manual',
      triggeredBy: c.get('auth')?.userId,
    });
    return c.json({ data: row }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

// Deployments ------------------------------------------------------------------

deploymentsRouter.get('/', async (c) => {
  const data = await service(c).listDeployments({
    targetId: c.req.query('targetId'),
    status: c.req.query('status'),
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
  });
  return c.json({ data });
});

deploymentsRouter.get('/:id', async (c) => {
  const row = await service(c).getDeployment(c.req.param('id'));
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: row });
});

deploymentsRouter.get('/:id/logs', async (c) => {
  try {
    const log = await service(c).fetchLogs(c.req.param('id'));
    return c.json({ data: { log } });
  } catch (err) {
    return fail(c, err);
  }
});

deploymentsRouter.post('/:id/refresh', async (c) => {
  try {
    const row = await service(c).syncDeployment(c.req.param('id'));
    if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
    return c.json({ data: row });
  } catch (err) {
    return fail(c, err);
  }
});

// ── Inbound provider webhook (signature-authenticated) ───────────────────────

export const deploymentsWebhookRouter = new Hono<AppEnv>();

deploymentsWebhookRouter.post('/:provider', async (c) => {
  const providerKey = c.req.param('provider');
  const provider = getProvider(providerKey);
  if (!provider) return c.json({ errors: [{ code: 'UNKNOWN_PROVIDER' }] }, 404);

  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => (headers[k] = v));

  // Secret comes from per-site settings (key `deployment.webhook.<provider>`),
  // NOT from a request header — the provider proves authenticity by signing the
  // body with this shared secret. Absence means inbound webhooks are not
  // configured for this provider, so every request is rejected.
  const secret = await webhookSecret(c, providerKey);
  if (!(await provider.verifyWebhook({ headers, rawBody }, secret))) {
    return c.json({ errors: [{ code: 'INVALID_SIGNATURE' }] }, 401);
  }

  const ref = provider.parseWebhook(rawBody);
  if (!ref) return c.json({ data: null });

  await service(c).applyWebhookRef(ref);
  return c.json({ data: null });
});
