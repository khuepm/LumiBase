import {
  permissions as permissionsTable,
  policies,
  rolePolicies,
  roles,
  scopeSite,
  userPolicies,
  userRoles,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import type { PolicyRule } from '@lumibase/shared';
import type { CacheProvider } from '@lumibase/runtime';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  applyFieldMask,
  compileWhere,
  evaluate,
  maskItemData,
  resolveMagic,
  type MagicContext,
} from './permission-dsl';

/**
 * PermissionService — resolves the effective permission set for the active
 * principal and exposes the helpers ItemService (and other routers) need to
 * enforce row + field level access.
 *
 * Lifecycle per request:
 *   1. Build with the request's `MagicContext` (user/site/ip/headers).
 *   2. Call `bundle()` once; this returns the cached compiled bundle and is
 *      reused for every subsequent `canAccess` / `whereFor` / `applyPresets`
 *      call within the request.
 *   3. Mutations to roles/policies/permissions invalidate the KV cache via
 *      `invalidate(siteId, principalKey?)`.
 *
 * The compiled bundle is also returned by `GET /permissions/me`.
 */

export type PermissionAction = 'create' | 'read' | 'update' | 'delete' | 'share' | 'read_decrypted';

export interface CompiledPermission {
  collection: string;
  action: PermissionAction;
  /** Composed row rule across all matching policy rows (`_or`-joined). */
  rule: PolicyRule | null;
  /** Field whitelist after merging, before excludes are applied. */
  fields: string[];
  /** Server-side presets (raw, magic vars resolved at write time). */
  presets: Record<string, unknown>;
  /** Per-action validation overrides. */
  validation: Record<string, unknown>;
}

export interface PermissionBundle {
  /** True if the principal has admin-bypass (any role with `admin_access`). */
  admin: boolean;
  /** True if the principal can sign in to Studio via at least one active policy. */
  appAccess: boolean;
  /** True if at least one active policy requires a TFA-verified session. */
  tfaRequired: boolean;
  /** Quick lookup keyed `${collection}::${action}`. */
  byKey: Record<string, CompiledPermission>;
  /** Roles assigned to the user for this site. */
  roles: Array<{ id: string; name: string; adminAccess: boolean; appAccess: boolean }>;
}

export interface PermissionServiceDeps {
  db: Database;
  cache?: CacheProvider;
  ctx: MagicContext;
}

const CACHE_TTL_SECONDS = 60;

const cacheKey = (siteId: string, principal: string) =>
  `perm:${siteId}:${principal}`;

export class PermissionService {
  private compiled: PermissionBundle | null = null;

  constructor(private readonly deps: PermissionServiceDeps) {}

  /** Stable principal id used for cache keys ("anon" when no user yet). */
  private get principalKey(): string {
    return this.deps.ctx.userId ?? 'anon';
  }

  /** Resolve and memoise the bundle for the request's principal. */
  async bundle(): Promise<PermissionBundle> {
    if (this.compiled) return this.compiled;

    if (this.deps.cache) {
      const cached = await this.deps.cache.get<PermissionBundle>(
        cacheKey(this.deps.ctx.siteId, this.principalKey),
      );
      if (cached) {
        this.compiled = cached;
        return this.compiled;
      }
    }

    this.compiled = await this.compile();

    if (this.deps.cache) {
      await this.deps.cache.set(
        cacheKey(this.deps.ctx.siteId, this.principalKey),
        JSON.stringify(this.compiled),
        { ttl: CACHE_TTL_SECONDS },
      );
    }
    return this.compiled;
  }

  /** Drop the KV entry; call after CRUD on roles/policies/permissions. */
  async invalidate(siteId: string, principal?: string): Promise<void> {
    if (!this.deps.cache) return;
    if (principal) {
      await this.deps.cache.delete(cacheKey(siteId, principal));
    } else {
      // We don't have list-by-prefix in KV; rely on TTL to age out. Targeted
      // invalidation is best-effort: known principals only.
      await this.deps.cache.delete(cacheKey(siteId, this.principalKey));
    }
  }

  /** Per-action lookup. Returns null when access is not granted. */
  async canAccess(collection: string, action: PermissionAction): Promise<CompiledPermission | null> {
    const bundle = await this.bundle();
    if (bundle.admin) {
      return {
        collection,
        action,
        rule: null,
        fields: ['*'],
        presets: {},
        validation: {},
      };
    }
    return bundle.byKey[`${collection}::${action}`] ?? null;
  }

  /** Compile the permission row's rule into a SQL WHERE-injection clause. */
  whereFor(perm: CompiledPermission | null): SQL | undefined {
    if (!perm) return sql`false`;
    return compileWhere(perm.rule ?? undefined, this.deps.ctx);
  }

  /** Apply the field whitelist to a fully-loaded item. */
  maskItem<T extends { data?: Record<string, unknown> }>(
    perm: CompiledPermission | null,
    item: T,
    knownFields: string[],
  ): T {
    if (!perm) return item;
    if (perm.fields.length === 1 && perm.fields[0] === '*') return item;
    const allowed = applyFieldMask(knownFields, perm.fields);
    return maskItemData(item, allowed);
  }

  /** Substitute magic vars inside a presets object before persisting. */
  applyPresets(
    perm: CompiledPermission | null,
    incoming: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!perm || !Object.keys(perm.presets).length) return incoming;
    const next = { ...incoming };
    for (const [k, v] of Object.entries(perm.presets)) {
      next[k] = resolveMagic(v, this.deps.ctx);
    }
    return next;
  }

  /** Verify an item snapshot satisfies the permission rule. */
  matches(perm: CompiledPermission | null, item: Record<string, unknown>): boolean {
    if (!perm) return false;
    return evaluate(perm.rule ?? undefined, item, this.deps.ctx);
  }

  // ---------- internals ----------

  private async compile(): Promise<PermissionBundle> {
    const { db, ctx } = this.deps;

    const userRow = ctx.userId
      ? (await db.select().from(users).where(eq(users.id, ctx.userId)).limit(1))[0]
      : undefined;

    const primaryRoleRows = ctx.userId
      ? await db
          .select({
            id: roles.id,
            name: roles.name,
            adminAccess: roles.adminAccess,
            appAccess: roles.appAccess,
          })
          .from(userSites)
          .innerJoin(roles, eq(roles.id, userSites.roleId))
          .where(
            and(
              scopeSite(roles.siteId, ctx.siteId),
              eq(userSites.userId, ctx.userId),
              eq(userSites.siteId, ctx.siteId),
            ),
          )
      : [];
    const secondaryRoleRows = ctx.userId
      ? await db
          .select({
            id: roles.id,
            name: roles.name,
            adminAccess: roles.adminAccess,
            appAccess: roles.appAccess,
          })
          .from(userRoles)
          .innerJoin(roles, eq(roles.id, userRoles.roleId))
          .where(
            and(
              scopeSite(roles.siteId, ctx.siteId),
              eq(userRoles.userId, ctx.userId),
              eq(userRoles.siteId, ctx.siteId),
            ),
          )
      : [];

    const roleRows = uniqueRoles([...primaryRoleRows, ...secondaryRoleRows]);

    // Collect policy ids from role bindings + direct user_policies.
    const roleIds = roleRows.map((r) => r.id);
    const rolePolicyRows = roleIds.length
      ? await db
          .select({ policyId: rolePolicies.policyId, priority: rolePolicies.priority })
          .from(rolePolicies)
          .where(inArray(rolePolicies.roleId, roleIds))
      : [];
    const userPolicyRows = ctx.userId
      ? await db
          .select({ policyId: userPolicies.policyId, priority: userPolicies.priority })
          .from(userPolicies)
          .where(
            and(
              eq(userPolicies.userId, ctx.userId),
              eq(userPolicies.siteId, ctx.siteId),
            ),
          )
      : [];

    const policyOrder = [...rolePolicyRows, ...userPolicyRows].sort(
      (a, b) => a.priority - b.priority,
    );
    const policyIds = Array.from(new Set(policyOrder.map((p) => p.policyId)));

    if (!policyIds.length) {
      return {
        admin: roleRows.some((r) => r.adminAccess),
        appAccess: roleRows.some((r) => r.appAccess),
        tfaRequired: false,
        byKey: {},
        roles: roleRows,
      };
    }

    // Filter out time-bound / IP-locked policies that don't match the request.
    const policyMeta = await db
      .select()
      .from(policies)
      .where(and(scopeSite(policies.siteId, ctx.siteId), inArray(policies.id, policyIds)));
    const activePolicies = policyMeta.filter((p) => isPolicyActive(p, ctx));
    const allowedPolicyIds = activePolicies.map((p) => p.id);

    const admin =
      roleRows.some((r) => r.adminAccess) ||
      activePolicies.some((p) => p.adminAccess);
    const appAccess =
      roleRows.some((r) => r.appAccess) ||
      activePolicies.some((p) => p.appAccess);
    const tfaRequired = activePolicies.some((p) => p.enforceTfa);

    if (admin) {
      return { admin: true, appAccess, tfaRequired, byKey: {}, roles: roleRows };
    }

    if (!allowedPolicyIds.length) {
      return { admin: false, appAccess, tfaRequired, byKey: {}, roles: roleRows };
    }

    const permRows = await db
      .select()
      .from(permissionsTable)
      .where(
        and(
          scopeSite(permissionsTable.siteId, ctx.siteId),
          inArray(permissionsTable.policyId, allowedPolicyIds),
        ),
      );

    // Group by (collection, action) and OR-merge rules + union fields/presets.
    const byKey: Record<string, CompiledPermission> = {};
    for (const row of permRows) {
      const key = `${row.collection}::${row.action}`;
      const incoming: CompiledPermission = {
        collection: row.collection,
        action: row.action as PermissionAction,
        rule: (row.permissions as PolicyRule) ?? null,
        fields: (row.fields as string[]) ?? ['*'],
        presets: (row.presets as Record<string, unknown>) ?? {},
        validation: (row.validation as Record<string, unknown>) ?? {},
      };
      const existing = byKey[key];
      byKey[key] = existing ? mergePermission(existing, incoming) : incoming;
    }

    return { admin: false, appAccess, tfaRequired, byKey, roles: roleRows };
  }
}

interface PolicyGuard {
  validFrom?: string;
  validUntil?: string;
  ipAllow?: string[];
  ipDeny?: string[];
}

interface PolicyGuardRow {
  validFrom?: Date | string | null;
  validUntil?: Date | string | null;
  ipAllow?: unknown;
  ipDeny?: unknown;
  rules?: unknown;
}

function isPolicyActive(policy: PolicyGuardRow, ctx: MagicContext): boolean {
  const rules = (policy.rules as PolicyGuard | null | undefined) ?? {};
  const validFrom = policy.validFrom ?? rules.validFrom;
  const validUntil = policy.validUntil ?? rules.validUntil;
  const ipAllow = stringArray(policy.ipAllow) ?? rules.ipAllow;
  const ipDeny = stringArray(policy.ipDeny) ?? rules.ipDeny;

  if (!rules) return true;
  const now = ctx.now ?? new Date();
  if (validFrom && new Date(validFrom) > now) return false;
  if (validUntil && new Date(validUntil) < now) return false;
  if (ipDeny?.length && ctx.ip && ipDeny.includes(ctx.ip)) return false;
  if (ipAllow?.length) {
    if (!ctx.ip || !ipAllow.includes(ctx.ip)) return false;
  }
  return true;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

function uniqueRoles<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/** OR-merge two permissions on the same (collection, action). */
function mergePermission(a: CompiledPermission, b: CompiledPermission): CompiledPermission {
  let rule: PolicyRule | null;
  if (!a.rule && !b.rule) rule = null;
  else if (!a.rule) rule = b.rule;
  else if (!b.rule) rule = a.rule;
  else rule = { _or: [a.rule, b.rule] } as PolicyRule;

  const fields = mergeFieldLists(a.fields, b.fields);
  return {
    collection: a.collection,
    action: a.action,
    rule,
    fields,
    presets: { ...a.presets, ...b.presets },
    validation: { ...a.validation, ...b.validation },
  };
}

function mergeFieldLists(a: string[], b: string[]): string[] {
  if (a.includes('*') || b.includes('*')) return ['*'];
  const set = new Set(a);
  for (const x of b) set.add(x);
  return Array.from(set);
}
