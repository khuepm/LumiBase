import type { Context, MiddlewareHandler } from 'hono';
import { entitlementDenialBody, type EntitlementSurface } from '@lumibase/contracts/platform';
import type { AppEnv } from '../env';
import { authorizeEntitlement } from '../platform/request';
import { isPlatformSeamRegistered } from '../platform/registry';
import { isMcpPath } from '../services/organization-access';

type AppContext = Context<AppEnv>;

export interface EntitlementOptions {
  /** Dimension passed to the resolver for each request on this mount. */
  dimension: string;
  surface: EntitlementSurface | ((c: AppContext) => EntitlementSurface);
  /** Where the site comes from when `withTenant` did not run (delivery). */
  siteId?: (c: AppContext) => string | null | undefined;
}

/** Surface of a request on the authenticated `/api/v1` chain. */
export function apiSurface(c: AppContext): EntitlementSurface {
  const path = c.req.path;
  if (path === '/api/v1/graphql') return 'graphql';
  if (isMcpPath(path)) return 'mcp';
  return 'rest';
}

/**
 * Per-request entitlement check.
 *
 * With no resolver registered this is a pass-through: no tenant lookup, no
 * cache read, no allocation beyond the call. With one registered, the resolver
 * is asked once per request and a refusal is answered `429` with the shared
 * `LIMIT_EXCEEDED` body — the same response on REST, GraphQL and MCP, because
 * all three sit behind this one mount. A resolver that throws is logged and the
 * request proceeds (see `authorizeEntitlement`).
 */
export function withEntitlement(options: EntitlementOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!isPlatformSeamRegistered('entitlements')) return next();

    let siteId: string | null = null;
    try {
      siteId = options.siteId?.(c) ?? null;
    } catch {
      // A path the site cannot be read from is the route handler's to reject.
    }
    const decision = await authorizeEntitlement(c, {
      dimension: options.dimension,
      surface: typeof options.surface === 'function' ? options.surface(c) : options.surface,
      siteId,
    });
    if (decision.allowed) return next();
    return c.json(entitlementDenialBody(decision), 429);
  };
}
