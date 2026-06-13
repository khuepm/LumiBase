import {
  apiKeyPolicies,
  apiKeyRoles,
  apiKeys,
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
import { isIP } from 'node:net';
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

export type PermissionAction =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'share'
  | 'read_decrypted'
  | 'configure'
  | 'install'
  | 'enable'
  | 'grant_capability'
  | 'execute'
  | 'schema:read'
  | 'schema:create'
  | 'schema:update'
  | 'schema:delete'
  | 'schema:migrate';

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
  /** Policies that contributed to this compiled permission. */
  sources: Array<{ policyId: string; policyName: string }>;
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
  /** Roles assigned to the active principal for this site. */
  roles: Array<{ id: string; name: string; adminAccess: boolean; appAccess: boolean }>;
  /** Active policy ids after IP/time guard filtering. */
  policies: Array<{ id: string; name: string; key: string | null }>;
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
    const apiKeyId = this.deps.ctx.apiKey?.id;
    if (typeof apiKeyId === 'string' && apiKeyId.length > 0) return `api_key:${apiKeyId}`;
    if (this.deps.ctx.roleId) return `role:${this.deps.ctx.roleId}`;
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
        await this.hydrateMagicContext(cached);
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
    await this.hydrateMagicContext(bundle);
    if (bundle.admin) {
      return {
        collection,
        action,
        rule: null,
        fields: ['*'],
        presets: {},
        validation: {},
        sources: [{ policyId: 'admin', policyName: 'Admin bypass' }],
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
    ctx.user = userRow ? userMagicSnapshot(userRow) : null;

    const ctxApiKeyId = typeof ctx.apiKey?.id === 'string' ? ctx.apiKey.id : null;
    const apiKeyRow = ctxApiKeyId
      ? (await db
          .select()
          .from(apiKeys)
          .where(and(eq(apiKeys.id, ctxApiKeyId), eq(apiKeys.siteId, ctx.siteId)))
          .limit(1))[0]
      : undefined;
    ctx.apiKey = apiKeyRow ? apiKeyMagicSnapshot(apiKeyRow) : ctx.apiKey ?? null;

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
    const apiKeyRoleRows = ctxApiKeyId
      ? await db
          .select({
            id: roles.id,
            name: roles.name,
            adminAccess: roles.adminAccess,
            appAccess: roles.appAccess,
          })
          .from(apiKeyRoles)
          .innerJoin(roles, eq(roles.id, apiKeyRoles.roleId))
          .where(
            and(
              scopeSite(roles.siteId, ctx.siteId),
              eq(apiKeyRoles.apiKeyId, ctxApiKeyId),
              eq(apiKeyRoles.siteId, ctx.siteId),
            ),
          )
      : [];
    const directRoleRows = ctx.roleId
      ? await db
          .select({
            id: roles.id,
            name: roles.name,
            adminAccess: roles.adminAccess,
            appAccess: roles.appAccess,
          })
          .from(roles)
          .where(and(scopeSite(roles.siteId, ctx.siteId), eq(roles.id, ctx.roleId)))
      : [];

    const roleRows = uniqueRoles([...primaryRoleRows, ...secondaryRoleRows, ...apiKeyRoleRows, ...directRoleRows]);

    // Collect policy ids from role bindings + direct user/API-key policies.
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
    const apiKeyPolicyRows = ctxApiKeyId
      ? await db
          .select({ policyId: apiKeyPolicies.policyId, priority: apiKeyPolicies.priority })
          .from(apiKeyPolicies)
          .where(
            and(
              eq(apiKeyPolicies.apiKeyId, ctxApiKeyId),
              eq(apiKeyPolicies.siteId, ctx.siteId),
            ),
          )
      : [];

    const policyOrder = [...rolePolicyRows, ...userPolicyRows, ...apiKeyPolicyRows].sort(
      (a, b) => a.priority - b.priority,
    );
    const policyIds = Array.from(new Set(policyOrder.map((p) => p.policyId)));

    if (!policyIds.length) {
      ctx.roles = roleRows.map((r) => r.id);
      ctx.policies = [];
      return {
        admin: roleRows.some((r) => r.adminAccess),
        appAccess: roleRows.some((r) => r.appAccess),
        tfaRequired: false,
        byKey: {},
        roles: roleRows,
        policies: [],
      };
    }

    // Filter out time-bound / IP-locked policies that don't match the request.
    const policyMeta = await db
      .select()
      .from(policies)
      .where(and(scopeSite(policies.siteId, ctx.siteId), inArray(policies.id, policyIds)));
    const activePolicies = policyMeta.filter((p) => isPolicyActive(p, ctx));
    const allowedPolicyIds = activePolicies.map((p) => p.id);
    const activePolicyNames = new Map(activePolicies.map((p) => [p.id, p.name]));
    const activePolicyBundle = activePolicies.map((p) => ({ id: p.id, name: p.name, key: p.key }));
    ctx.roles = roleRows.map((r) => r.id);
    ctx.policies = allowedPolicyIds;

    const admin =
      roleRows.some((r) => r.adminAccess) ||
      activePolicies.some((p) => p.adminAccess);
    const appAccess =
      roleRows.some((r) => r.appAccess) ||
      activePolicies.some((p) => p.appAccess);
    const tfaRequired = activePolicies.some((p) => p.enforceTfa);

    if (admin) {
      return { admin: true, appAccess, tfaRequired, byKey: {}, roles: roleRows, policies: activePolicyBundle };
    }

    if (!allowedPolicyIds.length) {
      return { admin: false, appAccess, tfaRequired, byKey: {}, roles: roleRows, policies: [] };
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
        sources: [{
          policyId: row.policyId,
          policyName: activePolicyNames.get(row.policyId) ?? row.policyId,
        }],
      };
      const existing = byKey[key];
      byKey[key] = existing ? mergePermission(existing, incoming) : incoming;
    }

    return { admin: false, appAccess, tfaRequired, byKey, roles: roleRows, policies: activePolicyBundle };
  }

  private async hydrateMagicContext(bundle: PermissionBundle): Promise<void> {
    this.deps.ctx.roles = bundle.roles.map((r) => r.id);
    this.deps.ctx.policies = (bundle.policies ?? []).map((p) => p.id);
    if (!this.deps.ctx.apiKey) this.deps.ctx.apiKey = null;
    if (this.deps.ctx.user || !this.deps.ctx.userId) return;
    const [userRow] = await this.deps.db
      .select()
      .from(users)
      .where(eq(users.id, this.deps.ctx.userId))
      .limit(1);
    this.deps.ctx.user = userRow ? userMagicSnapshot(userRow) : null;
  }
}

function userMagicSnapshot(row: typeof users.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    externalId: row.externalId,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    status: row.status,
    preferences: row.preferences,
    tfa: row.tfa,
    isBootstrap: row.isBootstrap,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

function apiKeyMagicSnapshot(row: typeof apiKeys.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    siteId: row.siteId,
    name: row.name,
    prefix: row.prefix,
    description: row.description,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    metadata: row.metadata,
    createdAt: row.createdAt?.toISOString() ?? null,
  };
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
  return isIpAllowedByGuard(ctx.ip, ipAllow, ipDeny);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

export function isIpAllowedByGuard(
  ip: string | null | undefined,
  allow?: string[],
  deny?: string[],
): boolean {
  if (ip && deny?.some((entry) => ipMatchesGuard(ip, entry))) return false;
  if (allow?.length) {
    if (!ip) return false;
    return allow.some((entry) => ipMatchesGuard(ip, entry));
  }
  return true;
}

function ipMatchesGuard(ip: string, guard: string): boolean {
  const normalizedGuard = guard.trim();
  if (!normalizedGuard) return false;
  if (!normalizedGuard.includes('/')) return normalizeIp(ip) === normalizeIp(normalizedGuard);
  return ipMatchesCidr(ip, normalizedGuard);
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  const [networkRaw, prefixRaw] = cidr.split('/');
  if (!networkRaw || !prefixRaw) return false;
  const network = parseIp(networkRaw);
  const subject = parseIp(ip);
  if (!network || !subject || network.version !== subject.version) return false;

  const prefix = Number(prefixRaw);
  const maxPrefix = network.version === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return false;

  if (prefix === 0) return true;
  const hostBits = BigInt(maxPrefix - prefix);
  const mask = ((1n << BigInt(maxPrefix)) - 1n) << hostBits & ((1n << BigInt(maxPrefix)) - 1n);
  return (network.value & mask) === (subject.value & mask);
}

function normalizeIp(ip: string): string | null {
  const parsed = parseIp(ip);
  return parsed ? `${parsed.version}:${parsed.value.toString(16)}` : null;
}

function parseIp(ip: string): { version: 4 | 6; value: bigint } | null {
  const version = isIP(ip);
  if (version === 4) return parseIpv4(ip);
  if (version === 6) return parseIpv6(ip);
  return null;
}

function parseIpv4(ip: string): { version: 4; value: bigint } | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = (value << 8n) + BigInt(octet);
  }
  return { version: 4, value };
}

function parseIpv6(ip: string): { version: 6; value: bigint } | null {
  const normalized = ip.includes('.') ? expandIpv4Tail(ip) : ip;
  const halves = normalized.split('::');
  if (halves.length > 2) return null;

  const left = splitIpv6Half(halves[0] ?? '');
  const right = splitIpv6Half(halves[1] ?? '');
  if (!left || !right) return null;

  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0) return null;
  const groups = halves.length === 2
    ? [...left, ...Array(missing).fill('0'), ...right]
    : left;
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) + BigInt(parseInt(group, 16));
  }
  return { version: 6, value };
}

function splitIpv6Half(value: string): string[] | null {
  if (!value) return [];
  const groups = value.split(':');
  return groups.some((group) => group.length === 0) ? null : groups;
}

function expandIpv4Tail(ip: string): string {
  const lastColon = ip.lastIndexOf(':');
  if (lastColon === -1) return ip;
  const tail = parseIpv4(ip.slice(lastColon + 1));
  if (!tail) return ip;
  const high = Number((tail.value >> 16n) & 0xffffn).toString(16);
  const low = Number(tail.value & 0xffffn).toString(16);
  return `${ip.slice(0, lastColon)}:${high}:${low}`;
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
    sources: mergePermissionSources(a.sources, b.sources),
  };
}

function mergeFieldLists(a: string[], b: string[]): string[] {
  if (a.includes('*') || b.includes('*')) return ['*'];
  const set = new Set(a);
  for (const x of b) set.add(x);
  return Array.from(set);
}

function mergePermissionSources(
  a: CompiledPermission['sources'],
  b: CompiledPermission['sources'],
): CompiledPermission['sources'] {
  const seen = new Set<string>();
  const out: CompiledPermission['sources'] = [];
  for (const source of [...a, ...b]) {
    if (seen.has(source.policyId)) continue;
    seen.add(source.policyId);
    out.push(source);
  }
  return out;
}
