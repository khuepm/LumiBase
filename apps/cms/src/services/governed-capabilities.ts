import type { Context } from 'hono';
import type { AppEnv } from '../env';
import type { MagicContext } from './permission-dsl';
import {
  EffectiveCapabilityService,
  principalRefFromAuth,
  type AuthenticatedPrincipalRef,
  type CapabilityDenialCode,
  type EffectiveCapabilityServiceDeps,
} from './effective-capability-service';

/**
 * ONE place every transport resolves agent-tool capabilities (#472).
 *
 * The problem this closes: `withAuth` puts a **role id** in `auth.roles` for a
 * normal user (`role_7fK…`), `[]` for an API key, and the literal string
 * `'admin'` only for a bootstrap or dev principal
 * (`middleware/auth.ts:267-273`, `:384-390`, `:509-515`). Every transport then
 * passed that array straight into `harness.execute(..., auth.roles ?? [])`,
 * where `checkCapabilities` compares it by exact string against requirements
 * like `items:write`. A role id can never match one, so the harness was
 * admin-or-nothing: a site admin holding a real `adminAccess` role — not the
 * bootstrap user — was denied, and an API key was denied everything.
 *
 * Meanwhile REST authorizes through `PermissionService.canAccess()` against the
 * policy DSL. Two transports, two unrelated authorization models. This resolver
 * makes the harness read the same model REST does.
 *
 * What it does NOT do: replace row/field enforcement. Capabilities are the
 * coarse gate; `ItemService` built from `itemServiceForRequest(c)` still applies
 * row rules and field masks. Both layers stay.
 */

export type GovernedCapabilityCode = CapabilityDenialCode | 'PRINCIPAL_UNRESOLVED';

export interface GovernedCapabilityResolution {
  allowed: boolean;
  /** Coarse harness capabilities derived from the live RBAC bundle. */
  capabilities: string[];
  /** Whether this principal may pass a control-plane admin backstop. */
  controlPlaneAdmin: boolean;
  /**
   * Principal-bound context for building a request-equivalent `ItemService` off
   * the request path.
   *
   * Capabilities are the coarse gate; row rules and field masks live in
   * `ItemService` and only apply when it is given a `permissionCtx`. A worker
   * that resolved capabilities but built `ItemService` without this would pass
   * the coarse check and then write with system privileges — the gap is silent,
   * because the capability set looks correct. Present only when `allowed`.
   */
  permissionContext?: MagicContext;
  /** Present when `allowed` is false. */
  code?: GovernedCapabilityCode;
  message?: string;
}

const UNRESOLVED: GovernedCapabilityResolution = {
  allowed: false,
  capabilities: [],
  controlPlaneAdmin: false,
  code: 'PRINCIPAL_UNRESOLVED',
  message: 'The request has no principal that capabilities can be resolved for.',
};

function environmentOf(c: Context<AppEnv>): string | undefined {
  const fromBinding = (c.env as { LUMIBASE_ENV?: string } | undefined)?.LUMIBASE_ENV;
  return fromBinding ?? process.env.LUMIBASE_ENV ?? process.env.NODE_ENV;
}

/**
 * Header snapshot for policy guards (`$HEADERS.*` magic vars, IP/time rules).
 * Only what the DSL can read — not the whole request.
 */
function headerSnapshot(c: Context<AppEnv>): Record<string, string> {
  try {
    return Object.fromEntries(
      Object.entries(c.req.header()).map(([key, value]) => [key.toLowerCase(), String(value)]),
    );
  } catch {
    return {};
  }
}

/** Builds the resolver bound to the current request's tenant and runtime. */
export function effectiveCapabilityServiceForRequest(c: Context<AppEnv>): EffectiveCapabilityService {
  const deps: EffectiveCapabilityServiceDeps = {
    db: c.get('db'),
    siteId: c.get('siteId'),
    headers: headerSnapshot(c),
    ip: c.get('ip') ?? null,
  };
  const cache = c.get('runtime')?.cache;
  if (cache) deps.cache = cache;
  const environment = environmentOf(c);
  if (environment !== undefined) deps.environment = environment;
  return new EffectiveCapabilityService(deps);
}

/**
 * Resolves capabilities for the authenticated principal on this request.
 *
 * Fail-closed: a request whose principal cannot be identified (anonymous, or an
 * incomplete auth shape) resolves to no capabilities rather than falling back to
 * `auth.roles`. Falling back would reintroduce the exact model this replaces.
 */
export async function resolveRequestCapabilities(
  c: Context<AppEnv>,
): Promise<GovernedCapabilityResolution> {
  const principal = principalRefFromAuth(c.get('auth'), c.get('siteId'));
  if (!principal) return UNRESOLVED;
  return resolvePrincipalCapabilities(effectiveCapabilityServiceForRequest(c), principal);
}

/**
 * Fail-closed denial used when resolution itself cannot complete.
 *
 * Resolution reads the database. If that read throws, the caller must not get an
 * exception that turns an authorization question into a 500 — and must certainly
 * not fall back to a permissive default. It gets "no capabilities", which the
 * harness then denies.
 */
const RESOLUTION_FAILED: GovernedCapabilityResolution = {
  allowed: false,
  capabilities: [],
  controlPlaneAdmin: false,
  code: 'PRINCIPAL_UNRESOLVED',
  message: 'Capabilities could not be resolved for this principal.',
};

/**
 * Resolves capabilities for a principal reference that was persisted earlier —
 * a queued run, or an approval being resumed.
 *
 * This is why `AuthenticatedPrincipalRef` carries no capabilities: work that was
 * parked or queued re-reads the current grants when it finally acts, so a role
 * change, a revoked API key or a deactivated user takes effect immediately
 * instead of when the snapshot happens to expire.
 */
export async function resolvePrincipalCapabilities(
  service: EffectiveCapabilityService,
  principal: AuthenticatedPrincipalRef,
): Promise<GovernedCapabilityResolution> {
  let resolution;
  try {
    resolution = await service.resolve(principal);
  } catch (error) {
    console.warn('[governed-capabilities] resolution failed; denying', error);
    return RESOLUTION_FAILED;
  }
  if (!resolution.allowed) {
    return {
      allowed: false,
      capabilities: [],
      controlPlaneAdmin: false,
      code: resolution.code,
      message: resolution.message,
    };
  }
  return {
    allowed: true,
    capabilities: resolution.capabilities,
    controlPlaneAdmin: resolution.controlPlaneAdmin,
    permissionContext: resolution.permissionContext,
  };
}

/** Re-exported so call sites need one import to persist a principal. */
export { principalRefFromAuth };
export type { AuthenticatedPrincipalRef };
