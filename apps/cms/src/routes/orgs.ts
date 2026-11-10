import { organizationApprovalsRouter } from './organization-approvals';
import { OrganizationError as OrgError, organizationFail as fail, organizationKeyView as keyView,
  lockOrganization as lockOrg, ensureAnotherOrganizationOwner as ensureAnotherOwner,
  executeOrganizationMutation, organizationActorFromAuth } from '../services/organization-operations';
import { Hono, type MiddlewareHandler } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { organizations, organizationMembers, sites, users, apiKeys } from '@lumibase/database';
import { OrganizationCreateSchema, OrganizationUpdateSchema, OrgSiteCreateSchema,
  OrgSiteTransferSchema, OrgMemberUpsertSchema, OrgMemberUpdateSchema, OrgKeyCreateSchema } from '@lumibase/contracts';
import type { AppEnv } from '../env';
import { withOrganizationAccessGuard as guard } from '../middleware/organization-access-guard';
import { systemDbFor } from '../middleware/db';
import { isFrontendAudience, audienceValues, TOKEN_AUDIENCE } from '../services/auth/token-audience';
import { finalizeSiteProvisioning, SiteProvisioningConflict } from '../services/site-provisioning';
import { createPlaintextToken } from '../services/api-key-token';
import { AuditLogger } from '../modules/audit/logger';
import { auditSecurityGuardDenied } from '../middleware/security-audit';

export const orgsRouter = new Hono<AppEnv>();
orgsRouter.onError((error, c) => {
  if (error instanceof OrgError) return c.json({ errors: [{ code: error.code }] }, error.status);
  if (error instanceof SiteProvisioningConflict) return c.json({ errors: [{ code: 'CONFLICT' }] }, 409);
  const code = (error as { code?: string }).code;
  if (code === '23505' || code === '23503') return c.json({ errors: [{ code: 'CONFLICT' }] }, 409);
  throw error;
});
orgsRouter.use('*', async (c, next) => {
  const auth = c.get('auth');
  if (!auth) return c.json({ errors: [{ code: 'UNAUTHENTICATED' }] }, 401);
  if (isFrontendAudience(auth.raw?.aud) || (auth.apiKeyId && auth.apiKey?.scope !== 'organization')) {
    return c.json({ errors: [{ code: 'ORGANIZATION_FORBIDDEN' }] }, 403);
  }
  await next();
  if (c.req.method !== 'GET' && c.res.status < 400) {
    await new AuditLogger({ db: systemDbFor(c), siteId: null }).write({
      event: 'organization_mutation', actorEmail: auth.email ?? null,
      requestId: c.get('requestId') ?? null,
      metadata: { organizationId: c.req.param('orgId') ?? null, method: c.req.method,
        path: c.req.path, via: 'organization', actorUserId: auth.userId ?? null, apiKeyId: auth.apiKeyId ?? null },
    });
  }
});
/**
 * Routes that change who holds authority over the organization: membership,
 * organization keys and organization settings (which include the MCP gate).
 *
 * An `lbo_` key acts as role `admin`, and `canOrg('admin', …)` allows these
 * actions, so the role table alone would let a leaked key add its holder's own
 * account as a human admin, mint replacement keys that outlive its revocation,
 * or switch on `contentOs.mcp.allowOrganizationTools` for itself. Keys reach
 * these operations only through the MCP approval path, where a human decides.
 * Runs after `guard()` so a key outside the organization still gets 404.
 */
const humanOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get('auth');
  if (auth.apiKeyId || !auth.userId) {
    await auditSecurityGuardDenied(c, 'organization_access_denied', {
      organizationId: c.req.param('orgId') ?? null, reason: 'organization_key_on_human_only_route',
      method: c.req.method, path: c.req.path,
    });
    return c.json({ errors: [{ code: 'ORGANIZATION_FORBIDDEN', message: 'This organization operation requires a user session.' }] }, 403);
  }
  return next();
};

orgsRouter.get('/', async (c) => {
  const db = systemDbFor(c), auth = c.get('auth');
  if (auth.apiKeyId) return c.json({ data: await db.select().from(organizations)
    .where(eq(organizations.id, String(auth.apiKey?.organizationId))) });
  if (!auth.userId) return c.json({ errors: [{ code: 'ORGANIZATION_FORBIDDEN' }] }, 403);
  const rows = await db.select({ organization: organizations, role: organizationMembers.role })
    .from(organizationMembers).innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, auth.userId));
  return c.json({ data: rows.map((r) => ({ ...r.organization, role: r.role })) });
});
orgsRouter.post('/', async (c) => {
  const input = OrganizationCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ errors: [{ code: 'VALIDATION', message: input.error.message }] }, 400);
  const auth = c.get('auth'), db = systemDbFor(c);
  if (!auth.userId || auth.apiKeyId) return c.json({ errors: [{ code: 'ORG_SIGNUP_DISABLED' }] }, 403);
  const [user] = await db.select({ bootstrap: users.isBootstrap }).from(users).where(eq(users.id, auth.userId)).limit(1);
  const studio = audienceValues(auth.raw?.aud).includes(TOKEN_AUDIENCE.studio);
  if (!user || (!user.bootstrap && !(c.env.LUMIBASE_ALLOW_ORG_SIGNUP === 'true' && studio))) {
    return c.json({ errors: [{ code: 'ORG_SIGNUP_DISABLED' }] }, 403);
  }
  const org = await db.transaction(async (tx) => {
    const [created] = await tx.insert(organizations).values(input.data).returning();
    await tx.insert(organizationMembers).values({ organizationId: created!.id, userId: auth.userId!, role: 'owner' });
    return created!;
  });
  return c.json({ data: { ...org, role: 'owner' } }, 201);
});
orgsRouter.get('/:orgId', guard('org:read'), async (c) => {
  const [row] = await c.get('db').select().from(organizations).where(eq(organizations.id, c.req.param('orgId')));
  return row ? c.json({ data: { ...row, role: c.get('organization')!.role } }) : c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
});
orgsRouter.patch('/:orgId', guard('org:settings:write'), humanOnly, async (c) => {
  const input = OrganizationUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ errors: [{ code: 'VALIDATION' }] }, 400);
  if (input.data.slug !== undefined && c.get('organization')!.role !== 'owner') fail('ORGANIZATION_FORBIDDEN', 403);
  const [row] = await c.get('db').update(organizations).set({ ...input.data, updatedAt: new Date() })
    .where(eq(organizations.id, c.req.param('orgId'))).returning();
  if (!row) fail('NOT_FOUND', 404);
  return c.json({ data: row });
});
orgsRouter.delete('/:orgId', guard('org:delete'), async (c) => {
  const orgId = c.req.param('orgId');
  if (c.req.header('X-Confirm-Delete') !== orgId) fail('VALIDATION', 400);
  await c.get('db').transaction(async (tx) => {
    await lockOrg(tx as never, orgId);
    if ((await tx.select({ id: sites.id }).from(sites).where(eq(sites.organizationId, orgId)).limit(1)).length) fail('ORGANIZATION_NOT_EMPTY', 409);
    await tx.delete(organizations).where(eq(organizations.id, orgId));
  });
  return c.json({ data: { success: true } });
});
orgsRouter.get('/:orgId/sites', guard('org:read'), async (c) => c.json({ data: await c.get('db').select().from(sites).where(eq(sites.organizationId, c.req.param('orgId'))) }));
orgsRouter.post('/:orgId/sites', guard('org:sites:create'), async (c) => {
  const input = OrgSiteCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ errors: [{ code: 'VALIDATION' }] }, 400);
  const result = await systemDbFor(c).transaction((tx) => executeOrganizationMutation(
    tx, c.req.param('orgId'), 'create_site', input.data, organizationActorFromAuth(c.get('auth'))));
  await finalizeSiteProvisioning(systemDbFor(c), c.env, c.get('runtime'), result.createdSiteId!).catch(() => undefined);
  return c.json({ data: result.data }, 201);
});
orgsRouter.delete('/:orgId/sites/:siteId', guard('org:sites:delete'), async (c) => {
  const siteId = c.req.param('siteId');
  if (c.req.header('X-Confirm-Delete') !== siteId) fail('VALIDATION', 400);
  const result = await systemDbFor(c).transaction((tx) => executeOrganizationMutation(
    tx, c.req.param('orgId'), 'delete_site', { siteId }, organizationActorFromAuth(c.get('auth'))));
  return c.json({ data: result.data });
});
orgsRouter.post('/:orgId/sites/:siteId/transfer', guard('org:sites:transfer'), async (c) => {
  const input = OrgSiteTransferSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ errors: [{ code: 'VALIDATION' }] }, 400);
  const result = await systemDbFor(c).transaction((tx) => executeOrganizationMutation(
    tx, c.req.param('orgId'), 'transfer_site', { ...input.data, siteId: c.req.param('siteId') }, organizationActorFromAuth(c.get('auth'))));
  return c.json({ data: result.data });
});
orgsRouter.get('/:orgId/members', guard('org:read'), async (c) => c.json({ data: await c.get('db')
  .select({ userId: organizationMembers.userId, role: organizationMembers.role, email: users.email, createdAt: organizationMembers.createdAt })
  .from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId))
  .where(eq(organizationMembers.organizationId, c.req.param('orgId'))) }));
orgsRouter.post('/:orgId/members', guard('org:members:manage'), humanOnly, async (c) => {
  const input = OrgMemberUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ errors: [{ code: 'VALIDATION' }] }, 400);
  const result = await systemDbFor(c).transaction((tx) => executeOrganizationMutation(
    tx, c.req.param('orgId'), 'invite_org_member', input.data, organizationActorFromAuth(c.get('auth'))));
  return c.json({ data: result.data }, 201);
});
orgsRouter.patch('/:orgId/members/:userId', guard('org:members:manage'), humanOnly, async (c) => {
  const input = OrgMemberUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ errors: [{ code: 'VALIDATION' }] }, 400);
  const orgId = c.req.param('orgId'), userId = c.req.param('userId');
  const member = await c.get('db').transaction(async (tx) => {
    await lockOrg(tx as never, orgId);
    const where = and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId));
    const [existing] = await tx.select().from(organizationMembers).where(where);
    if (!existing) fail('NOT_FOUND', 404);
    if (c.get('organization')!.role !== 'owner' && (existing!.role === 'owner' || input.data.role === 'owner')) fail('ORGANIZATION_FORBIDDEN', 403);
    if (existing!.role === 'owner' && input.data.role !== 'owner') await ensureAnotherOwner(tx as never, orgId, userId);
    const [saved] = await tx.update(organizationMembers).set(input.data).where(where).returning();
    return saved;
  });
  return c.json({ data: member });
});
orgsRouter.delete('/:orgId/members/:userId', guard('org:members:manage'), humanOnly, async (c) => {
  const orgId = c.req.param('orgId'), userId = c.req.param('userId');
  await c.get('db').transaction(async (tx) => {
    await lockOrg(tx as never, orgId);
    const where = and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId));
    const [existing] = await tx.select().from(organizationMembers).where(where);
    if (!existing) fail('NOT_FOUND', 404);
    if (existing!.role === 'owner') {
      if (c.get('organization')!.role !== 'owner') fail('ORGANIZATION_FORBIDDEN', 403);
      await ensureAnotherOwner(tx as never, orgId, userId);
    }
    await tx.delete(organizationMembers).where(where);
  });
  return c.json({ data: { success: true } });
});
orgsRouter.get('/:orgId/keys', guard('org:read'), async (c) => c.json({ data: (await c.get('db').select().from(apiKeys)
  .where(and(eq(apiKeys.organizationId, c.req.param('orgId')), eq(apiKeys.scope, 'organization')))).map(keyView) }));
orgsRouter.post('/:orgId/keys', guard('org:keys:manage'), humanOnly, async (c) => {
  const input = OrgKeyCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ errors: [{ code: 'VALIDATION' }] }, 400);
  const result = await systemDbFor(c).transaction((tx) => executeOrganizationMutation(
    tx, c.req.param('orgId'), 'create_org_key', input.data, organizationActorFromAuth(c.get('auth'))));
  return c.json({ data: result.data }, 201);
});
orgsRouter.post('/:orgId/keys/:keyId/rotate', guard('org:keys:manage'), humanOnly, async (c) => {
  const token = await createPlaintextToken({ scope: 'organization' });
  const [key] = await c.get('db').update(apiKeys).set({ tokenHash: token.tokenHash, prefix: token.prefix,
    rotatedAt: new Date(), rotatedBy: c.get('auth').userId ?? null }).where(and(eq(apiKeys.id, c.req.param('keyId')),
      eq(apiKeys.organizationId, c.req.param('orgId')), eq(apiKeys.scope, 'organization'), sql`${apiKeys.revokedAt} IS NULL`)).returning();
  if (!key) fail('NOT_FOUND', 404);
  return c.json({ data: { ...keyView(key!), token: token.token } });
});
orgsRouter.delete('/:orgId/keys/:keyId', guard('org:keys:manage'), humanOnly, async (c) => {
  const [key] = await c.get('db').update(apiKeys).set({ revokedAt: new Date(), revokedBy: c.get('auth').userId ?? null })
    .where(and(eq(apiKeys.id, c.req.param('keyId')), eq(apiKeys.organizationId, c.req.param('orgId')), eq(apiKeys.scope, 'organization'))).returning();
  if (!key) fail('NOT_FOUND', 404);
  return c.json({ data: keyView(key!) });
});

orgsRouter.route('/:orgId/approvals', organizationApprovalsRouter);
