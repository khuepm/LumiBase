import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { and, eq, inArray } from 'drizzle-orm';
import { aiApprovals, apiKeys, auditLog, organizations, organizationMembers, settings, sites, users, type Database } from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { OrganizationToolSchemas } from '@lumibase/contracts';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import type { AppEnv } from '../../env';
import { withTenant } from '../../middleware/tenant';
import { withAuth } from '../../middleware/auth';
import { withSiteMembership } from '../../middleware/site-membership';
import { withStudioAccess } from '../../middleware/studio-access';
import { withControlPlaneAccessGuard } from '../../middleware/control-plane-access-guard';
import { orgsRouter } from '../orgs';
import { mcpRouter } from '../mcp';
import { createPlaintextToken } from '../../services/api-key-token';
import { provisionSite } from '../../services/site-provisioning';

const A = 'org_638_a', B = 'org_638_b', SA = 'site_638_a';
const OWNER = 'user_638_owner', ADMIN = 'user_638_admin', OTHER = 'user_638_other', DUAL = 'user_638_dual';
const secret = 'organization-mcp-test-signing-key-only';
const enabled = { contentOs: { mcp: { allowOrganizationTools: true } } };

describe.skipIf(!hasDbIntegrationUrl)('organization MCP and human approvals (real PostgreSQL)', () => {
  let db: Database, app: Hono<AppEnv>, token: string, siteToken: string;
  let owner: string, admin: string, other: string, dual: string;
  async function jwt(userId: string) {
    return new SignJWT({ userId, siteId: SA, tokenVersion: 0 }).setProtectedHeader({ alg: 'HS256' })
      .setAudience('studio').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  }
  async function clean() {
    await db.delete(sites).where(inArray(sites.organizationId, [A, B]));
    await db.delete(organizations).where(inArray(organizations.id, [A, B]));
    await db.delete(users).where(inArray(users.id, [OWNER, ADMIN, OTHER, DUAL]));
  }
  async function request(path: string, bearer: string, method = 'GET', body?: unknown, env: Partial<AppEnv['Bindings']> = {}, headers: Record<string, string> = {}) {
    return app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { JWT_SECRET: secret, ...env } as AppEnv['Bindings']);
  }
  async function payload(response: Response): Promise<any> { return response.json(); }
  async function call(name: string, args: Record<string, unknown> = {}, bearer = token, env: Partial<AppEnv['Bindings']> = {}) {
    const response = await request('/mcp', bearer, 'POST', { jsonrpc: '2.0', id: 638, method: 'tools/call',
      params: { name, arguments: { organizationId: A, ...args } } }, env);
    return { response, body: await payload(response) };
  }
  async function decide(id: string, bearer = owner, decision = 'approved', env: Partial<AppEnv['Bindings']> = {}) {
    return request(`/orgs/${A}/approvals/${id}/decide`, bearer, 'POST', { decision }, env);
  }
  beforeAll(async () => {
    db = await connectDbIntegration('organization-mcp');
    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db); c.set('runtime', { cache: new MemoryCacheProvider() } as never);
      c.set('requestId', 'req_638_mcp'); await next();
    });
    app.use('*', withTenant(), withAuth(), withSiteMembership(), withStudioAccess(), withControlPlaneAccessGuard());
    app.route('/api/v1/orgs', orgsRouter); app.route('/api/v1/mcp', mcpRouter);
  });
  beforeEach(async () => {
    await clean();
    await db.insert(organizations).values([{ id: A, slug: A, name: '638 A', settings: enabled }, { id: B, slug: B, name: '638 B', settings: enabled }]);
    await db.insert(users).values([OWNER, ADMIN, OTHER, DUAL].map((id) => ({ id, email: `${id}@example.test`, status: 'active' })));
    await db.insert(organizationMembers).values([
      { userId: OWNER, organizationId: A, role: 'owner' }, { userId: ADMIN, organizationId: A, role: 'admin' },
      { userId: OTHER, organizationId: B, role: 'owner' }, { userId: DUAL, organizationId: A, role: 'owner' },
      { userId: DUAL, organizationId: B, role: 'owner' },
    ]);
    await provisionSite(db, { id: SA, name: '638 Site', organizationId: A });
    const org = await createPlaintextToken({ scope: 'organization' }), site = await createPlaintextToken();
    await db.insert(apiKeys).values([
      { id: 'key_638_org', name: '638 Org', scope: 'organization', organizationId: A, prefix: org.prefix, tokenHash: org.tokenHash },
      { id: 'key_638_site', name: '638 Site', siteId: SA, prefix: site.prefix, tokenHash: site.tokenHash },
    ]);
    token = org.token; siteToken = site.token;
    [owner, admin, other, dual] = await Promise.all([jwt(OWNER), jwt(ADMIN), jwt(OTHER), jwt(DUAL)]);
  });
  afterAll(async () => { if (db) await clean(); });

  it('discovers exactly the org namespace without any site, including after all sites are deleted', async () => {
    await db.delete(sites).where(eq(sites.id, SA));
    const response = await request('/mcp', token, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(response.status).toBe(200);
    const body = await payload(response);
    expect(body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(Object.keys(OrganizationToolSchemas).sort());
    const own = await call('org:get_organization');
    expect(own.body.result.structuredContent).toMatchObject({ status: 'executed', organizationId: A, data: { id: A } });
  });
  it('defaults off and honors the CMS off switch even when org settings allow it', async () => {
    await db.update(organizations).set({ settings: {} }).where(eq(organizations.id, A));
    expect((await call('org:list_sites')).response.status).toBe(404);
    await db.update(organizations).set({ settings: enabled }).where(eq(organizations.id, A));
    expect((await call('org:list_sites', {}, token, { LUMIBASE_MCP_ORG_TOOLS: 'off' })).response.status).toBe(404);
    expect(await db.select().from(aiApprovals).where(eq(aiApprovals.organizationId, A))).toHaveLength(0);
  });
  it('does not apply the organization MCP switch to site tools on a pinned key', async () => {
    await db.update(organizations).set({ settings: {} }).where(eq(organizations.id, A));
    await db.insert(settings).values({ siteId: SA, key: 'contentOs', value: { mcp: true } });
    const response = await request('/mcp', token, 'POST', { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {}, { 'X-Lumi-Site': SA });
    expect(response.status).toBe(200);
    expect((await payload(response)).result.tools.length).toBeGreaterThan(0);
  });
  it('the lbo_ prefix is never authentication and site credentials cannot call org skills', async () => {
    expect((await call('org:list_sites', {}, 'lbo_not_a_valid_key')).response.status).toBe(401);
    const response = await request('/mcp', siteToken, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'org:list_sites', arguments: { organizationId: A } } }, {}, { 'X-Lumi-Site': SA });
    expect(response.status).toBe(403);
    expect((await call('org:get_organization', { organizationId: B })).body.result.structuredContent).toMatchObject({ status: 'denied', code: 'NOT_FOUND' });
  });
  it('parks create_site without a fake site and commits approval + provisioning once', async () => {
    const requested = await call('org:create_site', { name: '638 created', id: 'site_638_created' });
    expect(requested.response.status).toBe(200);
    const decision = requested.body.result.structuredContent;
    expect(decision).toMatchObject({ status: 'pending_approval', organizationId: A });
    expect(decision.approvalId).toMatch(/^[0-9a-f-]{14}7[0-9a-f-]+$/);
    const [approval] = await db.select().from(aiApprovals).where(eq(aiApprovals.id, decision.approvalId));
    expect(approval).toMatchObject({ siteId: null, organizationId: A, status: 'pending', organizationRequester: { type: 'api_key', apiKeyId: 'key_638_org' } });
    expect(await db.select().from(sites).where(eq(sites.id, 'site_638_created'))).toHaveLength(0);
    const responses = await Promise.all([decide(decision.approvalId), decide(decision.approvalId)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(await db.select().from(sites).where(eq(sites.id, 'site_638_created'))).toHaveLength(1);
    expect((await payload(responses[0]!)).data).toMatchObject({ status: 'approved', decidedBy: OWNER });
  });
  it('cannot use confirm=true to bypass pending approval', async () => {
    const requested = await call('org:create_site', { name: '638 confirmed', id: 'site_638_confirmed', confirm: true });
    expect(requested.body.result.structuredContent.status).toBe('denied');
    expect(requested.body.result.structuredContent.code).toBe('VALIDATION');
    expect(await db.select().from(sites).where(eq(sites.id, 'site_638_confirmed'))).toHaveLength(0);
  });
  it('requires a real owner to approve deletion and a human owner of both orgs for transfer', async () => {
    const deletion = (await call('org:delete_site', { siteId: SA })).body.result.structuredContent;
    expect(deletion.status).toBe('pending_approval');
    expect((await decide(deletion.approvalId, token)).status).toBe(403);
    expect((await decide(deletion.approvalId, admin)).status).toBe(403);
    const transfer = (await call('org:transfer_site', { siteId: SA, toOrganizationId: B })).body.result.structuredContent;
    expect((await decide(transfer.approvalId, owner)).status).toBe(404);
    expect((await decide(transfer.approvalId, dual)).status).toBe(200);
    expect((await db.select().from(sites).where(eq(sites.id, SA)))[0]!.organizationId).toBe(B);
    // The older source-org deletion proposal cannot remove the transferred site.
    expect((await decide(deletion.approvalId, owner)).status).toBe(404);
  });
  it('does not execute work after the requesting key is revoked; rejection still works', async () => {
    const decision = (await call('org:create_site', { name: '638 revoked', id: 'site_638_revoked' })).body.result.structuredContent;
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, 'key_638_org'));
    const response = await decide(decision.approvalId);
    expect(response.status).toBe(409);
    expect((await payload(response)).errors[0].code).toBe('REQUESTER_REVOKED');
    expect(await db.select().from(sites).where(eq(sites.id, 'site_638_revoked'))).toHaveLength(0);
    expect((await decide(decision.approvalId, owner, 'rejected')).status).toBe(200);
  });
  it('re-checks the organization kill switch before execution', async () => {
    const decision = (await call('org:create_site', { name: '638 off', id: 'site_638_off' })).body.result.structuredContent;
    expect((await decide(decision.approvalId, owner, 'approved', { LUMIBASE_MCP_ORG_TOOLS: 'off' })).status).toBe(403);
    expect(await db.select().from(sites).where(eq(sites.id, 'site_638_off'))).toHaveLength(0);
    expect((await decide(decision.approvalId, owner, 'rejected', { LUMIBASE_MCP_ORG_TOOLS: 'off' })).status).toBe(200);
  });
  it('shows minted key plaintext once to the approver, never stores it, and never mints twice', async () => {
    const requested = await call('org:create_org_key', { name: '638 minted' });
    const decision = requested.body.result.structuredContent;
    expect(decision.status).toBe('pending_approval');
    expect((await request(`/orgs/${A}/approvals/${decision.approvalId}`, token)).status).toBe(403);
    expect((await request(`/orgs/${A}/approvals/${decision.approvalId}`, other)).status).toBe(404);
    const approved = await decide(decision.approvalId);
    expect(approved.status).toBe(200);
    const receipt = (await payload(approved)).data;
    expect(receipt.result.token).toMatch(/^lbo_/);
    expect(JSON.stringify(requested.body)).not.toContain(receipt.result.token);
    expect(JSON.stringify((await payload(await request(`/orgs/${A}/approvals`, owner))).data)).not.toContain(receipt.result.token);
    // The stored receipt keeps no plaintext: not in the row, not on read, not on replay.
    const [stored] = await db.select().from(aiApprovals).where(eq(aiApprovals.id, decision.approvalId));
    expect(JSON.stringify(stored!.result)).not.toContain(receipt.result.token);
    expect(stored!.result).toMatchObject({ tokenRedacted: true, scope: 'organization' });
    const read = (await payload(await request(`/orgs/${A}/approvals/${decision.approvalId}`, owner))).data;
    expect(JSON.stringify(read)).not.toContain(receipt.result.token);
    expect(read.result).toMatchObject({ tokenRedacted: true });
    const again = await decide(decision.approvalId);
    expect(again.status).toBe(200);
    expect(JSON.stringify((await payload(again)).data)).not.toContain(receipt.result.token);
    expect(await db.select().from(apiKeys).where(and(eq(apiKeys.organizationId, A), eq(apiKeys.name, '638 minted')))).toHaveLength(1);
    // A row written before redaction existed is still redacted on read.
    await db.update(aiApprovals).set({ result: { ...(stored!.result as object), token: 'lbo_legacy_plaintext' } })
      .where(eq(aiApprovals.id, decision.approvalId));
    expect(JSON.stringify((await payload(await request(`/orgs/${A}/approvals/${decision.approvalId}`, owner))).data))
      .not.toContain('lbo_legacy_plaintext');
    const events = await db.select().from(auditLog).where(eq(auditLog.requestId, 'req_638_mcp'));
    expect(events.some((e) => (e.metadata as Record<string, unknown>).organizationId === A && (e.metadata as Record<string, unknown>).runId === decision.runId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(receipt.result.token);
  });
  it('leaves a rejected request inert under concurrent approve/reject', async () => {
    const decision = (await call('org:create_site', { name: '638 race', id: 'site_638_race' })).body.result.structuredContent;
    const responses = await Promise.all([decide(decision.approvalId), decide(decision.approvalId, owner, 'rejected')]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const [record] = await db.select().from(aiApprovals).where(eq(aiApprovals.id, decision.approvalId));
    const created = await db.select().from(sites).where(eq(sites.id, 'site_638_race'));
    expect(created).toHaveLength(record!.status === 'approved' ? 1 : 0);
  });
  it('can reject a pending transfer after destination deletion', async () => {
    const decision = (await call('org:transfer_site', { siteId: SA, toOrganizationId: B })).body.result.structuredContent;
    expect((await request(`/orgs/${B}`, dual, 'DELETE', undefined, {}, { 'X-Confirm-Delete': B })).status).toBe(200);
    expect((await decide(decision.approvalId, dual, 'approved')).status).toBe(404);
    expect((await db.select().from(aiApprovals).where(eq(aiApprovals.id, decision.approvalId)))[0]!.status).toBe('pending');
    const rejected = await decide(decision.approvalId, dual, 'rejected');
    expect(rejected.status).toBe(200);
    expect((await payload(rejected)).data.status).toBe('rejected');
    expect((await db.select().from(sites).where(eq(sites.id, SA)))[0]!.organizationId).toBe(A);
  });
  it('replays a completed transfer receipt after destination deletion', async () => {
    const decision = (await call('org:transfer_site', { siteId: SA, toOrganizationId: B })).body.result.structuredContent;
    const approved = await decide(decision.approvalId, dual);
    expect(approved.status).toBe(200);
    const original = (await payload(approved)).data;
    expect((await request(`/orgs/${B}/sites/${SA}`, dual, 'DELETE', undefined, {}, { 'X-Confirm-Delete': SA })).status).toBe(200);
    expect((await request(`/orgs/${B}`, dual, 'DELETE', undefined, {}, { 'X-Confirm-Delete': B })).status).toBe(200);
    const replay = await decide(decision.approvalId, dual);
    expect(replay.status).toBe(200);
    expect((await payload(replay)).data).toEqual(original);
  });

});
