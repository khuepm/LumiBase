/**
 * Platform extension points — contracts.
 *
 * An operator can supply their own policy implementations to the CMS without
 * patching route handlers: a deployment entry registers them once, before the
 * first request, and the CMS consults them at fixed points on the request path.
 * This module holds only the shapes both sides agree on. The registry, the
 * built-in defaults and the call sites live in `apps/cms/src/platform/`.
 *
 * Two rules every implementation can rely on:
 *
 *  - Nothing registered means nothing changes. Each seam has a built-in default
 *    that is a no-op; for entitlements that default is "unlimited".
 *  - The CMS never turns an implementation failure into a refusal. A seam that
 *    throws is logged and the request proceeds as if the default had answered.
 *    An implementation that wants to refuse while its own backing store is
 *    unavailable returns that refusal itself.
 *
 * Pure types: this package stays free of runtime dependencies, so the runtime
 * handle is a type parameter that the CMS pins to its own `RuntimeContext`.
 */

/** The tenant a seam call is about. */
export interface TenantRef {
  /** `null` on organization-plane routes, which carry no site. */
  siteId: string | null;
  /**
   * Organization that owns the site, resolved by the CMS through a cached
   * lookup. `null` when it could not be determined (unknown site, lookup
   * failure, or a route with neither a site nor an organization principal).
   */
  organizationId: string | null;
}

/** What every seam receives alongside its own arguments. */
export interface SeamContext<TRuntime = unknown> {
  /** Runtime adapters (cache, queue, …). Never a platform binding directly. */
  runtime: TRuntime;
  /** Correlation id of the current request; `null` in cron and queue consumers. */
  requestId: string | null;
}

// ─── Entitlements ─────────────────────────────────────────────────────────────

/** A numeric ceiling, or no ceiling at all. */
export type LimitValue = number | 'unlimited';

/** The limits that apply to one organization at one point in time. */
export interface EntitlementSnapshot {
  organizationId: string | null;
  /**
   * Open, namespaced keys chosen by the implementation, e.g. `sites`,
   * `seats`, `storage.bytes`. A key the implementation does not list is
   * unlimited — read with {@link limitFor} rather than indexing directly.
   */
  limits: Readonly<Record<string, LimitValue>>;
  /** Epoch milliseconds at which the snapshot was produced. */
  resolvedAt: number;
}

/** The surface a request arrived on. */
export type EntitlementSurface = 'rest' | 'graphql' | 'mcp' | 'delivery' | 'agent' | 'system';

export interface AuthorizeRequest {
  tenant: TenantRef;
  /** Open, namespaced key naming what is about to be consumed. */
  dimension: string;
  /** How much is about to be consumed. Defaults to 1. */
  amount?: number;
  surface: EntitlementSurface;
}

export interface EntitlementWarning {
  code: string;
  dimension: string;
}

export interface EntitlementDenial {
  allowed: false;
  code: 'LIMIT_EXCEEDED';
  dimension: string;
  limit: number;
  /** `false` tells clients and agents not to retry. */
  retryable: boolean;
  /** Optional help link supplied by the implementation; the CMS never invents one. */
  helpUrl?: string;
}

export type AuthorizeDecision =
  | { allowed: true; warning?: EntitlementWarning }
  | EntitlementDenial;

export interface EntitlementResolver<TRuntime = unknown> {
  /** The limits in force for an organization (`null`: no organization known). */
  resolve(ctx: SeamContext<TRuntime>, organizationId: string | null): Promise<EntitlementSnapshot>;
  /** Whether one concrete action may proceed. */
  authorize(ctx: SeamContext<TRuntime>, req: AuthorizeRequest): Promise<AuthorizeDecision>;
}

/** Dimension names the CMS itself passes to `authorize`. */
export const ENTITLEMENT_DIMENSIONS = {
  /** One request on the authenticated API (REST, GraphQL, MCP). */
  apiRequests: 'api.requests',
  /** One request on the public delivery API. */
  deliveryRequests: 'delivery.requests',
} as const;

/** The limit for `dimension`; a key the snapshot does not carry is unlimited. */
export function limitFor(snapshot: EntitlementSnapshot, dimension: string): LimitValue {
  return Object.hasOwn(snapshot.limits, dimension) ? snapshot.limits[dimension]! : 'unlimited';
}

/** Error body of a refusal, identical on every surface. */
export interface EntitlementDenialBody {
  errors: [
    {
      code: 'LIMIT_EXCEEDED';
      dimension: string;
      limit: number;
      retryable: boolean;
      helpUrl?: string;
    },
  ];
}

export function entitlementDenialBody(denial: EntitlementDenial): EntitlementDenialBody {
  return {
    errors: [
      {
        code: denial.code,
        dimension: denial.dimension,
        limit: denial.limit,
        retryable: denial.retryable,
        ...(denial.helpUrl === undefined ? {} : { helpUrl: denial.helpUrl }),
      },
    ],
  };
}
