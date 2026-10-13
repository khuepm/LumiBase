import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentApprovals,
  agentRoles,
  aiApprovals,
  apiKeys,
  apiKeyPolicies,
  permissions,
  policies,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { AISecureHarness } from '../ai-harness';

/**
 * A parked approval must re-check the REQUESTER's current rights (#472, reviewer R2).
 *
 * ## What was wrong
 *
 * `executeApproved` checked the **decider's** capabilities and ran the stored
 * skill through the decider's harness. Nothing on the approval identified who had
 * asked for the action, so nothing could be re-checked. An approval can sit
 * pending for days; in that window a user can be demoted or deactivated and an
 * API key can be revoked or expire — and none of it took effect. An admin
 * approving in good faith executed the action under their own rights.
 *
 * The queue path had already been fixed this way: a job carries a *reference* and
 * the worker re-resolves the grant at pickup. The contract doc claimed approvals
 * worked the same and they did not.
 *
 * ## The rule under test
 *
 * Effective capabilities at execution = requester ∩ decider, both re-read now.
 * Using the decider alone lets a revoked requester act; using the requester alone
 * lets an approval widen what the decider may do.
 *
 * ## Evidence class
 *
 * REAL PostgreSQL for every row that matters: users, api keys, roles, policies,
 * permissions, approvals. The skill itself is a spy, because the assertion is
 * "did the side effect happen", not "what did ItemService write". No network, no
 * live CMS.
 *
 * **Validates: #472 acceptance — revoked/expired/demoted requester cannot have a
 * parked action executed; missing provenance fails closed; a still-valid
 * least-privilege requester succeeds**
 */

const SITE = 'site_r2_req';
const OTHER_SITE = 'site_r2_other';
const ADMIN = 'usr_r2_admin';
const ADMIN_ROLE = 'role_r2_admin';
const MEMBER = 'usr_r2_member';
const MEMBER_ROLE = 'role_r2_member';
const MEMBER_POLICY = 'pol_r2_member';
const KEY = 'key_r2_reader';
const REQUESTER_ROLE = 'r2-fixture-writer';

describe.skipIf(!hasDbIntegrationUrl)('#472 approval requester re-resolution — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('g2-approval-requester');
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(sites)
      .where(sql`${sites.id} IN (${SITE}, ${OTHER_SITE})`)
      .catch(() => undefined);
    await db
      .delete(users)
      .where(sql`${users.id} IN (${ADMIN}, ${MEMBER})`)
      .catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER_SITE})`);
    await db.delete(users).where(sql`${users.id} IN (${ADMIN}, ${MEMBER})`);
    await db.insert(sites).values([
      { id: SITE, name: 'R2 requester' },
      { id: OTHER_SITE, name: 'R2 other tenant' },
    ]);

    // Decider: a real admin, because `adminAccess` is the actual bypass.
    await db.insert(users).values([
      { id: ADMIN, email: 'r2-admin@example.dev' },
      { id: MEMBER, email: 'r2-member@example.dev' },
    ]);
    await db.insert(roles).values([
      { id: ADMIN_ROLE, siteId: SITE, name: 'R2 Administrator', adminAccess: true, appAccess: true },
      { id: MEMBER_ROLE, siteId: SITE, name: 'R2 Member', adminAccess: false, appAccess: true },
    ]);
    await db.insert(userSites).values([
      { userId: ADMIN, siteId: SITE, roleId: ADMIN_ROLE },
      { userId: MEMBER, siteId: SITE, roleId: MEMBER_ROLE },
    ]);

    // Requester: least privilege — `read` + `update` on one collection, which
    // `capabilitiesFromPermissionBundle` maps to items:read/items:update/items:write.
    await db.insert(policies).values({
      id: MEMBER_POLICY,
      siteId: SITE,
      name: 'R2 member policy',
      key: 'r2-member',
      adminAccess: false,
      appAccess: true,
    });
    await db.insert(permissions).values([
      { siteId: SITE, policyId: MEMBER_POLICY, collection: 'posts', action: 'read', fields: ['*'] },
      { siteId: SITE, policyId: MEMBER_POLICY, collection: 'posts', action: 'update', fields: ['*'] },
    ]);
    await db.insert(apiKeys).values({
      id: KEY,
      siteId: SITE,
      name: 'r2 reader key',
      prefix: 'lbk_r2',
      // Never used to authenticate here: resolution looks the key up by id. A
      // placeholder keeps the NOT NULL constraint honest without inventing a
      // credential.
      tokenHash: 'fixture-not-a-credential',
    });
    await db.insert(apiKeyPolicies).values({
      siteId: SITE,
      apiKeyId: KEY,
      policyId: MEMBER_POLICY,
      priority: 0,
    });

    await db.insert(agentRoles).values({
      siteId: SITE,
      name: REQUESTER_ROLE,
      description: 'R2 fixture writer',
      capabilities: ['items:read', 'items:write', 'items:update'],
    });
  });

  /** Harness whose only real side effect is a counted `ItemService.patch`. */
  function harnessWithSpy(patch: ReturnType<typeof vi.fn>, siteId = SITE) {
    return new AISecureHarness({
      db,
      siteId,
      itemService: {
        patch,
        // The harness stamps revision provenance and coalesces cache
        // invalidations around an approved write; both are no-ops for this spy.
        setProvenance: async () => undefined,
        beginWriteCoalescing: () => undefined,
        flushCoalescedWrites: async () => undefined,
      } as never,
      schemaService: {} as never,
      enableAgentHarnessAudit: true,
    });
  }

  /**
   * Parks `updateItem` for approval the way production does: an L1 (`PROPOSE`)
   * autonomy cap turns the write into a proposal.
   */
  async function park(
    requestedByPrincipal: Record<string, unknown> | null,
  ): Promise<{ legacyId: string; approvalId: string }> {
    const patch = vi.fn().mockResolvedValue({ id: 'i1' });
    const harness = harnessWithSpy(patch);
    const result = await harness.execute(
      'updateItem',
      { collection: 'posts', id: 'i1', data: { title: 'proposed' } },
      ['items:read', 'items:write', 'items:update'],
      'r2 fixture',
      {
        autonomyCap: 1,
        agentRole: REQUESTER_ROLE,
        requestedByPrincipal: requestedByPrincipal as never,
      },
    );

    expect(result.status, 'the write must park, not execute').toBe('pending_approval');
    expect(patch, 'nothing is written while it waits').not.toHaveBeenCalled();
    return { legacyId: result.approvalId!, approvalId: result.agentApprovalId! };
  }

  async function approve(legacyId: string) {
    const patch = vi.fn().mockResolvedValue({ id: 'i1' });
    const harness = harnessWithSpy(patch);
    // The decider is a real admin, so `['admin']` is what the resolver would give
    // them; the question under test is entirely about the requester side.
    const result = await harness.executeApproved(legacyId, ADMIN, ['admin']);
    return { result, patch };
  }

  it('executes when the least-privilege requester is still valid', async () => {
    // Positive path first: the refusals below must not be satisfiable by
    // "refuse everything".
    const { legacyId } = await park({
      kind: 'principal',
      ref: { type: 'api_key', siteId: SITE, apiKeyId: KEY },
    });

    const { result, patch } = await approve(legacyId);
    expect(result.status, result.message ?? '').toBe('executed');
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('refuses after the requester API key is REVOKED, with no side effect', async () => {
    const { legacyId } = await park({
      kind: 'principal',
      ref: { type: 'api_key', siteId: SITE, apiKeyId: KEY },
    });

    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, KEY));

    const { result, patch } = await approve(legacyId);
    expect(result.status).toBe('denied');
    expect(result.message ?? '').toContain('can no longer act');
    expect(patch).not.toHaveBeenCalled();
    // The approval stays pending, so a human can see it was not executed.
    const [row] = await db.select().from(aiApprovals).where(eq(aiApprovals.id, legacyId));
    expect(row!.status).toBe('pending');
  });

  it('refuses after the requester API key EXPIRED', async () => {
    const { legacyId } = await park({
      kind: 'principal',
      ref: { type: 'api_key', siteId: SITE, apiKeyId: KEY },
    });

    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(apiKeys.id, KEY));

    const { result, patch } = await approve(legacyId);
    expect(result.status).toBe('denied');
    expect(patch).not.toHaveBeenCalled();
  });

  it('refuses after the requester is DEMOTED out of the permission', async () => {
    // Demotion without deletion: the key still exists and still resolves, it just
    // no longer carries the permission the stored skill needs. This is the case a
    // decider-only check cannot see at all.
    const { legacyId } = await park({
      kind: 'principal',
      ref: { type: 'api_key', siteId: SITE, apiKeyId: KEY },
    });

    await db
      .delete(permissions)
      .where(and(eq(permissions.policyId, MEMBER_POLICY), eq(permissions.action, 'update')));

    const { result, patch } = await approve(legacyId);
    expect(result.status).toBe('denied');
    expect(result.message ?? '').toContain('requester ∩ decider');
    expect(patch).not.toHaveBeenCalled();
  });

  it('refuses after the requesting USER is deactivated', async () => {
    const { legacyId } = await park({
      kind: 'principal',
      ref: { type: 'user', siteId: SITE, userId: MEMBER },
    });

    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, MEMBER));

    const { result, patch } = await approve(legacyId);
    expect(result.status).toBe('denied');
    expect(patch).not.toHaveBeenCalled();
  });

  it('refuses after the requesting USER loses site membership', async () => {
    const { legacyId } = await park({
      kind: 'principal',
      ref: { type: 'user', siteId: SITE, userId: MEMBER },
    });

    await db
      .delete(userSites)
      .where(and(eq(userSites.userId, MEMBER), eq(userSites.siteId, SITE)));

    const { result, patch } = await approve(legacyId);
    expect(result.status).toBe('denied');
    expect(patch).not.toHaveBeenCalled();
  });

  it('refuses when the requesting AGENT ROLE is disabled after parking', async () => {
    // Reconciler-origin work has no human principal; the authority is the role.
    // Disabling it must stop a parked action too.
    const { legacyId } = await park({ kind: 'agentRole', role: REQUESTER_ROLE });

    await db
      .update(agentRoles)
      .set({ enabled: false })
      .where(and(eq(agentRoles.siteId, SITE), eq(agentRoles.name, REQUESTER_ROLE)));

    const { result, patch } = await approve(legacyId);
    expect(result.status).toBe('denied');
    expect(result.message ?? '').toContain('unknown or disabled');
    expect(patch).not.toHaveBeenCalled();
  });

  it('fails closed on an approval with NO recorded requester (pre-migration row)', async () => {
    // Rows parked before the column existed cannot be resolved. Treating unknown
    // provenance as "use the decider's rights" is the behaviour this removes, so
    // they are refused and must be re-requested.
    const { legacyId, approvalId } = await park({
      kind: 'principal',
      ref: { type: 'api_key', siteId: SITE, apiKeyId: KEY },
    });
    await db
      .update(agentApprovals)
      .set({ requestedByPrincipal: null })
      .where(eq(agentApprovals.id, approvalId));

    const { result, patch } = await approve(legacyId);
    expect(result.status).toBe('denied');
    expect(result.code).toBe('APPROVAL_PROVENANCE_MISSING');
    expect(patch).not.toHaveBeenCalled();
  });

  it('fails closed on provenance naming a DIFFERENT site', async () => {
    const { legacyId, approvalId } = await park({
      kind: 'principal',
      ref: { type: 'api_key', siteId: SITE, apiKeyId: KEY },
    });
    await db
      .update(agentApprovals)
      .set({
        requestedByPrincipal: {
          kind: 'principal',
          ref: { type: 'api_key', siteId: OTHER_SITE, apiKeyId: KEY },
        },
      })
      .where(eq(agentApprovals.id, approvalId));

    const { result, patch } = await approve(legacyId);
    expect(result.status).toBe('denied');
    expect(result.code).toBe('APPROVAL_PROVENANCE_INVALID');
    expect(patch).not.toHaveBeenCalled();
  });

  it('fails closed on provenance that cannot be parsed', async () => {
    const { legacyId, approvalId } = await park({
      kind: 'principal',
      ref: { type: 'api_key', siteId: SITE, apiKeyId: KEY },
    });
    await db
      .update(agentApprovals)
      .set({ requestedByPrincipal: { kind: 'principal', ref: { type: 'wat' } } })
      .where(eq(agentApprovals.id, approvalId));

    const { result, patch } = await approve(legacyId);
    expect(result.status).toBe('denied');
    expect(result.code).toBe('APPROVAL_PROVENANCE_INVALID');
    expect(patch).not.toHaveBeenCalled();
  });

  it('records provenance automatically when a write parks', async () => {
    // The column is only useful if the park path fills it, so assert the stored
    // shape rather than trusting the fixture that set it.
    const { approvalId } = await park({
      kind: 'principal',
      ref: { type: 'user', siteId: SITE, userId: MEMBER },
    });
    const [row] = await db
      .select({ requestedByPrincipal: agentApprovals.requestedByPrincipal })
      .from(agentApprovals)
      .where(eq(agentApprovals.id, approvalId));
    expect(row!.requestedByPrincipal).toEqual({
      kind: 'principal',
      ref: { type: 'user', siteId: SITE, userId: MEMBER },
    });
  });
});
