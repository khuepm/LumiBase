/**
 * In-app upgrade (#898). Mounted at `/api/v1/system/upgrade` on the
 * authenticated `api` chain and listed as control-plane.
 *
 *   GET  /preflight  current vs target version, minimum safe version, pending
 *                    migrations, migration warning, who runs migrations,
 *                    provider configuration, the latest request
 *   POST /           `{ targetVersion, backupAcknowledged: true, retry? }` —
 *                    asks the configured provider to upgrade
 *   GET  /           the latest request (completed once the target answers)
 *
 * Instance-wide: bootstrap admin only, as a person — never an API key. Every
 * request is audited at instance scope (`system.upgrade_requested`,
 * `system.upgrade_request_failed`).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { systemDbFor } from '../../middleware/db';
import { isBootstrapAdmin } from '../../middleware/bootstrap-admin';
import { resolveBuildMetadata } from '../../routes/system';
import { resolveUpgradeConfig, upgradeEnvFrom } from './config';
import { requestUpgrade, runPreflight, upgradeStatus, type UpgradeDeps } from './service';

type AppContext = Context<AppEnv>;

export const upgradeRouter = new Hono<AppEnv>();

/** Test seam: the releases manifest / hook fetch. */
let fetchOverride: typeof fetch | undefined;
export function setUpgradeFetchForTests(impl: typeof fetch | undefined): void {
  fetchOverride = impl;
}

function deps(c: AppContext): UpgradeDeps {
  return {
    systemDb: systemDbFor(c),
    config: resolveUpgradeConfig(upgradeEnvFrom(c.env)),
    currentVersion: resolveBuildMetadata(c.env).version,
    fetchImpl: fetchOverride,
  };
}

upgradeRouter.use('*', async (c, next) => {
  if (!(await isBootstrapAdmin(c))) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'Only the bootstrap admin can upgrade this instance.' }] },
      403,
    );
  }
  return next();
});

upgradeRouter.get('/preflight', async (c) => c.json({ data: await runPreflight(deps(c)) }));

upgradeRouter.get('/', async (c) => c.json({ data: await upgradeStatus(deps(c)) }));

const requestSchema = z.object({
  targetVersion: z.string().trim().min(1).max(64),
  backupAcknowledged: z.boolean(),
  retry: z.boolean().optional().default(false),
});

upgradeRouter.post('/', async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message, path: i.path.map(String) })),
      },
      400,
    );
  }
  const auth = c.get('auth');
  const outcome = await requestUpgrade(deps(c), parsed.data, {
    userId: auth?.userId ?? null,
    email: auth?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
  });
  if (!outcome.ok) {
    return c.json(
      {
        errors: [{ code: outcome.code, message: outcome.message }],
        ...(outcome.checks || outcome.request
          ? { meta: { ...(outcome.checks ? { checks: outcome.checks } : {}), ...(outcome.request ? { request: outcome.request } : {}) } }
          : {}),
      },
      outcome.status,
    );
  }
  return c.json({ data: outcome.request, meta: { idempotent: outcome.idempotent } }, outcome.idempotent ? 200 : 202);
});
