import { getTableName } from 'drizzle-orm';

/**
 * Minimal fake `db.select()` that can answer the queries capability resolution
 * makes (#472).
 *
 * Why this is needed. Route tests used to hand the harness `auth.roles` directly,
 * so a fake db needed nothing at all for authorization. Since capabilities are
 * resolved from the live RBAC bundle, a test that wants to say "this caller is an
 * admin" has to say it the way production says it: with a `users` row, a site
 * membership, and a role carrying `adminAccess`. That is the point of the change,
 * so the tests model it rather than stub around it.
 *
 * It answers by table name, and supports the `innerJoin` chains
 * `PermissionService.compile()` uses. Intentionally not a query engine: `where`
 * is ignored, so declare only the rows relevant to the principal under test.
 */

export interface FakePrincipalRbac {
  /** `users` row. Omit for an API-key-only principal. */
  user?: { id: string; status?: string; isBootstrap?: boolean };
  /** Site membership role id, or `null` for none. */
  membershipRoleId?: string | null;
  /** Roles resolved for the principal. `adminAccess` is what grants the bypass. */
  roles?: Array<{ id: string; name: string; adminAccess: boolean; appAccess: boolean }>;
  /** `api_keys` row, for API-key principals. */
  apiKey?: { id: string; revokedAt?: Date | null; expiresAt?: Date | null };
  /** Policy bindings; only `policyId` + `priority` are read. */
  policyBindings?: Array<{ policyId: string; priority: number }>;
  /** Policy metadata rows. */
  policies?: Array<Record<string, unknown>>;
  /** Permission rows: `{collection, action, permissions?, fields?}`. */
  permissions?: Array<Record<string, unknown>>;
}

/** An admin principal: one role with `adminAccess`, which is the real bypass. */
export function adminRbac(userId = 'u_admin'): FakePrincipalRbac {
  return {
    user: { id: userId, status: 'active', isBootstrap: false },
    membershipRoleId: 'role_admin',
    roles: [{ id: 'role_admin', name: 'Administrator', adminAccess: true, appAccess: true }],
  };
}

/**
 * A non-admin principal holding explicit item permissions.
 *
 * `capabilitiesFromPermissionBundle` maps these to the coarse vocabulary, e.g.
 * `read` + `update` on any collection → `items:read`, `items:update`,
 * `items:write`.
 */
export function memberRbac(
  userId = 'u_member',
  permissions: Array<{ collection: string; action: string }> = [],
): FakePrincipalRbac {
  return {
    user: { id: userId, status: 'active', isBootstrap: false },
    membershipRoleId: 'role_member',
    roles: [{ id: 'role_member', name: 'Member', adminAccess: false, appAccess: true }],
    policyBindings: permissions.length > 0 ? [{ policyId: 'pol_1', priority: 0 }] : [],
    policies:
      permissions.length > 0
        ? [
            {
              id: 'pol_1',
              name: 'Member policy',
              key: 'member',
              adminAccess: false,
              appAccess: true,
              enforceTfa: false,
              ipAllowlist: null,
              ipDenylist: null,
              activeFrom: null,
              activeUntil: null,
            },
          ]
        : [],
    permissions: permissions.map((p, index) => ({
      id: `perm_${index}`,
      policyId: 'pol_1',
      collection: p.collection,
      action: p.action,
      permissions: null,
      fields: ['*'],
      presets: {},
      validation: {},
    })),
  };
}

/**
 * Builds a `select` implementation for the declared RBAC state.
 *
 * Merge it into an existing fake: `{ ...existing, select: selectForRbac(rbac) }`.
 */
export function selectForRbac(rbac: FakePrincipalRbac) {
  const rowsFor = (tables: string[]): unknown[] => {
    const primary = tables[0] ?? '';
    const joined = tables.slice(1);

    if (primary === 'lumibase_users') {
      return rbac.user
        ? [{ id: rbac.user.id, status: rbac.user.status ?? 'active', isBootstrap: rbac.user.isBootstrap ?? false, email: `${rbac.user.id}@example.test`, externalId: null, tokenVersion: 0 }]
        : [];
    }
    if (primary === 'lumibase_api_keys') {
      return rbac.apiKey
        ? [{ id: rbac.apiKey.id, revokedAt: rbac.apiKey.revokedAt ?? null, expiresAt: rbac.apiKey.expiresAt ?? null, siteId: 'site_1', name: 'k' }]
        : [];
    }
    // `userSites innerJoin roles` (primary role) and `userRoles innerJoin roles`
    // (secondary roles) both select role columns.
    if (primary === 'lumibase_user_sites') {
      if (joined.includes('lumibase_roles')) return rbac.roles ?? [];
      return rbac.membershipRoleId ? [{ roleId: rbac.membershipRoleId }] : [];
    }
    if (primary === 'lumibase_user_roles') {
      // Secondary roles are already covered by `roles`; returning them twice
      // would double-count without changing any outcome, so keep this empty.
      return [];
    }
    if (
      primary === 'lumibase_role_policies' ||
      primary === 'lumibase_user_policies' ||
      primary === 'lumibase_api_key_policies'
    ) {
      return primary === 'lumibase_role_policies' ? (rbac.policyBindings ?? []) : [];
    }
    if (primary === 'lumibase_policies') return rbac.policies ?? [];
    if (primary === 'lumibase_permissions') return rbac.permissions ?? [];
    return [];
  };

  return () => {
    const tables: string[] = [];
    const chain: Record<string, unknown> = {
      from(t: unknown) {
        tables.push(getTableName(t as Parameters<typeof getTableName>[0]));
        return chain;
      },
      innerJoin(t: unknown) {
        tables.push(getTableName(t as Parameters<typeof getTableName>[0]));
        return chain;
      },
      leftJoin(t: unknown) {
        tables.push(getTableName(t as Parameters<typeof getTableName>[0]));
        return chain;
      },
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rowsFor(tables)),
      then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(rowsFor(tables)).then(resolve, reject),
    };
    return chain;
  };
}

/** Tables that capability resolution reads, and nothing else reads in tests. */
const RBAC_TABLES = new Set([
  'lumibase_users',
  'lumibase_api_keys',
  'lumibase_user_sites',
  'lumibase_user_roles',
  'lumibase_roles',
  'lumibase_role_policies',
  'lumibase_user_policies',
  'lumibase_api_key_policies',
  'lumibase_policies',
  'lumibase_permissions',
]);

/**
 * Layers RBAC answers onto an existing fake db without touching how it answers
 * everything else.
 *
 * Route tests generally own a purpose-built fake for the tables they assert on
 * (approvals, runs, tool calls). Capability resolution adds a second, unrelated
 * set of reads — including `innerJoin` chains those fakes do not implement. This
 * dispatches on the table so each side answers what it knows, instead of every
 * fake growing a permission engine.
 *
 * Per-principal by construction: build the app with the RBAC state of the
 * principal under test. A fake that ignored `where` and returned one shared set
 * of roles would hand an admin role to every caller.
 */
export function withRbacSelect<T extends object>(db: T, rbac: FakePrincipalRbac): T {
  const rbacSelect = selectForRbac(rbac);
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'select') return Reflect.get(target, prop, receiver);
      return (projection?: unknown) => {
        const delegate = (Reflect.get(target, 'select', receiver) as (p?: unknown) => {
          from: (table: unknown) => unknown;
        })(projection);
        return {
          from(table: unknown) {
            const name = getTableName(table as Parameters<typeof getTableName>[0]);
            if (RBAC_TABLES.has(name)) return (rbacSelect() as { from: (t: unknown) => unknown }).from(table);
            return delegate.from(table);
          },
        };
      };
    },
  }) as T;
}
