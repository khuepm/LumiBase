import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { AuditLogger } from '../modules/audit/logger';
import { requireSiteAdmin } from '../middleware/site-admin';
import { ConfigExportService } from '../services/config-export-service';
import { ConfigImportService } from '../services/config-import-service';
import type { ApplyMode } from '../services/config-diff';
import type { SerializeOptions } from '../services/config-serialize';

/**
 * Code-First Configuration API. Export / diff / apply a site's schema config
 * (collections, fields, relations, settings, webhooks) as a declarative,
 * version-controllable {@link ConfigManifest}. Admin-only — mirrors the access
 * config router.
 *
 *   GET  /api/v1/config/export?scope=all|schema|settings|webhooks
 *   POST /api/v1/config/import?dryRun=true            → diff only (Phase C)
 *   POST /api/v1/config/import?mode=…&allowDestructive → apply (Phase C)
 */
export const configRouter = new Hono<AppEnv>();

// Every config operation requires admin access for the active tenant.
configRouter.use('*', requireSiteAdmin());

function parseScope(raw: string | null): SerializeOptions['scope'] {
  if (raw === 'schema' || raw === 'settings' || raw === 'webhooks' || raw === 'all') {
    return raw;
  }
  return 'all';
}

function parseMode(raw: string | null): ApplyMode {
  if (raw === 'replace-managed' || raw === 'replace-all') return raw;
  return 'merge';
}

configRouter.get('/export', async (c) => {
  const scope = parseScope(new URL(c.req.url).searchParams.get('scope'));
  const manifest = await new ConfigExportService({
    db: c.get('db'),
    siteId: c.get('siteId'),
  }).export({ scope, exportedAt: new Date().toISOString() });
  return c.json({ data: manifest });
});

configRouter.post('/import', async (c) => {
  const url = new URL(c.req.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';
  const mode = parseMode(url.searchParams.get('mode'));
  const allowDestructive = url.searchParams.get('allowDestructive') === 'true';

  const service = new ConfigImportService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    cache: c.get('runtime')?.cache,
  });

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errors: [{ code: 'INVALID_JSON', message: 'Request body must be valid JSON.' }] }, 400);
  }

  if (dryRun) {
    const result = await service.dryRun(body, mode);
    return c.json({ data: result }, result.valid ? 200 : 422);
  }

  const result = await service.apply(body, mode, { allowDestructive });

  const audit = new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') });
  const base = {
    actorEmail: c.get('auth')?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
  };
  if (result.valid) {
    await audit.write({
      ...base,
      event: 'config_applied',
      metadata: { mode, manifestVersion: 'lumibase.config@v1', counts: result.applied } as Record<string, unknown>,
    });
    return c.json({ data: result }, 200);
  }

  await audit.write({
    ...base,
    event: 'config_apply_failed',
    metadata: { mode, errors: result.errors.map((e) => e.code) } as Record<string, unknown>,
  });
  const status = result.errors.some((e) => e.code === 'DESTRUCTIVE_BLOCKED') ? 409 : 422;
  return c.json({ data: result }, status);
});
