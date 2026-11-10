import { roles, sites, userSites, type Database } from '@lumibase/database';
import type { RuntimeContext } from '@lumibase/runtime';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../env';
import { reconcileOfficialExtensions } from './official-extension-reconciler';
import { forgetNegative, negativeSiteKey } from './negative-cache';

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
  if (input.creatorUserId) await db.insert(userSites).values({
    userId: input.creatorUserId, siteId: id, roleId: administratorRoleId,
  }).onConflictDoNothing();
  return { site, administratorRoleId, memberRoleId };
}
export async function finalizeSiteProvisioning(db: Database, env: AppEnv['Bindings'], runtime: RuntimeContext | undefined, siteId: string) {
  await reconcileOfficialExtensions(db, env, siteId).catch(() => undefined);
  if (runtime?.cache) await forgetNegative(runtime.cache, negativeSiteKey(siteId));
}
