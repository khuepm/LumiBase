/** Shared HTTP helpers of the commerce routes (#764). */
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { ItemServiceError } from '../../services/item-service';
import { itemServiceForRequest, itemServiceForSystem } from '../../services/item-service-factory';
import { SchemaService, SchemaServiceError } from '../../services/schema-service';
import { ToolSecretError } from '../../services/tool-secret-service';
import type { SyncDeps } from './sync';
import { COMMERCE_PROVIDERS, CommerceError, type CommerceProviderName } from './types';

type ErrStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502 | 503;
export const fail = (c: Context<AppEnv>, status: ErrStatus, code: string, message: string) => c.json({ errors: [{ code, message }] }, status);

export function providerOf(c: Context<AppEnv>): CommerceProviderName | null {
  const p = c.req.param('provider');
  return (COMMERCE_PROVIDERS as readonly string[]).includes(p ?? '') ? (p as CommerceProviderName) : null;
}

export function handle(c: Context<AppEnv>, err: unknown) {
  if (err instanceof CommerceError) return fail(c, err.status, err.code, err.message);
  if (err instanceof SchemaServiceError) return fail(c, ((err.status as ErrStatus) ?? 400), err.code, err.message);
  if (err instanceof ToolSecretError) return fail(c, 503, err.code, err.message);
  if (err instanceof ItemServiceError) return fail(c, (err.status as ErrStatus) ?? 400, err.code, err.message);
  if (err instanceof z.ZodError) {
    return c.json({ errors: err.issues.map((i) => ({ code: 'VALIDATION', message: `${i.path.join('.') || 'body'}: ${i.message}` })) }, 400);
  }
  throw err;
}

/**
 * Sync dependencies.
 *
 * - `request` (a site admin's full sync): the ItemService carries the admin's
 *   own permission context, like any request path.
 * - `webhook` (a provider callback, no principal): system writes, reason
 *   `commerce-sync`. The signature matched the site's secret and the content
 *   is re-read from the provider; only provider-owned rows are written.
 */
export function syncDeps(
  c: Context<AppEnv>,
  db: AppEnv['Variables']['db'],
  siteId: string,
  provider: CommerceProviderName,
  mode: 'request' | 'webhook',
): Omit<SyncDeps, 'adapter'> {
  const runtime = c.get('runtime');
  const schema = new SchemaService({ db: db as never, siteId, cache: runtime?.cache, queue: runtime?.queue });
  if (mode === 'request') return { schema, items: itemServiceForRequest(c) };
  return {
    schema,
    items: itemServiceForSystem(
      {
        db,
        siteId,
        cdcActor: { type: 'system', id: `commerce:${provider}` },
        cache: runtime?.cache,
        edgeCache: runtime?.edgeCache,
        search: runtime?.search,
        queue: runtime?.queue,
        realtime: runtime?.realtime,
        keyProvider: runtime?.keys,
      },
      'commerce-sync',
    ),
  };
}

export async function json(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}
