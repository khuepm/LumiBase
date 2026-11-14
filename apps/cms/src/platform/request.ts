import type { Context } from 'hono';
import type {
  AuthorizeDecision,
  AuthorizeRequest,
  EntitlementSnapshot,
  TenantRef,
} from '@lumibase/contracts/platform';
import { formatSafeError } from '@lumibase/contracts/utils';
import type { RuntimeContext } from '@lumibase/runtime';
import type { AppEnv } from '../env';
import { scopedDbFor } from '../middleware/db';
import { siteOrganizationId } from '../services/domains/site-organization-cache';
import { allowedDecision, unlimitedSnapshot } from './defaults';
import { isPlatformSeamRegistered, platform } from './registry';
import type { CmsSeamContext, PlatformSeamName } from './types';

/**
 * Request-scoped access to the platform seams.
 *
 * Route handlers and services go through these helpers rather than calling
 * `platform()` themselves, so three things hold everywhere:
 *
 *  - the tenant is resolved once per request, lazily, and only when asked for;
 *  - an implementation that throws never fails the request — the failure is
 *    logged and the built-in default answers instead;
 *  - with nothing registered, no helper performs I/O.
 */

type AppContext = Context<AppEnv>;

/** Seam context for the current request. */
export function seamContextFor(c: AppContext): CmsSeamContext {
  return { runtime: c.get('runtime'), requestId: c.get('requestId') ?? null };
}

/** Seam context for work outside a request: cron sweeps and queue consumers. */
export function backgroundSeamContext(runtime: RuntimeContext): CmsSeamContext {
  return { runtime, requestId: null };
}

/** Log a seam failure. The caller then continues on the built-in default. */
export function reportSeamFailure(
  seam: PlatformSeamName,
  operation: string,
  requestId: string | null,
  err: unknown,
): void {
  console.error('[lumibase-cms] platform seam failed; continuing with the built-in default', {
    seam,
    operation,
    requestId,
    err: formatSafeError(err),
  });
}

async function resolveTenant(c: AppContext, siteId: string): Promise<TenantRef> {
  let organizationId: string | null = null;
  try {
    // `scopedDbFor` returns `c.get('db')` unchanged unless RLS is enforced and
    // the handle is scoped to a different site (the delivery path, where the
    // site comes from the URL).
    if (c.get('db')) {
      organizationId = await siteOrganizationId(scopedDbFor(c, siteId), c.get('runtime')?.cache, siteId);
    }
  } catch {
    organizationId = null;
  }
  return { siteId, organizationId };
}

/**
 * The tenant this request is about, with its owning organization.
 *
 * Lazy: the site → organization lookup runs on the first call, goes through the
 * runtime cache, and its result is kept on the context (`tenantRef`) for the
 * rest of the request. Never rejects; an organization that cannot be determined
 * is `null`.
 *
 * @param siteId where the site comes from when `withTenant` did not set it —
 *   the delivery routes carry it in the URL.
 */
export function tenantRefFor(c: AppContext, siteId?: string | null): Promise<TenantRef> {
  const resolvedSiteId = siteId ?? c.get('siteId') ?? null;

  if (!resolvedSiteId) {
    // Organization-plane request. Not memoised: the organization guard runs
    // per route and may verify the organization after an earlier caller asked.
    // Only verified sources are used — never the raw `:orgId` path parameter.
    const apiKey = c.get('auth')?.apiKey;
    const fromKey = apiKey?.scope === 'organization' && typeof apiKey.organizationId === 'string'
      ? apiKey.organizationId
      : null;
    return Promise.resolve({ siteId: null, organizationId: c.get('organization')?.id ?? fromKey });
  }

  const memo = c.get('tenantRef');
  if (memo && memo.siteId === resolvedSiteId) return memo.ref;
  const ref = resolveTenant(c, resolvedSiteId);
  c.set('tenantRef', { siteId: resolvedSiteId, ref });
  return ref;
}

/**
 * The entitlement snapshot for this request's organization, resolved once per
 * request and kept on the context (`entitlements`).
 *
 * With no resolver registered this is the unlimited snapshot and costs no
 * lookup at all — `organizationId` is then `null`; use `tenantRefFor` when the
 * organization itself is needed. A resolver that throws is logged and the
 * unlimited snapshot is returned.
 */
export function entitlementsFor(c: AppContext, siteId?: string | null): Promise<EntitlementSnapshot> {
  const memo = c.get('entitlements');
  if (memo) return memo;
  const snapshot = resolveEntitlements(c, siteId);
  c.set('entitlements', snapshot);
  return snapshot;
}

async function resolveEntitlements(c: AppContext, siteId?: string | null): Promise<EntitlementSnapshot> {
  if (!isPlatformSeamRegistered('entitlements')) return unlimitedSnapshot(null);
  const tenant = await tenantRefFor(c, siteId);
  const ctx = seamContextFor(c);
  try {
    const snapshot = await platform().entitlements.resolve(ctx, tenant.organizationId);
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.limits !== 'object' || snapshot.limits === null) {
      throw new TypeError('EntitlementResolver.resolve returned a malformed snapshot');
    }
    return snapshot;
  } catch (err) {
    reportSeamFailure('entitlements', 'resolve', ctx.requestId, err);
    return unlimitedSnapshot(tenant.organizationId);
  }
}

/**
 * Ask whether one action may proceed. Fails open: a resolver that throws, or
 * answers with something that is not a decision, is logged and the action is
 * allowed. Refusing is the implementation's call, never a side effect of its
 * failure.
 */
export async function authorizeEntitlement(
  c: AppContext,
  request: Omit<AuthorizeRequest, 'tenant'> & { siteId?: string | null },
): Promise<AuthorizeDecision> {
  if (!isPlatformSeamRegistered('entitlements')) return allowedDecision();
  const { siteId, ...rest } = request;
  const tenant = await tenantRefFor(c, siteId);
  const ctx = seamContextFor(c);
  try {
    const decision = await platform().entitlements.authorize(ctx, { ...rest, tenant });
    if (!decision || typeof decision !== 'object' || typeof decision.allowed !== 'boolean') {
      throw new TypeError('EntitlementResolver.authorize returned a malformed decision');
    }
    return decision;
  } catch (err) {
    reportSeamFailure('entitlements', 'authorize', ctx.requestId, err);
    return allowedDecision();
  }
}
