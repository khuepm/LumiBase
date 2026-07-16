import { eq, like, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Database } from '../client';
import { policies, rolePolicies, roles } from '../schema/access';

/**
 * RBAC role→policy flag backfill (upgrade path 0.6.x → 1.0).
 *
 * Instances that predate the policy model stored `admin_access`/`app_access`
 * as flags on roles. 1.0 treats policies as the source of truth for these
 * flags; during the compatibility window `PermissionService` reads
 * `role flags OR active policy flags`. This backfill materializes each legacy
 * role flag pair into one flag-only policy so the policy layer alone is
 * authoritative before the fallback is disabled.
 *
 * Contract (docs/en/features/role-policy-flag-migration.md §3 Phase B):
 * - Policy key `legacy_role_flags_<stable_role_key>`, name
 *   `Legacy role flags: <role name>`.
 * - Copies the EXACT flag values (no `admin => app` inference — API-only
 *   admin roles and app-only roles must keep their current behavior).
 * - `enforce_tfa=false`, empty IP guards, null time windows, no permission
 *   rows — the policy only carries access flags.
 * - Attached via `role_policies` with priority 5 (convention; flag-only
 *   policies never participate in permission-row merging).
 * - Role flags are NOT mutated: they stay as the rollback anchor.
 *
 * Idempotent: re-running upserts the same policy keys (`policies_site_key_unique`)
 * and skips existing links, so a partial or repeated run converges.
 */

export const LEGACY_POLICY_KEY_PREFIX = 'legacy_role_flags_';
const LEGACY_POLICY_PRIORITY = 5;

interface LegacyRole {
  id: string;
  siteId: string;
  name: string;
  key: string | null;
  systemKey: string | null;
  adminAccess: boolean;
  appAccess: boolean;
}

/** Stable per-role key: `lower(regexp_replace(coalesce(system_key, key, id), '[^a-zA-Z0-9]+', '_'))`. */
export function deriveLegacyRoleKey(role: Pick<LegacyRole, 'id' | 'key' | 'systemKey'>): string {
  const source = role.systemKey ?? role.key ?? role.id;
  return source.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
}

export interface BackfillResult {
  /** Roles carrying a legacy flag (`admin_access` or `app_access` true). */
  legacyRoleCount: number;
  /** Legacy policies inserted or updated (one per legacy role). */
  policiesUpserted: number;
  /** `role_policies` links newly created (0 on a converged re-run). */
  linksInserted: number;
}

export async function backfillRolePolicyFlags(db: Database): Promise<BackfillResult> {
  const legacyRoles: LegacyRole[] = await db
    .select({
      id: roles.id,
      siteId: roles.siteId,
      name: roles.name,
      key: roles.key,
      systemKey: roles.systemKey,
      adminAccess: roles.adminAccess,
      appAccess: roles.appAccess,
    })
    .from(roles)
    .where(or(eq(roles.adminAccess, true), eq(roles.appAccess, true)));

  let policiesUpserted = 0;
  let linksInserted = 0;

  await db.transaction(async (tx) => {
    for (const role of legacyRoles) {
      const policyKey = `${LEGACY_POLICY_KEY_PREFIX}${deriveLegacyRoleKey(role)}`;

      const [policy] = await tx
        .insert(policies)
        .values({
          id: nanoid(),
          siteId: role.siteId,
          key: policyKey,
          name: `Legacy role flags: ${role.name}`,
          description:
            'Backfilled from roles.admin_access/app_access. Do not edit manually after policy migration is complete.',
          adminAccess: role.adminAccess,
          appAccess: role.appAccess,
          enforceTfa: false,
          ipAllow: [],
          ipDeny: [],
          validFrom: null,
          validUntil: null,
          rules: {},
        })
        .onConflictDoUpdate({
          target: [policies.siteId, policies.key],
          set: {
            adminAccess: role.adminAccess,
            appAccess: role.appAccess,
            enforceTfa: false,
            ipAllow: [],
            ipDeny: [],
            validFrom: null,
            validUntil: null,
          },
        })
        .returning({ id: policies.id });

      if (!policy) {
        throw new Error(`Backfill upsert returned no row for policy key ${policyKey} (site ${role.siteId}).`);
      }
      policiesUpserted += 1;

      const linked = await tx
        .insert(rolePolicies)
        .values({ roleId: role.id, policyId: policy.id, priority: LEGACY_POLICY_PRIORITY })
        .onConflictDoNothing()
        .returning({ roleId: rolePolicies.roleId });
      linksInserted += linked.length;
    }
  });

  return { legacyRoleCount: legacyRoles.length, policiesUpserted, linksInserted };
}

export interface UnbackfilledRole {
  id: string;
  siteId: string;
  name: string;
  adminAccess: boolean;
  appAccess: boolean;
}

/**
 * Post-check from docs/en/operations/upgrades.md — every role carrying a
 * legacy flag must have an attached policy with the same flag values.
 * MUST return an empty array before `LUMIBASE_RBAC_LEGACY_ROLE_FLAGS=false`.
 */
export async function findUnbackfilledRoles(db: Database): Promise<UnbackfilledRole[]> {
  const result = await db.execute(sql`
    SELECT r.id, r.site_id, r.name, r.admin_access, r.app_access
    FROM lumibase_roles r
    WHERE (r.admin_access = true OR r.app_access = true)
    AND NOT EXISTS (
      SELECT 1
      FROM lumibase_role_policies rp
      JOIN lumibase_policies p ON p.id = rp.policy_id
      WHERE rp.role_id = r.id
        AND p.admin_access = r.admin_access
        AND p.app_access = r.app_access
    )
  `);

  return (result as unknown as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    siteId: String(row.site_id),
    name: String(row.name),
    adminAccess: Boolean(row.admin_access),
    appAccess: Boolean(row.app_access),
  }));
}

/**
 * Rollback (safe only during the compatibility window): remove the backfilled
 * policies and their links. Role flags were never mutated, so effective
 * access is preserved by the legacy fallback.
 */
export async function rollbackRolePolicyBackfill(db: Database): Promise<{ policiesDeleted: number }> {
  return db.transaction(async (tx) => {
    const legacy = await tx
      .select({ id: policies.id })
      .from(policies)
      .where(like(policies.key, `${LEGACY_POLICY_KEY_PREFIX}%`));

    for (const policy of legacy) {
      await tx.delete(rolePolicies).where(eq(rolePolicies.policyId, policy.id));
      await tx.delete(policies).where(eq(policies.id, policy.id));
    }

    return { policiesDeleted: legacy.length };
  });
}
