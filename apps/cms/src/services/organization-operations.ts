import type { AuthPrincipal } from '../env';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { apiKeys, organizationMembers, organizations, sites, users, type Database } from '@lumibase/database';
import { canOrg, classifyTokenPrefix, OrgKeyCreateSchema, OrgMemberUpsertSchema,
  OrgSiteCreateSchema, OrgSiteTransferSchema, type OrgAction, type OrgRole } from '@lumibase/contracts';
import { createPlaintextToken } from './api-key-token';
import { provisionSite } from './site-provisioning';
import { emailLookup } from '../modules/email-identity/service';

export type OrganizationActor = { type: 'user'; userId: string } | { type: 'api_key'; apiKeyId: string };
export function organizationActorFromAuth(auth: AuthPrincipal): OrganizationActor {
  if (auth.apiKeyId) return { type: 'api_key', apiKeyId: auth.apiKeyId };
  if (auth.userId) return { type: 'user', userId: auth.userId };
  return organizationFail('ORGANIZATION_FORBIDDEN', 403);
}
export type OrganizationMutation = 'create_site' | 'delete_site' | 'transfer_site' | 'invite_org_member' | 'create_org_key';
export type OrganizationDb = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;
export class OrganizationError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409) { super(code); }
}
export const organizationFail = (code: string, status: 400 | 403 | 404 | 409): never => { throw new OrganizationError(code, status); };
export const ORGANIZATION_MUTATION_ACTIONS: Record<OrganizationMutation, OrgAction> = {
  create_site: 'org:sites:create', delete_site: 'org:sites:delete', transfer_site: 'org:sites:transfer',
  invite_org_member: 'org:members:manage', create_org_key: 'org:keys:manage',
};
export const organizationKeyView = (key: typeof apiKeys.$inferSelect) => ({
  id: key.id, scope: key.scope, organizationId: key.organizationId, name: key.name,
  description: key.description, prefix: key.prefix, createdAt: key.createdAt,
  expiresAt: key.expiresAt, revokedAt: key.revokedAt, lastUsedAt: key.lastUsedAt, rotatedAt: key.rotatedAt,
});
export async function lockOrganization(db: OrganizationDb, id: string) {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, id)).for('update');
  if (!row) organizationFail('NOT_FOUND', 404);
  return row!;
}
export async function ensureAnotherOrganizationOwner(db: OrganizationDb, orgId: string, userId: string) {
  const owners = await db.select({ id: organizationMembers.userId }).from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.role, 'owner')));
  if (!owners.some((m) => m.id !== userId)) organizationFail('LAST_OWNER', 409);
}
/** Authorization DB only: all lookups carry the server-verified identity and org. */
export async function resolveOrganizationActorRole(db: OrganizationDb, orgId: string, actor: OrganizationActor): Promise<OrgRole | null> {
  if (actor.type === 'api_key') {
    const [key] = await db.select().from(apiKeys).where(and(eq(apiKeys.id, actor.apiKeyId),
      eq(apiKeys.organizationId, orgId), eq(apiKeys.scope, 'organization'))).limit(1).for('share');
    return key && !key.revokedAt && (!key.expiresAt || key.expiresAt > new Date()) && classifyTokenPrefix(key.prefix) === 'organization' ? 'admin' : null;
  }
  const [row] = await db.select({ role: organizationMembers.role }).from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId)).where(and(
      eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, actor.userId), eq(users.status, 'active'))).limit(1);
  return row?.role ?? null;
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) organizationFail('VALIDATION', 400);
  return parsed.data!;
}
/** The caller owns the transaction: an approval and its mutation commit together. */
export async function executeOrganizationMutation(
  db: OrganizationDb, orgId: string, operation: OrganizationMutation,
  args: Record<string, unknown>, actor: OrganizationActor,
): Promise<{ data: unknown; createdSiteId?: string }> {
  // Acquire both orgs deterministically before transfers. Other operations lock the source.
  const transfer = operation === 'transfer_site' ? parse(OrgSiteTransferSchema,
    { toOrganizationId: args.toOrganizationId }) : null;
  for (const id of [...new Set([orgId, ...(transfer ? [transfer.toOrganizationId] : [])])].sort()) await lockOrganization(db, id);
  const role = await resolveOrganizationActorRole(db, orgId, actor);
  if (!role || !canOrg(role, ORGANIZATION_MUTATION_ACTIONS[operation])) organizationFail('ORGANIZATION_FORBIDDEN', 403);
  if (operation === 'create_site') {
    const input = parse(OrgSiteCreateSchema, args);
    const result = await provisionSite(db, { id: input.id ?? input.slug, name: input.name,
      organizationId: orgId, creatorUserId: actor.type === 'user' ? actor.userId : undefined });
    return { data: result.site, createdSiteId: result.site.id };
  }
  if (operation === 'delete_site') {
    const { siteId } = parse(z.strictObject({ siteId: z.string().min(1) }), args);
    const deleted = await db.delete(sites).where(and(eq(sites.organizationId, orgId), eq(sites.id, siteId))).returning({ id: sites.id });
    if (!deleted.length) organizationFail('NOT_FOUND', 404);
    return { data: { success: true } };
  }
  if (operation === 'transfer_site') {
    const input = parse(z.strictObject({ siteId: z.string().min(1), toOrganizationId: z.string().min(1) }), args);
    if (actor.type !== 'user') organizationFail('ORGANIZATION_FORBIDDEN', 403);
    const memberships = await db.select().from(organizationMembers).where(and(
      eq(organizationMembers.userId, (actor as Extract<OrganizationActor, { type: 'user' }>).userId),
      inArray(organizationMembers.organizationId, [orgId, input.toOrganizationId]), eq(organizationMembers.role, 'owner')));
    if (new Set(memberships.map((m) => m.organizationId)).size !== new Set([orgId, input.toOrganizationId]).size) organizationFail('NOT_FOUND', 404);
    const [moved] = await db.update(sites).set({ organizationId: input.toOrganizationId, updatedAt: new Date() })
      .where(and(eq(sites.id, input.siteId), eq(sites.organizationId, orgId))).returning();
    if (!moved) organizationFail('NOT_FOUND', 404);
    return { data: moved };
  }
  if (operation === 'invite_org_member') {
    const input = parse(OrgMemberUpsertSchema, args);
    // #794: identity-aware lookup (case-insensitive; alias-aware under `root` mode).
    const lookup = input.userId ? eq(users.id, input.userId) : (await emailLookup(db, input.email ?? '')).where;
    const [user] = await db.select({ id: users.id }).from(users).where(lookup).limit(1);
    let userId = user?.id;
    if (!userId && input.email) {
      // #732: two concurrent invites of one new address both miss the lookup;
      // the unique email indexes pick one insert, and the loser re-reads the
      // winner's row instead of surfacing a 23505 as a 500.
      const [created] = await db.insert(users).values({ email: input.email, status: 'invited' })
        .onConflictDoNothing().returning({ id: users.id });
      userId = created?.id ?? (await db.select({ id: users.id }).from(users).where(lookup).limit(1))[0]?.id;
    }
    if (!userId) organizationFail('NOT_FOUND', 404);
    const [existing] = await db.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId!)));
    if (role !== 'owner' && (input.role === 'owner' || existing?.role === 'owner')) organizationFail('ORGANIZATION_FORBIDDEN', 403);
    if (existing?.role === 'owner' && input.role !== 'owner') await ensureAnotherOrganizationOwner(db, orgId, userId!);
    const [saved] = await db.insert(organizationMembers).values({ userId: userId!, organizationId: orgId, role: input.role })
      .onConflictDoUpdate({ target: [organizationMembers.userId, organizationMembers.organizationId], set: { role: input.role } }).returning();
    return { data: saved };
  }
  const input = parse(OrgKeyCreateSchema, args);
  if (input.expiresAt && new Date(input.expiresAt) <= new Date()) organizationFail('VALIDATION', 400);
  const token = await createPlaintextToken({ scope: 'organization' });
  const [key] = await db.insert(apiKeys).values({ ...input, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    scope: 'organization', organizationId: orgId, siteId: null, createdBy: actor.type === 'user' ? actor.userId : null,
    prefix: token.prefix, tokenHash: token.tokenHash }).returning();
  return { data: { ...organizationKeyView(key!), token: token.token } };
}
