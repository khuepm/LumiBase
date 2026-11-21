import { policies, rolePolicies, roles, sites, userSites, type Database } from '@lumibase/database';
import type { RuntimeContext } from '@lumibase/runtime';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../env';
import { reconcileOfficialExtensions } from './official-extension-reconciler';
import { forgetNegative, negativeSiteKey } from './negative-cache';
import { invalidateSiteExists } from './domains/site-exists-cache';
import { invalidateSiteOrganization } from './domains/site-organization-cache';

type ProvisionDb = Pick<Database, 'select' | 'insert'>;
export class SiteProvisioningConflict extends Error {}
export async function upsertSiteRole(db: ProvisionDb, siteId: string, kind: 'administrator' | 'member'): Promise<string> {
  const admin = kind === 'administrator';
  const [created] = await db.insert(roles).values({
    siteId, key: kind, systemKey: kind, name: admin ? 'Administrator' : 'Member',
    description: admin ? 'Full platform access. Created during site provisioning.' : 'Standard Studio access without admin privileges.',
    adminAccess: admin, appAccess: true,
  }).onConflictDoNothing().returning({ id: roles.id });
  if (created) return created.id;
  const [existing] = await db.select({ id: roles.id }).from(roles)
    .where(and(eq(roles.siteId, siteId), eq(roles.systemKey, kind))).limit(1);
  if (!existing) throw new Error(`Could not provision ${kind} role`);
  return existing.id;
}
/** Env knob for the Administrator MFA policy created at setup (#987). */
export const ADMIN_REQUIRE_MFA_ENV = 'LUMIBASE_ADMIN_REQUIRE_MFA';
export const ADMINISTRATOR_MFA_POLICY_KEY = 'administrator_mfa';

/**
 * Whether setup binds an `enforceTfa` policy to the Administrator role (#987).
 *   1. `LUMIBASE_ADMIN_REQUIRE_MFA` decides when set: `true`/`1`/`yes` on,
 *      `false`/`0`/`no` off.
 *   2. Otherwise on in production (`LUMIBASE_ENV` or `NODE_ENV`), but only
 *      when the encryption key is configured: without it TOTP enrolment is
 *      unavailable, and a default that strands the first admin is worse than
 *      none. Passkeys work either way, so the explicit `true` still applies.
 */
export function shouldRequireAdminMfa(env: Readonly<Record<string, unknown>>, encryptionAvailable: boolean): boolean {
  const v = env[ADMIN_REQUIRE_MFA_ENV];
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  const production = env.LUMIBASE_ENV === 'production' || env.NODE_ENV === 'production';
  return production && encryptionAvailable;
}

/**
 * Bind an "Administrator MFA" policy to `roleId`: it grants nothing, it only
 * sets `enforceTfa`, so removing it (Settings → Access) is the opt-out.
 * Idempotent on the policy's `(site_id, key)` and the role binding.
 */
export async function ensureAdministratorMfaPolicy(db: ProvisionDb, siteId: string, roleId: string): Promise<string> {
  const [created] = await db.insert(policies).values({
    siteId, key: ADMINISTRATOR_MFA_POLICY_KEY, name: 'Administrator MFA',
    description: 'Requires a two-factor verified session for administrators. Created during setup.',
    icon: 'shield', adminAccess: false, appAccess: false, enforceTfa: true,
  }).onConflictDoNothing().returning({ id: policies.id });
  let policyId = created?.id;
  if (!policyId) {
    const [existing] = await db.select({ id: policies.id }).from(policies)
      .where(and(eq(policies.siteId, siteId), eq(policies.key, ADMINISTRATOR_MFA_POLICY_KEY))).limit(1);
    if (!existing) throw new Error('Could not provision the Administrator MFA policy');
    policyId = existing.id;
  }
  await db.insert(rolePolicies).values({ roleId, policyId, priority: 100 }).onConflictDoNothing();
  return policyId;
}

/** Called inside the caller's transaction; external effects run after commit. */
export async function provisionSite(db: ProvisionDb, input: {
  id?: string; name: string; organizationId: string; creatorUserId?: string;
  displayTitle?: string; siteUrl?: string | null; defaultLanguage?: string; allowExisting?: boolean;
}) {
  const id = input.id ?? nanoid();
  const [created] = await db.insert(sites).values({
    id, name: input.name, organizationId: input.organizationId, displayTitle: input.displayTitle,
    siteUrl: input.siteUrl, defaultLanguage: input.defaultLanguage,
  }).onConflictDoNothing().returning();
  const site = created ?? (await db.select().from(sites).where(eq(sites.id, id)).limit(1))[0];
  if (!site || site.organizationId !== input.organizationId || (!created && !input.allowExisting)) {
    throw new SiteProvisioningConflict('Site id already exists');
  }
  const administratorRoleId = await upsertSiteRole(db, id, 'administrator');
  const memberRoleId = await upsertSiteRole(db, id, 'member');
  // Target `(user_id, site_id)` (#861): "already a member" stays a no-op, while
  // a strict site's `user_sites_site_identity_unique` violation surfaces
  // instead of being dropped by a target-less DO NOTHING.
  if (input.creatorUserId) await db.insert(userSites).values({
    userId: input.creatorUserId, siteId: id, roleId: administratorRoleId,
  }).onConflictDoNothing({ target: [userSites.userId, userSites.siteId] });
  return { site, administratorRoleId, memberRoleId };
}
export async function finalizeSiteProvisioning(db: Database, env: AppEnv['Bindings'], runtime: RuntimeContext | undefined, siteId: string) {
  await reconcileOfficialExtensions(db, env, siteId).catch(() => undefined);
  if (runtime?.cache) {
    await Promise.all([
      forgetNegative(runtime.cache, negativeSiteKey(siteId)),
      invalidateSiteExists(runtime.cache, siteId),
      // A lookup made before the site existed may have cached "no owner".
      invalidateSiteOrganization(runtime.cache, siteId),
    ]);
  }
}
