import { Hono, type Context } from 'hono';
import { formatSafeError } from '@lumibase/contracts/utils';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { AuditLogger } from '../modules/audit/logger';
import { permissionServiceForRequest } from '../services/item-service-factory';
import {
  openApiConfigSchema,
  readOpenApiConfig,
  realmAllowed,
  resolveOpenApiRealm,
  writeOpenApiConfig,
} from '../services/openapi/openapi-config';
import { OpenApiService } from '../services/openapi/openapi-service';

/**
 * Live OpenAPI 3.1 document (#745).
 *
 *   GET /api/v1/openapi.json     — the caller's view of the site's content API
 *   GET /api/v1/openapi/config   — site admin: read the switch
 *   PUT /api/v1/openapi/config   — site admin: { enabled, realms }
 *
 * Disabled by default. While disabled — or when the caller's realm is not
 * in `realms` — the document answers with the SAME 404 body as an unknown
 * route (`app.notFound`), so a prober cannot tell the endpoint exists.
 */
export const openApiRouter = new Hono<AppEnv>();

openApiRouter.use('/openapi/config', requireSiteAdmin());

/** Byte-identical to `app.notFound` in `index.ts`. */
const notFound = (c: Context<AppEnv>) =>
  c.json({ errors: [{ code: 'NOT_FOUND', message: 'Route not found.' }] }, 404);

async function weakEtag(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const hex = [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `W/"${hex}"`;
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((candidate) => candidate.trim() === etag || candidate.trim() === '*');
}

openApiRouter.get('/openapi.json', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  try {
    const config = await readOpenApiConfig(db, siteId);
    const realm = resolveOpenApiRealm(c.get('auth'));
    if (!realmAllowed(config, realm)) return notFound(c);

    const bundle = await permissionServiceForRequest(c).bundle();
    const { document, key } = await new OpenApiService({
      db,
      siteId,
      cache: c.get('runtime')?.cache,
    }).documentFor(bundle, realm);

    // The document is per-caller: never let a shared cache hold it.
    c.header('Cache-Control', 'private, no-cache');
    c.header('Vary', 'Authorization, X-Lumi-Site');
    const etag = await weakEtag(key);
    c.header('ETag', etag);
    if (etagMatches(c.req.header('if-none-match'), etag)) return c.body(null, 304);
    return c.json(document);
  } catch (err) {
    console.error('[openapi] generation failed', formatSafeError(err));
    return c.json({ errors: [{ code: 'INTERNAL', message: 'OpenAPI generation failed.' }] }, 500);
  }
});

openApiRouter.get('/openapi/config', async (c) => {
  const config = await readOpenApiConfig(c.get('db'), c.get('siteId'));
  return c.json({ data: config });
});

openApiRouter.put('/openapi/config', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = openApiConfigSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((issue) => ({ code: 'VALIDATION', message: issue.message, path: issue.path })) },
      400,
    );
  }
  const db = c.get('db');
  const siteId = c.get('siteId');
  const before = await readOpenApiConfig(db, siteId);
  const data = await writeOpenApiConfig(db, siteId, parsed.data);
  await new AuditLogger({ db, siteId }).write({
    event: 'openapi_config_updated',
    actorEmail: c.get('auth')?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: { before, after: data },
  });
  return c.json({ data });
});
