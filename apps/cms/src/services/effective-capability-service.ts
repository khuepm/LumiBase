import { apiKeys, users, userSites, type Database } from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';
import { and, eq } from 'drizzle-orm';
import type { AuthPrincipal } from '../env';
import type { MagicContext } from './permission-dsl';
import {
  PermissionService,
  type PermissionBundle,
} from './permission-service';

/**
 * Stable, server-issued identity that can be persisted with an agent run.
 *
 * It intentionally carries no capabilities: those are resolved from the
 * current database state every time the principal acts, is dequeued, or
 * resumes an approval. Accepting a capability snapshot here would make a
 * revoked grant usable until the queued/parked work eventually ran.
 */
export type AuthenticatedPrincipalRef =
  | { type: 'user'; siteId: string; userId: string }
  | { type: 'api_key'; siteId: string; apiKeyId: string }
  | { type: 'dev'; siteId: string; roles: readonly string[] };

export type CapabilityDenialCode =
  | 'PRINCIPAL_SITE_MISMATCH'
  | 'PRINCIPAL_NOT_FOUND'
  | 'PRINCIPAL_INACTIVE'
  | 'PRINCIPAL_NOT_MEMBER'
  | 'API_KEY_REVOKED'
  | 'API_KEY_EXPIRED'
  | 'DEV_PRINCIPAL_FORBIDDEN';

export interface EffectiveCapabilityGrant {
  allowed: true;
  principal: AuthenticatedPrincipalRef;
  /** Coarse harness capabilities. Row/field checks remain in ItemService. */
  capabilities: string[];
  /** Whether this principal may pass the MCP control-plane admin backstop. */
  controlPlaneAdmin: boolean;
  /** Compiled policy evidence used to derive the coarse capability set. */
  bundle: PermissionBundle;
  /** Principal-bound context for request/worker ItemService construction. */
  permissionContext: MagicContext;
}

export interface EffectiveCapabilityDenial {
  allowed: false;
  principal: AuthenticatedPrincipalRef;
  capabilities: [];
  controlPlaneAdmin: false;
  code: CapabilityDenialCode;
  message: string;
}

export type EffectiveCapabilityResolution =
  | EffectiveCapabilityGrant
  | EffectiveCapabilityDenial;

export interface EffectiveCapabilityServiceDeps {
  db: Database;
  siteId: string;
  cache?: CacheProvider;
  /** Request guards such as policy IP/time conditions use these values. */
  ip?: string | null;
  headers?: Record<string, string>;
  now?: () => Date;
  /** Dev principals are never accepted outside an explicit development runtime. */
  environment?: string;
}

const ITEM_CAPABILITIES_BY_ACTION: Readonly<Record<string, readonly string[]>> = {
  read: ['items:read'],
  create: ['items:create', 'items:write'],
  update: ['items:update', 'items:write'],
  delete: ['items:delete', 'items:write'],
};

/**
 * Convert a compiled RBAC bundle into the coarse vocabulary used by tools.
 *
 * Only capabilities backed by the existing permission language are emitted.
 * Unknown actions and control-plane domains are omitted instead of guessed.
 * An admin bundle receives the existing `admin` marker, never a minted `*`.
 */
export function capabilitiesFromPermissionBundle(bundle: PermissionBundle): string[] {
  if (bundle.admin) return ['admin'];

  const capabilities = new Set<string>();
  for (const permission of Object.values(bundle.byKey)) {
    const action = String(permission.action);
    if (permission.collection === 'schema') {
      if (/^schema:(read|create|update|delete|migrate)$/.test(action)) {
        capabilities.add(action);
      }
      continue;
    }

    for (const capability of ITEM_CAPABILITIES_BY_ACTION[action] ?? []) {
      capabilities.add(capability);
    }
  }

  return [...capabilities].sort();
}

/**
 * Extract a persistable principal reference from trusted auth middleware.
 * Raw request bodies, MCP arguments and prompts must never supply this value.
 */
export function principalRefFromAuth(
  auth: AuthPrincipal | undefined,
  siteId: string,
): AuthenticatedPrincipalRef | null {
  if (!auth) return null;
  if (auth.type === 'api_key' && auth.apiKeyId) {
    return { type: 'api_key', siteId, apiKeyId: auth.apiKeyId };
  }
  if (auth.userId) {
    return { type: 'user', siteId, userId: auth.userId };
  }
  if (auth.raw?.dev === true) {
    return { type: 'dev', siteId, roles: [...(auth.roles ?? [])] };
  }
  return null;
}

/** Resolve live, tenant-scoped tool capabilities for one authenticated principal. */
export class EffectiveCapabilityService {
  constructor(private readonly deps: EffectiveCapabilityServiceDeps) {}

  async resolve(principal: AuthenticatedPrincipalRef): Promise<EffectiveCapabilityResolution> {
    if (principal.siteId !== this.deps.siteId) {
      return this.deny(
        principal,
        'PRINCIPAL_SITE_MISMATCH',
        'The authenticated principal does not belong to the active site.',
      );
    }

    if (principal.type === 'dev') return this.resolveDev(principal);
    if (principal.type === 'api_key') return this.resolveApiKey(principal);
    return this.resolveUser(principal);
  }

  private async resolveUser(
    principal: Extract<AuthenticatedPrincipalRef, { type: 'user' }>,
  ): Promise<EffectiveCapabilityResolution> {
    const [user] = await this.deps.db
      .select({
        id: users.id,
        status: users.status,
        isBootstrap: users.isBootstrap,
      })
      .from(users)
      .where(eq(users.id, principal.userId))
      .limit(1);

    if (!user) {
      return this.deny(principal, 'PRINCIPAL_NOT_FOUND', 'The authenticated user no longer exists.');
    }
    if (user.status !== 'active') {
      return this.deny(principal, 'PRINCIPAL_INACTIVE', 'The authenticated user is not active.');
    }

    const [membership] = await this.deps.db
      .select({ roleId: userSites.roleId })
      .from(userSites)
      .where(
        and(
          eq(userSites.userId, principal.userId),
          eq(userSites.siteId, this.deps.siteId),
        ),
      )
      .limit(1);

    if (!membership && !user.isBootstrap) {
      return this.deny(
        principal,
        'PRINCIPAL_NOT_MEMBER',
        'The authenticated user is not a member of the active site.',
      );
    }

    const context = this.permissionContext({
      userId: principal.userId,
      roleId: membership?.roleId ?? null,
      user: { id: principal.userId },
      apiKey: null,
    });
    const bundle = await this.bundle(context);

    // Bootstrap is the instance recovery principal and withAuth already treats
    // it as admin even when it has no site membership. Keep that contract here.
    const effectiveBundle = user.isBootstrap && !bundle.admin
      ? { ...bundle, admin: true }
      : bundle;

    return this.grant(principal, effectiveBundle, context, effectiveBundle.admin);
  }

  private async resolveApiKey(
    principal: Extract<AuthenticatedPrincipalRef, { type: 'api_key' }>,
  ): Promise<EffectiveCapabilityResolution> {
    const [apiKey] = await this.deps.db
      .select({
        id: apiKeys.id,
        revokedAt: apiKeys.revokedAt,
        expiresAt: apiKeys.expiresAt,
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.id, principal.apiKeyId),
          eq(apiKeys.siteId, this.deps.siteId),
        ),
      )
      .limit(1);

    // Site mismatch is intentionally indistinguishable from a missing key.
    if (!apiKey) {
      return this.deny(principal, 'PRINCIPAL_NOT_FOUND', 'The authenticated API key no longer exists.');
    }
    if (apiKey.revokedAt) {
      return this.deny(principal, 'API_KEY_REVOKED', 'The authenticated API key has been revoked.');
    }
    if (apiKey.expiresAt && apiKey.expiresAt <= this.now()) {
      return this.deny(principal, 'API_KEY_EXPIRED', 'The authenticated API key has expired.');
    }

    // API-key roles are resolved from api_key_roles by PermissionService; there
    // is no direct request role to forward into the context.
    const roleId: MagicContext['roleId'] = null;
    const context = this.permissionContext({
      userId: null,
      roleId,
      user: null,
      apiKey: { id: principal.apiKeyId },
    });
    const bundle = await this.bundle(context);

    // API keys can carry an admin policy for data-plane parity, but the current
    // HTTP control-plane backstop deliberately accepts human/dev admins only.
    return this.grant(principal, bundle, context, false);
  }

  private resolveDev(
    principal: Extract<AuthenticatedPrincipalRef, { type: 'dev' }>,
  ): EffectiveCapabilityResolution {
    const isDevelopment = this.deps.environment === 'development';
    const isAdmin = principal.roles.includes('admin');
    if (!isDevelopment || !isAdmin) {
      return this.deny(
        principal,
        'DEV_PRINCIPAL_FORBIDDEN',
        'Development principals require the development runtime and admin role.',
      );
    }

    const bundle: PermissionBundle = {
      admin: true,
      appAccess: true,
      tfaRequired: false,
      byKey: {},
      roles: [],
      policies: [],
    };
    // Dev auth has explicit named roles but no persisted site-role id.
    const roleId: MagicContext['roleId'] = null;
    const context = this.permissionContext({
      userId: null,
      roleId,
      user: { roles: [...principal.roles] },
      apiKey: null,
    });
    return this.grant(principal, bundle, context, true);
  }

  private permissionContext(
    principal: Pick<MagicContext, 'userId' | 'roleId' | 'user' | 'apiKey'>,
  ): MagicContext {
    return {
      ...principal,
      siteId: this.deps.siteId,
      ip: this.deps.ip ?? null,
      headers: { ...(this.deps.headers ?? {}) },
      now: this.now(),
    };
  }

  private bundle(context: MagicContext): Promise<PermissionBundle> {
    return new PermissionService({
      db: this.deps.db,
      cache: this.deps.cache,
      ctx: context,
    }).bundle();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private grant(
    principal: AuthenticatedPrincipalRef,
    bundle: PermissionBundle,
    permissionContext: MagicContext,
    controlPlaneAdmin: boolean,
  ): EffectiveCapabilityGrant {
    return {
      allowed: true,
      principal,
      capabilities: capabilitiesFromPermissionBundle(bundle),
      controlPlaneAdmin,
      bundle,
      permissionContext,
    };
  }

  private deny(
    principal: AuthenticatedPrincipalRef,
    code: CapabilityDenialCode,
    message: string,
  ): EffectiveCapabilityDenial {
    return {
      allowed: false,
      principal,
      capabilities: [],
      controlPlaneAdmin: false,
      code,
      message,
    };
  }
}
