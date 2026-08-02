import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import type { PermissionBundle } from '../services/permission-service';

/**
 * Resolved user row cached on the request after `withAuth` (or downstream
 * membership middleware when mounted standalone in tests).
 *
 * Mirrors the columns `withSiteMembership.resolveUser` needs so later
 * middleware can skip duplicate `users` lookups.
 */
export interface RequestContextUser {
  readonly id: string;
  readonly externalId: string | null;
  readonly email: string;
  readonly isBootstrap: boolean;
}

/** Site membership row for the active tenant, when known. */
export interface RequestContextMembership {
  readonly roleId: string;
}

/**
 * Request_Context_Bundle (high-load-cache-readiness design §6.4).
 *
 * Populated by `withAuth` when user / membership rows are resolved cheaply
 * on the auth path. Downstream guards read this first and only query the
 * database when a field is missing — keeping middleware independently
 * mountable in unit tests.
 */
export interface RequestContextBundle {
  readonly user?: RequestContextUser | null;
  readonly membership?: RequestContextMembership | null;
  readonly accessBundle?: PermissionBundle;
}

declare module '../env' {
  interface Variables {
    /** Cached principal context shared across auth-related middleware. */
    requestContext?: RequestContextBundle;
  }
}

export function getRequestContext(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
): RequestContextBundle {
  return c.get('requestContext') ?? {};
}

export function mergeRequestContext(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  patch: Partial<RequestContextBundle>,
): void {
  const prev = getRequestContext(c);
  c.set('requestContext', { ...prev, ...patch });
}
