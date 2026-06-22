import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { ConfigExportService } from '../services/config-export-service';
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

configRouter.get('/export', async (c) => {
  const scope = parseScope(new URL(c.req.url).searchParams.get('scope'));
  const manifest = await new ConfigExportService({
    db: c.get('db'),
    siteId: c.get('siteId'),
  }).export({ scope, exportedAt: new Date().toISOString() });
  return c.json({ data: manifest });
});
