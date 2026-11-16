import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  DeployApprovalDecisionSchema,
  DeploymentEnvironmentsUpdateSchema,
  DeploymentTargetCreateSchema,
  DeploymentTargetUpdateSchema,
  DeployPromoteSchema,
  DeployTriggerSchema,
} from '@lumibase/contracts';
import type { AppEnv } from '../env';
import { scopedDbFor } from '../middleware/db';
import { requireSiteAdmin } from '../middleware/site-admin';
import { withTenant } from '../middleware/tenant';
import { DeploymentError, DeploymentService } from '../services/deployment/deployment-service';
import { getProvider } from '../services/deployment/providers';
import { DeployApprovalStore } from '../services/deployment/deploy-approvals';
import {
  resolveDeployCaller,
  resolveRequesterDeployCapabilities,
} from '../services/deployment/deploy-access';
import {
  canApproveEnvironment,
  canTriggerEnvironment,
  DeploymentEnvironmentStore,
  hasDeployAccess,
} from '../services/deployment/environments';
import { DeploymentReleaseService, type DeployCaller } from '../services/deployment/release-service';
import { AuditLogger } from '../modules/audit/logger';
import { ConfigService } from '../services/config-service';
import { isValidSiteId } from '../services/identifier-guard';

/**
 * Deployment integrations API (spec: deployment-integrations, design §7).
 *
 * Targets CRUD + manual trigger + deployment list/detail/logs/refresh +
 * inbound provider webhook; environments, promotion and deploy approvals
 * (#743). The inbound webhook is mounted separately because it authenticates
 * via provider signature, not a bearer token.
 *
 * Access (#743): configuration (target CRUD, environment map, build logs)
 * stays site-admin only. Everything else needs a `deploy:*` capability — a
 * site admin holds them all — and the trigger/promote/decide endpoints check
 * the specific `deploy:trigger:<scope>` / `deploy:approve:<scope>` grant. A
 * caller with no deploy grant at all gets 403 on every route, as before.
 */

function service(c: Context<AppEnv>, siteId = c.get('siteId')): DeploymentService {
  return new DeploymentService({
    db: scopedDbFor(c, siteId),
    siteId,
    keys: c.get('runtime').keys,
    // Per-target trigger brake (Req 9.5) — distributed limiter from the
    // runtime abstraction, never a Cloudflare binding.
    rateLimiter: c.get('runtime').rateLimiter,
  });
}

/**
 * Per-site inbound-webhook secret for a provider, stored under the settings key
 * `deployment.webhook.<provider>` (value `{ secret: string }`). Returns '' when
 * not configured, which makes `verifyWebhook` reject every request.
 */
async function webhookSecret(
  c: Context<AppEnv>,
  providerKey: string,
  siteId = c.get('siteId'),
): Promise<string> {
  const config = new ConfigService({ db: scopedDbFor(c, siteId), siteId });
  const rows = await config.listSettings();
  const row = rows.find((r) => r.key === `deployment.webhook.${providerKey}`);
  const value = row?.value as { secret?: unknown } | undefined;
  return typeof value?.secret === 'string' ? value.secret : '';
}

const callers = new WeakMap<Context<AppEnv>, Promise<DeployCaller>>();

/** The request's deploy caller, resolved once per request. */
function callerOf(c: Context<AppEnv>): Promise<DeployCaller> {
  let caller = callers.get(c);
  if (!caller) {
    caller = resolveDeployCaller(c);
    callers.set(c, caller);
  }
  return caller;
}

function releaseService(c: Context<AppEnv>): DeploymentReleaseService {
  const siteId = c.get('siteId');
  const db = scopedDbFor(c, siteId);
  return new DeploymentReleaseService({
    deployments: service(c),
    environments: new DeploymentEnvironmentStore({ db, siteId }),
    approvals: new DeployApprovalStore({ db, siteId }),
    audit: (event, metadata, actorEmail) => {
      // Fire-and-forget; AuditLogger.write never throws and masks secrets.
      void new AuditLogger({ db, siteId }).write({
        event,
        actorEmail: actorEmail ?? null,
        requestId: c.get('requestId') ?? null,
        metadata,
      });
    },
  });
}

const ERROR_STATUS: Record<string, 400 | 403 | 404 | 409 | 500 | 502> = {
  NOT_FOUND: 404,
  ENVIRONMENT_NOT_FOUND: 404,
  TRIGGER_FAILED: 502,
  FORBIDDEN: 403,
  HUMAN_APPROVER_REQUIRED: 403,
  SELF_APPROVAL_FORBIDDEN: 403,
  PRINCIPAL_UNRESOLVED: 403,
  NO_TARGETS: 409,
  NO_PROMOTION_TARGET: 409,
  SOURCE_NOT_READY: 409,
  APPROVAL_ALREADY_DECIDED: 409,
  APPROVAL_EXPIRED: 409,
  REQUESTER_REVOKED: 409,
  PLAN_STALE: 409,
  ENVIRONMENTS_INVALID: 500,
};

function fail(c: Context<AppEnv>, err: unknown) {
  if (err instanceof DeploymentError) {
    if (err.code === 'RATE_LIMITED') {
      const retryAfterSeconds = err.retryAfterSeconds ?? 60;
      c.header('Retry-After', String(retryAfterSeconds));
      return c.json(
        { errors: [{ code: err.code, message: err.message, retryAfterSeconds }] },
        429,
      );
    }
    const httpStatus = ERROR_STATUS[err.code] ?? 400;
    return c.json({ errors: [{ code: err.code, message: err.message }] }, httpStatus);
  }
  const message = err instanceof Error ? err.message : 'Unexpected error.';
  return c.json({ errors: [{ code: 'INTERNAL', message }] }, 500);
}

// ── Authenticated admin router ───────────────────────────────────────────────

export const deploymentsRouter = new Hono<AppEnv>();
deploymentsRouter.use('*', async (c, next) => {
  if (!c.get('siteId')) {
    return c.json(
      { errors: [{ code: 'TENANT_REQUIRED', message: 'X-Lumi-Site header is required.' }] },
      400,
    );
  }
  if (!hasDeployAccess((await callerOf(c)).capabilities)) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'Admin access or a deploy grant for the requested site is required.' }] },
      403,
    );
  }
  return next();
});

// Targets ----------------------------------------------------------------------

deploymentsRouter.get('/targets', async (c) => {
  const data = await service(c).listTargets();
  return c.json({ data });
});

deploymentsRouter.post('/targets', requireSiteAdmin(), async (c) => {
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

deploymentsRouter.patch('/targets/:id', requireSiteAdmin(), async (c) => {
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

deploymentsRouter.delete('/targets/:id', requireSiteAdmin(), async (c) => {
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
    // Governed by the environments the target belongs to (#743): a target in
    // an approval-gated environment parks a pending approval (202) instead.
    const outcome = await releaseService(c).requestTargetDeploy(await callerOf(c), c.req.param('id'), {
      branch: parsed.data.branch,
      reason: parsed.data.reason,
    });
    if (outcome.status === 'pending_approval') return c.json({ data: outcome }, 202);
    return c.json({ data: outcome.deployment }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

// Access summary (#743) --------------------------------------------------------

/** What the caller may do, per environment — drives the Studio buttons. */
deploymentsRouter.get('/access', async (c) => {
  try {
    const caller = await callerOf(c);
    const environments = await releaseService(c).listEnvironments();
    return c.json({
      data: {
        admin: caller.capabilities.includes('admin'),
        capabilities: caller.capabilities,
        humanDecider: caller.decider.kind === 'human',
        environments: environments.map((env) => ({
          key: env.key,
          canTrigger: canTriggerEnvironment(caller.capabilities, env),
          canApprove: canApproveEnvironment(caller.capabilities, env.key),
        })),
      },
    });
  } catch (err) {
    return fail(c, err);
  }
});

// Environments (#743) ----------------------------------------------------------

deploymentsRouter.get('/environments', async (c) => {
  try {
    return c.json({ data: await releaseService(c).listEnvironments() });
  } catch (err) {
    return fail(c, err);
  }
});

deploymentsRouter.put('/environments', requireSiteAdmin(), async (c) => {
  const parsed = DeploymentEnvironmentsUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION', message: parsed.error.message }] }, 400);
  }
  try {
    const data = await releaseService(c).updateEnvironments(
      parsed.data.environments,
      c.get('auth')?.email ?? undefined,
    );
    return c.json({ data });
  } catch (err) {
    return fail(c, err);
  }
});

deploymentsRouter.post('/environments/:key/deploy', async (c) => {
  const parsed = DeployTriggerSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION', message: parsed.error.message }] }, 400);
  }
  try {
    const outcome = await releaseService(c).requestEnvironmentDeploy(await callerOf(c), c.req.param('key'), parsed.data);
    return c.json({ data: outcome }, outcome.status === 'pending_approval' ? 202 : 201);
  } catch (err) {
    return fail(c, err);
  }
});

deploymentsRouter.post('/environments/:key/promote', async (c) => {
  const parsed = DeployPromoteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION', message: parsed.error.message }] }, 400);
  }
  try {
    const outcome = await releaseService(c).requestPromotion(await callerOf(c), c.req.param('key'), parsed.data);
    return c.json({ data: outcome }, outcome.status === 'pending_approval' ? 202 : 201);
  } catch (err) {
    return fail(c, err);
  }
});

// Approvals (#743) -------------------------------------------------------------

deploymentsRouter.get('/approvals', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  try {
    const data = await releaseService(c).listApprovals(await callerOf(c), status === 'all' ? undefined : status);
    return c.json({ data });
  } catch (err) {
    return fail(c, err);
  }
});

deploymentsRouter.post('/approvals/:id/decide', async (c) => {
  const parsed = DeployApprovalDecisionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION', message: parsed.error.message }] }, 400);
  }
  try {
    const data = await releaseService(c).decide(
      await callerOf(c),
      c.req.param('id'),
      parsed.data.decision,
      parsed.data.reason,
      (requester) => resolveRequesterDeployCapabilities(c, requester),
    );
    return c.json({ data });
  } catch (err) {
    return fail(c, err);
  }
});

// Deployments ------------------------------------------------------------------

/**
 * `limit` must be a non-negative integer. `0` (empty list) and values above 200
 * (capped by the service) behave as before. Before B162 a non-numeric or
 * negative value reached the query as `NaN`/negative, which drizzle drops, so
 * the list came back unbounded; a fractional value failed the query with 500.
 */
const listLimitSchema = z.coerce.number().int().min(0);

deploymentsRouter.get('/', async (c) => {
  const rawLimit = c.req.query('limit');
  let limit: number | undefined;
  if (rawLimit) {
    const parsed = listLimitSchema.safeParse(rawLimit);
    if (!parsed.success) {
      return c.json(
        { errors: [{ code: 'VALIDATION', message: '`limit` must be a non-negative integer.' }] },
        400,
      );
    }
    limit = parsed.data;
  }
  const data = await service(c).listDeployments({
    targetId: c.req.query('targetId'),
    status: c.req.query('status'),
    limit,
  });
  return c.json({ data });
});

deploymentsRouter.get('/:id', async (c) => {
  const row = await service(c).getDeployment(c.req.param('id'));
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: row });
});

deploymentsRouter.get('/:id/logs', requireSiteAdmin(), async (c) => {
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

async function handleDeploymentWebhook(
  c: Context<AppEnv>,
  siteId: string | undefined,
  fromPath: boolean,
): Promise<Response> {
  const providerKey = c.req.param('provider') ?? '';
  const provider = getProvider(providerKey);
  if (!provider) return c.json({ errors: [{ code: 'UNKNOWN_PROVIDER' }] }, 404);

  if (!siteId || !isValidSiteId(siteId)) {
    return c.json(
      {
        errors: [
          {
            code: 'TENANT_INVALID',
            message: 'siteId path parameter has an invalid format.',
          },
        ],
      },
      400,
    );
  }

  if (fromPath) {
    const headerSite = c.req.header('x-lumi-site');
    if (headerSite) {
      if (!isValidSiteId(headerSite)) {
        return c.json(
          {
            errors: [
              {
                code: 'TENANT_INVALID',
                message: 'X-Lumi-Site header has an invalid format.',
              },
            ],
          },
          400,
        );
      }
      if (headerSite !== siteId) {
        return c.json(
          {
            errors: [
              {
                code: 'TENANT_MISMATCH',
                message: 'X-Lumi-Site header does not match path siteId.',
              },
            ],
          },
          400,
        );
      }
    }
    c.set('siteId', siteId);
  }

  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => (headers[k] = v));

  // Secret comes from per-site settings (key `deployment.webhook.<provider>`),
  // NOT from a request header — the provider proves authenticity by signing the
  // body with this shared secret. Absence means inbound webhooks are not
  // configured for this provider, so every request is rejected.
  const secret = await webhookSecret(c, providerKey, siteId);
  if (!(await provider.verifyWebhook({ headers, rawBody }, secret))) {
    return c.json({ errors: [{ code: 'INVALID_SIGNATURE' }] }, 401);
  }

  const ref = provider.parseWebhook(rawBody);
  if (!ref) return c.json({ data: null });

  await service(c, siteId).applyWebhookRef(ref);
  return c.json({ data: null });
}

deploymentsWebhookRouter.post('/:provider/:siteId', (c) =>
  handleDeploymentWebhook(c, c.req.param('siteId'), true),
);

deploymentsWebhookRouter.post('/:provider', withTenant(), (c) =>
  handleDeploymentWebhook(c, c.get('siteId'), false),
);
