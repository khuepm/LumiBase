import type { Context, MiddlewareHandler } from 'hono';
import { USAGE_KINDS } from '@lumibase/contracts/platform';
import type { AppEnv } from '../env';
import { runDetached } from '../lib/detached';
import { isPlatformSeamRegistered } from '../platform/registry';
import { seamContextFor, tenantRefFor } from '../platform/request';
import { recordUsage, runInUsageScope, type UsageScopeSource } from '../platform/usage';
import { apiSurface } from './entitlement';

type AppContext = Context<AppEnv>;

const DELIVER_PREFIX = '/api/v1/deliver/';

/** `/api/v1/deliver/<kind>/:site_id/...` — the site is the segment after the kind. */
function deliverySiteId(path: string): string | null {
  const match = /^\/api\/v1\/deliver\/[^/]+\/([^/]+)/.exec(path);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function requestSiteId(c: AppContext): string | null {
  return c.get('siteId') ?? (c.req.path.startsWith(DELIVER_PREFIX) ? deliverySiteId(c.req.path) : null);
}

function principalKind(c: AppContext): string {
  const auth = c.get('auth');
  if (!auth) return 'anonymous';
  if (auth.apiKeyId) return 'api_key';
  return auth.userId ? 'user' : 'anonymous';
}

function requestSource(c: AppContext): UsageScopeSource {
  return {
    ctx: seamContextFor(c),
    siteId: () => requestSiteId(c),
    // After the response: reuses the tenant memoised by an earlier seam call,
    // otherwise one cached site → organization lookup.
    tenant: (siteId) => tenantRefFor(c, siteId),
  };
}

/**
 * Per-request usage reporting.
 *
 * Registered globally right after `withRuntime()`, so it wraps the public
 * delivery routes and the authenticated chain alike. With no usage emitter
 * registered it is a bare pass-through.
 *
 * With one registered it opens a usage scope around the request, records one
 * `api.request` or `delivery.request` event once the response is decided, and
 * hands the scope's drain — tenant attribution, `emit`, `flush` — to
 * `waitUntil` (Workers) or lets it run on its own (Node). The response is
 * never held for any of it.
 *
 * Requests that cannot be attributed (no site and no organization: health
 * checks, static assets, sign-in pages) produce no event. CORS preflights are
 * not counted.
 */
export function withUsage(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!isPlatformSeamRegistered('usage')) return next();
    const started = performance.now();
    await runInUsageScope(
      requestSource(c),
      async () => {
        await next();
        if (c.req.method === 'OPTIONS') return;
        const path = c.req.path;
        const delivery = path.startsWith(DELIVER_PREFIX);
        recordUsage({
          kind: delivery ? USAGE_KINDS.deliveryRequest : USAGE_KINDS.apiRequest,
          quantity: 1,
          unit: 'count',
          attributes: {
            surface: delivery ? 'delivery' : apiSurface(c),
            method: c.req.method,
            status: `${Math.floor(c.res.status / 100)}xx`,
            principal: principalKind(c),
            durationMs: Math.round(performance.now() - started),
          },
        });
      },
      (drain) => runDetached(c, drain),
    );
  };
}
