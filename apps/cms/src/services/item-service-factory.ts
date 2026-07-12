import type { Context } from 'hono';
import type { AppEnv, AuthPrincipal } from '../env';
import type { MagicContext } from './permission-dsl';
import { ItemService, type ItemServiceDeps } from './item-service';
import { PermissionService } from './permission-service';

/**
 * ItemService construction helpers that make the RBAC posture *explicit*.
 *
 * ## Why this module exists
 *
 * `ItemService` enforces row/field RBAC only when it is given a
 * `permissionCtx` — otherwise `this.permissions` is `null` and every
 * `perm()` check short-circuits to "allowed" (fail-open). That design is
 * intentional (system workers legitimately run without a user principal),
 * but it means a request-scoped call site that simply *forgets* to pass
 * `permissionCtx` silently bypasses authorization — indistinguishable from
 * a deliberate system context.
 *
 * This exact bug shipped once already: the AI `updateItem` skill executed
 * `ItemService.patch()` on a service built without `permissionCtx`, letting
 * LLM-driven mutations skip RBAC. To stop it recurring, every ItemService
 * built for a **request** must go through {@link itemServiceForRequest}
 * (which always attaches a `permissionCtx`), and every ItemService built for
 * a **system/background** flow must go through {@link itemServiceForSystem}
 * (which forces the author to name a reason). A regression test
 * (`item-service-rbac-context.test.ts`) asserts route files construct
 * ItemService only via these helpers, so a bare `new ItemService(...)` on a
 * user-facing path fails CI rather than production.
 */

/** Build the request-scoped MagicContext used to enforce RBAC. */
export function buildRequestPermissionContext(input: {
  auth: AuthPrincipal | undefined;
  siteId: string;
  headers: Record<string, string>;
  ip: string | null;
}): MagicContext {
  const { auth, siteId, headers, ip } = input;
  return {
    userId: auth?.userId ?? null,
    siteId,
    roleId: null,
    user: auth
      ? {
          id: auth.userId ?? null,
          email: auth.email ?? null,
          roles: auth.roles ?? [],
          ...(auth.raw ?? {}),
        }
      : null,
    ip,
    headers,
    apiKey: auth?.apiKey ?? null,
  };
}

function collectRequestHeaders(c: Context<AppEnv>): Record<string, string> {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

/**
 * Construct an ItemService bound to the authenticated principal of `c`.
 *
 * Use this for **every** ItemService created while handling an HTTP request
 * (routes, GraphQL resolvers, MCP endpoint). It always attaches a
 * `permissionCtx`, so the returned service enforces the same row/field RBAC
 * as the normal `/items` API — an AI or MCP caller can never do more than the
 * bearer token could do directly.
 *
 * `overrides` lets a caller add optional deps (e.g. omit `search`, or rebind
 * `db` to a transaction handle for a batch operation) but cannot remove the
 * permission context — `permissionCtx` and `siteId` are applied last, so a
 * caller can never accidentally widen the RBAC posture or cross tenants.
 */
export function itemServiceForRequest(
  c: Context<AppEnv>,
  overrides: Partial<Omit<ItemServiceDeps, 'permissionCtx' | 'siteId'>> = {},
): ItemService {
  const auth = c.get('auth');
  const runtime = c.get('runtime');
  const siteId = c.get('siteId');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const realtimeNamespace = (c.env as unknown as Record<string, any>)['SITE_ROOM'] as
    | ItemServiceDeps['realtimeNamespace']
    | undefined;

  return new ItemService({
    db: c.get('db'),
    userId: auth?.userId ?? null,
    // Change Feed actor attribution: an API-key principal has no userId, so
    // without this the outbox would record it as `system` (Req 1.1).
    cdcActor: auth?.apiKeyId
      ? { type: 'api_key', id: auth.apiKeyId }
      : auth?.userId
        ? { type: 'user', id: auth.userId }
        : undefined,
    cache: runtime.cache,
    search: runtime.search,
    queue: runtime.queue,
    realtime: runtime.realtime,
    realtimeNamespace,
    extensionEnv: c.env as unknown as Record<string, unknown>,
    keyProvider: runtime.keys,
    encryptionKey:
      c.env.ENCRYPTION_KEY || (typeof process !== 'undefined' ? process.env.ENCRYPTION_KEY : undefined),
    ...overrides,
    // siteId + permissionCtx applied last so overrides can never cross tenants
    // or drop the enforcement context.
    siteId,
    permissionCtx: buildRequestPermissionContext({
      auth,
      siteId,
      headers: collectRequestHeaders(c),
      ip: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
    }),
  });
}

/**
 * Construct a PermissionService bound to the authenticated principal of `c`.
 *
 * Use this whenever a request-path service needs to make its *own* RBAC
 * decisions outside ItemService (e.g. DependentsService gating raw batch
 * writes, aggregate/insights services). It shares the same principal context
 * as {@link itemServiceForRequest}, so a caller can never authorize more than
 * the bearer token could do directly.
 */
export function permissionServiceForRequest(c: Context<AppEnv>): PermissionService {
  const siteId = c.get('siteId');
  return new PermissionService({
    db: c.get('db'),
    cache: c.get('runtime').cache,
    ctx: buildRequestPermissionContext({
      auth: c.get('auth'),
      siteId,
      headers: collectRequestHeaders(c),
      ip: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
    }),
  });
}

/**
 * Reasons a system/background ItemService legitimately runs without a
 * per-request permission context. Naming the reason forces the author to
 * justify the fail-open posture and makes each site auditable.
 */
export type SystemContextReason =
  /** Scheduled/cron flows (retention sweep, scheduled publish) — no user principal. */
  | 'scheduler'
  /** Background queue worker executing already-authorized work (veto commit, agent run). */
  | 'background-worker'
  /** GDPR erasure / SAR — gated by admin + dual-control at the service layer. */
  | 'compliance-erasure';

/**
 * Construct an ItemService that intentionally runs with system privileges
 * (no row/field RBAC). Every caller must pass a {@link SystemContextReason},
 * which documents *why* the fail-open posture is safe here (the authorization
 * decision was made upstream — cron config, an approved veto, a governed
 * agent run, or an admin-gated compliance action).
 *
 * `reason` is intentionally unused at runtime; it exists to force an explicit,
 * greppable declaration at the call site and to appear in the security
 * checklist audit table.
 */
export function itemServiceForSystem(
  deps: Omit<ItemServiceDeps, 'permissionCtx'>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  reason: SystemContextReason,
): ItemService {
  return new ItemService(deps);
}
