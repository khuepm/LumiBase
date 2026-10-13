import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentRoles,
  apiKeys,
  apiKeyPolicies,
  collections,
  fields,
  items,
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
import { EffectiveCapabilityService } from '../effective-capability-service';
import { itemServiceForPrincipal } from '../item-service-factory';
import { SchemaService } from '../schema-service';

/**
 * An approved action must run under the REQUESTER's row/field rules, not the
 * approver's (#472 F1, reviewer round 2).
 *
 * ## What the capability intersection missed
 *
 * The first fix compared capability *tokens*: requester ∩ decider. Tokens like
 * `items:write` say nothing about which collection, which rows, or which fields,
 * so a restriction expressed in the policy DSL survived the check untouched. The
 * skill then executed against the ItemService built from the **approver's**
 * request, which for an admin means no field mask at all.
 *
 * Measured before the fix, on Postgres with a real ItemService: an API key parked
 * an update to `title`; its update permission was then narrowed to `body`; a
 * direct call with the key's own context was refused with
 * `Permission does not allow writing field(s): title`, and the admin approving the
 * parked action **wrote `title` anyway**. The approval was a way around a
 * restriction that was already in force.
 *
 * ## Evidence class
 *
 * REAL PostgreSQL and a REAL `ItemService` — no patch spy, because the whole
 * question is what the permission layer does, and a spy would answer a different
 * question ("was the method called"). The assertion reads the item row back, so a
 * refusal that still wrote would fail. No network, no live CMS, no LLM.
 *
 * **Validates: #472 F1 — the approval executes with the requester's reach**
 */

const SITE = 'site_r2_scope';
const OTHER_SITE = 'site_r2_scope_other';
const ADMIN = 'usr_r2_scope_admin';
const ADMIN_ROLE = 'role_r2_scope_admin';
const WRITER_POLICY = 'pol_r2_scope_writer';
const KEY = 'key_r2_scope_writer';
const AGENT_ROLE = 'r2-scope-writer';

describe.skipIf(!hasDbIntegrationUrl)('#472 F1 approval runs with the requester scope — DB integration', () => {
  let db: Database;
  let collectionId: string;
  let itemId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('g2-approval-requester-scope');
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(sites)
      .where(sql`${sites.id} IN (${SITE}, ${OTHER_SITE})`)
      .catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER_SITE})`);
    await db.delete(users).where(eq(users.id, ADMIN));

    await db.insert(sites).values([
      { id: SITE, name: 'R2 scope' },
      { id: OTHER_SITE, name: 'R2 scope other tenant' },
    ]);
    await db.insert(users).values({ id: ADMIN, email: 'r2-scope-admin@example.dev' });
    await db.insert(roles).values({
      id: ADMIN_ROLE,
      siteId: SITE,
      name: 'R2 scope Administrator',
      adminAccess: true,
      appAccess: true,
    });
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: ADMIN_ROLE });

    await db.insert(policies).values({
      id: WRITER_POLICY,
      siteId: SITE,
      name: 'R2 scope writer',
      key: 'r2-scope-writer',
      adminAccess: false,
      appAccess: true,
    });
    // Starts wide (`*`), so the narrowing below is the only difference between
    // the two halves of the test.
    await db.insert(permissions).values([
      { siteId: SITE, policyId: WRITER_POLICY, collection: 'posts', action: 'read', fields: ['*'] },
      { siteId: SITE, policyId: WRITER_POLICY, collection: 'posts', action: 'update', fields: ['*'] },
    ]);
    await db.insert(apiKeys).values({
      id: KEY,
      siteId: SITE,
      name: 'r2 scope writer key',
      prefix: 'lbk_r2s',
      tokenHash: 'fixture-not-a-credential',
    });
    await db.insert(apiKeyPolicies).values({
      siteId: SITE,
      apiKeyId: KEY,
      policyId: WRITER_POLICY,
      priority: 0,
    });
    await db.insert(agentRoles).values({
      siteId: SITE,
      name: AGENT_ROLE,
      description: 'R2 scope fixture',
      capabilities: ['items:read', 'items:write', 'items:update'],
    });

    const [collection] = await db
      .insert(collections)
      .values({ siteId: SITE, name: 'posts', label: 'Posts' })
      .returning();
    collectionId = collection!.id;
    await db.insert(fields).values(
      ['title', 'body'].map((name) => ({
        siteId: SITE,
        collectionId,
        name,
        type: 'string',
        interface: 'input',
      })),
    );
    const [item] = await db
      .insert(items)
      .values({ siteId: SITE, collectionId, data: { title: 'original', body: 'original' } })
      .returning();
    itemId = item!.id;
  });

  const keyRef = { type: 'api_key' as const, siteId: SITE, apiKeyId: KEY };

  async function grantFor(ref: Parameters<EffectiveCapabilityService['resolve']>[0]) {
    const grant = await new EffectiveCapabilityService({ db, siteId: SITE }).resolve(ref);
    expect(grant.allowed, 'fixture principal must resolve').toBe(true);
    return grant as Extract<typeof grant, { allowed: true }>;
  }

  /** A harness wired to a real ItemService bound to `grant`'s context. */
  function harnessFor(grant: Awaited<ReturnType<typeof grantFor>>) {
    return new AISecureHarness({
      db,
      siteId: SITE,
      schemaService: new SchemaService({ db, siteId: SITE }),
      itemService: itemServiceForPrincipal({ db, siteId: SITE }, grant.permissionContext!),
      enableAgentHarnessAudit: true,
    });
  }

  async function parkTitleUpdate() {
    const requester = await grantFor(keyRef);
    const parked = await harnessFor(requester).execute(
      'updateItem',
      { collection: 'posts', id: itemId, data: { title: 'approved-but-forbidden' } },
      requester.capabilities,
      'r2 scope fixture',
      {
        autonomyCap: 1,
        agentRole: AGENT_ROLE,
        requestedByPrincipal: { kind: 'principal', ref: keyRef } as never,
      },
    );
    expect(parked.status, 'L1 must park the write').toBe('pending_approval');
    return parked.approvalId!;
  }

  async function narrowUpdateToBody() {
    await db
      .update(permissions)
      .set({ fields: ['body'] })
      .where(and(eq(permissions.policyId, WRITER_POLICY), eq(permissions.action, 'update')));
  }

  async function titleNow(): Promise<unknown> {
    const [row] = await db.select().from(items).where(eq(items.id, itemId));
    return (row!.data as Record<string, unknown>)['title'];
  }

  it('refuses a field the requester lost after parking, and writes nothing', async () => {
    const legacyId = await parkTitleUpdate();
    await narrowUpdateToBody();

    // Control: the same restriction, exercised directly, is already in force.
    // Without this the test could pass because of an unrelated refusal.
    const narrowed = await grantFor(keyRef);
    await expect(
      itemServiceForPrincipal({ db, siteId: SITE }, narrowed.permissionContext!).patch(
        'posts',
        itemId,
        { data: { title: 'direct-forbidden' } },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const admin = await grantFor({ type: 'user', siteId: SITE, userId: ADMIN });
    const result = await harnessFor(admin).executeApproved(legacyId, ADMIN, admin.capabilities);

    expect(result.status, result.message ?? '').toBe('denied');
    expect(result.message ?? '', 'the reason names the field, not something vague').toMatch(/title/i);
    expect(await titleNow(), 'the forbidden field must be unchanged in the DB').toBe('original');
  });

  it('still executes what the requester IS allowed to write', async () => {
    // The refusal above must not be reachable by refusing everything: the same
    // narrowed key may still write `body`.
    const requester = await grantFor(keyRef);
    const parked = await harnessFor(requester).execute(
      'updateItem',
      { collection: 'posts', id: itemId, data: { body: 'approved-and-allowed' } },
      requester.capabilities,
      'r2 scope fixture',
      {
        autonomyCap: 1,
        agentRole: AGENT_ROLE,
        requestedByPrincipal: { kind: 'principal', ref: keyRef } as never,
      },
    );
    expect(parked.status).toBe('pending_approval');
    await narrowUpdateToBody();

    const admin = await grantFor({ type: 'user', siteId: SITE, userId: ADMIN });
    const result = await harnessFor(admin).executeApproved(
      parked.approvalId!,
      ADMIN,
      admin.capabilities,
    );

    expect(result.status, result.message ?? '').toBe('executed');
    const [row] = await db.select().from(items).where(eq(items.id, itemId));
    expect((row!.data as Record<string, unknown>)['body']).toBe('approved-and-allowed');
  });

  /**
   * Measured note: removing the scope rebinding leaves **this** case green,
   * because losing the `update` row also strips `items:update` from the
   * requester's capability set and the token intersection refuses first. Only the
   * field-mask case above discriminates. Kept anyway — it pins the coarse layer,
   * and the two together say which layer is doing the work.
   */
  it('does not leak the approver reach when the requester loses the collection entirely', async () => {
    const legacyId = await parkTitleUpdate();
    // Harsher than a field mask: the permission row is gone, so the requester has
    // no `update` on `posts` at all.
    await db
      .delete(permissions)
      .where(and(eq(permissions.policyId, WRITER_POLICY), eq(permissions.action, 'update')));

    const admin = await grantFor({ type: 'user', siteId: SITE, userId: ADMIN });
    const result = await harnessFor(admin).executeApproved(legacyId, ADMIN, admin.capabilities);

    expect(result.status).toBe('denied');
    expect(await titleNow()).toBe('original');
  });
});
