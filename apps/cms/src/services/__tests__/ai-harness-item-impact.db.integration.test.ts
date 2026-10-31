import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentApprovals,
  agentToolCalls,
  aiApprovals,
  collections,
  fields,
  items,
  roles,
  settings,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { AISecureHarness } from '../ai-harness';
import { AgentRunService } from '../agent-run-service';
import { AutonomyService } from '../autonomy-service';
import { EffectiveCapabilityService } from '../effective-capability-service';
import { itemServiceForPrincipal } from '../item-service-factory';
import { ItemServiceError } from '../item-service';
import { KillSwitchService } from '../kill-switch-service';
import { SchemaService } from '../schema-service';

/**
 * Impact-aware risk for item writes, and the approval controls around them (#578).
 *
 * ## What was wrong (measured at b12e9385, before the fix)
 *
 * `evaluateRisk` classified by tool name and capability. `createItem` and
 * `updateItem` carry `items:write` / `items:update`, so they were "safe" and, at
 * the default level for a safe capability (L2), executed directly. An agent could
 * therefore create an item with `status: 'published'`, publish a draft, or rewrite
 * the body of a live item without any approval, while an edit to a draft went
 * through the same path. Separately, `ItemService.create` skipped the editorial
 * gate that `patch` enforces, so on an `editorialWorkflow` collection creating an
 * item as `published` bypassed review entirely (also for REST callers).
 *
 * ## The rule under test
 *
 * - Draft-only writes keep their behaviour (L2 executes, L1 parks, L0 refuses).
 * - Writes that change publication status, or patch a published item, go through
 *   the dangerous gradient: L1/L2 park for approval, L3 stages data patches in the
 *   veto window, L4 executes.
 * - The approval executes exactly the stored arguments, once; rejection, expiry,
 *   cancellation and the kill switch all leave the item untouched; pinned fields
 *   refuse agent writes.
 *
 * ## Evidence class
 *
 * REAL PostgreSQL and a REAL `ItemService` bound to a resolved principal. Every
 * assertion about side effects reads the `items` row back. No network, no LLM.
 */
const SITE = 'site_578_impact';
const ADMIN = 'usr_578_admin';
const ADMIN_ROLE = 'role_578_admin';
const AGENT = 'audit-578-agent';

describe.skipIf(!hasDbIntegrationUrl)('#578 impact-aware item risk — DB integration', () => {
  let db: Database;
  let collectionId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('ai-harness-item-impact');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(users).where(eq(users.id, ADMIN));
    await db.insert(sites).values({ id: SITE, name: '578 impact' });
    await db.insert(users).values({ id: ADMIN, email: 'audit-578-admin@example.dev' });
    await db.insert(roles).values({
      id: ADMIN_ROLE,
      siteId: SITE,
      name: '578 Administrator',
      adminAccess: true,
      appAccess: true,
    });
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: ADMIN_ROLE });
    const [collection] = await db
      .insert(collections)
      .values({ siteId: SITE, name: 'posts', label: 'Posts' })
      .returning();
    collectionId = collection!.id;
    await db.insert(fields).values(
      ['title', 'price'].map((name) => ({
        siteId: SITE,
        collectionId,
        name,
        type: 'string',
        interface: 'input',
      })),
    );
  });

  const adminRef = { type: 'user' as const, siteId: SITE, userId: ADMIN };

  async function adminGrant() {
    const grant = await new EffectiveCapabilityService({ db, siteId: SITE }).resolve(adminRef);
    expect(grant.allowed, 'fixture principal must resolve').toBe(true);
    return grant as Extract<typeof grant, { allowed: true }>;
  }

  async function harness() {
    const grant = await adminGrant();
    return {
      grant,
      harness: new AISecureHarness({
        db,
        siteId: SITE,
        schemaService: new SchemaService({ db, siteId: SITE }),
        itemService: itemServiceForPrincipal({ db, siteId: SITE, userId: ADMIN }, grant.permissionContext!),
        enableAgentHarnessAudit: true,
      }),
    };
  }

  const envelope = (extra: Record<string, unknown> = {}) => ({
    agentName: AGENT,
    requestedByPrincipal: { kind: 'principal', ref: adminRef } as never,
    ...extra,
  });

  async function seedItem(status: 'draft' | 'published', data: Record<string, unknown> = { title: 'v1', price: '10' }) {
    const [row] = await db.insert(items).values({ siteId: SITE, collectionId, status, data }).returning();
    return row!.id;
  }

  async function itemRow(id: string) {
    const [row] = await db.select().from(items).where(eq(items.id, id));
    return row!;
  }

  async function itemCount() {
    const rows = await db.select({ id: items.id }).from(items).where(eq(items.siteId, SITE));
    return rows.length;
  }

  async function exec(skill: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const { harness: h, grant } = await harness();
    return h.execute(skill, args, grant.capabilities, `#578 ${skill}`, envelope(extra));
  }

  async function approve(approvalId: string) {
    const { harness: h, grant } = await harness();
    return h.executeApproved(approvalId, ADMIN, grant.capabilities);
  }

  async function riskReasonOf(toolCallId: string | undefined) {
    const [call] = await db.select().from(agentToolCalls).where(eq(agentToolCalls.id, toolCallId!));
    return (call!.output as Record<string, unknown> | null)?.['riskReason'];
  }

  // ── Classification matrix ────────────────────────────────────────────────

  it('a draft create still executes at the default level', async () => {
    const result = await exec('createItem', { collection: 'posts', data: { title: 'draft' } });
    expect(result.status).toBe('executed');
    expect(await itemCount()).toBe(1);
  });

  it('a create with status published parks for approval and writes nothing', async () => {
    const result = await exec('createItem', { collection: 'posts', data: { title: 'live' }, status: 'published' });
    expect(result.status).toBe('pending_approval');
    expect(await itemCount()).toBe(0);
    expect(await riskReasonOf(result.toolCallId)).toBe('publication_change');
    const [approval] = await db
      .select()
      .from(agentApprovals)
      .where(eq(agentApprovals.id, result.agentApprovalId!));
    expect(approval!.approvalPolicy).toBe('before_execute');
  });

  it('a data patch on a draft still executes at the default level', async () => {
    const id = await seedItem('draft');
    const result = await exec('updateItem', { collection: 'posts', id, data: { price: '0' } });
    expect(result.status).toBe('executed');
    expect((await itemRow(id)).data).toMatchObject({ price: '0' });
  });

  it('a data patch on a published item parks for approval and leaves the live value', async () => {
    const id = await seedItem('published');
    const result = await exec('updateItem', { collection: 'posts', id, data: { price: '0' } });
    expect(result.status).toBe('pending_approval');
    expect(await riskReasonOf(result.toolCallId)).toBe('live_content');
    expect((await itemRow(id)).data).toMatchObject({ price: '10' });
  });

  it('publishing a draft parks for approval', async () => {
    const id = await seedItem('draft');
    const result = await exec('updateItem', { collection: 'posts', id, data: { title: 'v2' }, status: 'published' });
    expect(result.status).toBe('pending_approval');
    expect(await riskReasonOf(result.toolCallId)).toBe('publication_change');
    const row = await itemRow(id);
    expect(row.status).toBe('draft');
    expect(row.data).toMatchObject({ title: 'v1' });
  });

  it('unpublishing a live item parks for approval', async () => {
    const id = await seedItem('published');
    const result = await exec('updateItem', { collection: 'posts', id, data: { title: 'v1' }, status: 'draft' });
    expect(result.status).toBe('pending_approval');
    expect((await itemRow(id)).status).toBe('published');
  });

  it('an L1 intent cap still parks a plain draft write (unchanged)', async () => {
    const result = await exec('createItem', { collection: 'posts', data: { title: 'draft' } }, { autonomyCap: 1 });
    expect(result.status).toBe('pending_approval');
    expect(await itemCount()).toBe(0);
  });

  it('an L0 intent cap refuses a publish outright', async () => {
    const id = await seedItem('draft');
    const result = await exec(
      'updateItem',
      { collection: 'posts', id, data: { title: 'v2' }, status: 'published' },
      { autonomyCap: 0 },
    );
    // L0 means no side effects: not executed and not parked as an approval.
    expect(result).toMatchObject({ status: 'denied', code: 'AUTONOMY_SHADOW' });
    expect((await itemRow(id)).status).toBe('draft');
    const parked = await db.select().from(agentApprovals).where(eq(agentApprovals.siteId, SITE));
    expect(parked).toHaveLength(0);
  });

  it('an L0 intent cap refuses a dangerous skill instead of parking it', async () => {
    // Before #578 the dangerous branch had no L0 case and parked an approval,
    // so a human could still release a delete that L0 promises never happens.
    const id = await seedItem('draft');
    const result = await exec('deleteItem', { collection: 'posts', id }, { autonomyCap: 0 });
    expect(result).toMatchObject({ status: 'denied', code: 'AUTONOMY_SHADOW' });
    expect((await itemRow(id)).deletedAt).toBeNull();
    const parked = await db.select().from(agentApprovals).where(eq(agentApprovals.siteId, SITE));
    expect(parked).toHaveLength(0);
  });

  it('a delete at the default level parks for approval (unchanged)', async () => {
    const id = await seedItem('draft');
    const result = await exec('deleteItem', { collection: 'posts', id });
    expect(result.status).toBe('pending_approval');
    expect((await itemRow(id)).deletedAt).toBeNull();
  });

  it('an L4 grant publishes directly, within the gradient', async () => {
    await new AutonomyService({ db, siteId: SITE }).setGrant(AGENT, 'items:update', 4);
    const id = await seedItem('draft');
    const result = await exec('updateItem', { collection: 'posts', id, data: { title: 'v2' }, status: 'published' });
    expect(result.status).toBe('executed');
    expect((await itemRow(id)).status).toBe('published');
  });

  it('an L3 grant with the veto window stages a live data patch instead of writing it', async () => {
    await new AutonomyService({ db, siteId: SITE }).setGrant(AGENT, 'items:update', 3);
    await db.insert(settings).values({ siteId: SITE, key: 'contentOs', value: { vetoWindow: true } });
    const id = await seedItem('published');
    const result = await exec('updateItem', { collection: 'posts', id, data: { price: '0' } });
    expect(result.status).toBe('pending_approval');
    expect(result.message).toMatch(/^Staged; auto-commits at /);
    expect((await itemRow(id)).data).toMatchObject({ price: '10' });
  });

  it('a pinned field refuses an agent write even on a draft', async () => {
    const id = await seedItem('draft');
    await db.update(items).set({ pinnedFields: ['price'] }).where(eq(items.id, id));
    const result = await exec('updateItem', { collection: 'posts', id, data: { price: '0' } });
    expect(result.status).toBe('denied');
    expect(result.message).toMatch(/pinned by a human/);
    expect((await itemRow(id)).data).toMatchObject({ price: '10' });
  });

  // ── Approval binding and lifecycle ───────────────────────────────────────

  async function parkLivePatch(price = '0') {
    const id = await seedItem('published');
    const parked = await exec('updateItem', { collection: 'posts', id, data: { price } });
    expect(parked.status).toBe('pending_approval');
    return { id, parked };
  }

  it('approval executes the stored arguments exactly once', async () => {
    const { id, parked } = await parkLivePatch('0');
    const first = await approve(parked.approvalId!);
    expect(first.status).toBe('executed');
    expect((await itemRow(id)).data).toMatchObject({ price: '0' });

    // Move the value on, then try to replay the same approval.
    await db.update(items).set({ data: { title: 'v1', price: '99' } }).where(eq(items.id, id));
    const second = await approve(parked.approvalId!);
    expect(second.status).toBe('denied');
    expect((await itemRow(id)).data).toMatchObject({ price: '99' });
  });

  it('a stored payload altered to break the contract is refused at execution', async () => {
    const { id, parked } = await parkLivePatch('0');
    await db
      .update(aiApprovals)
      .set({ arguments: { collection: 'posts', id, data: { price: '0' }, injected: true } })
      .where(eq(aiApprovals.id, parked.approvalId!));
    const result = await approve(parked.approvalId!);
    expect(result.status).not.toBe('executed');
    expect((await itemRow(id)).data).toMatchObject({ price: '10' });
  });

  it('a rejected approval cannot be approved afterwards', async () => {
    const { id, parked } = await parkLivePatch('0');
    const { harness: h } = await harness();
    expect(await h.rejectApproval(parked.approvalId!, ADMIN)).toBeTruthy();
    const result = await approve(parked.approvalId!);
    expect(result.status).toBe('denied');
    expect((await itemRow(id)).data).toMatchObject({ price: '10' });
  });

  it('an expired approval is refused and writes nothing', async () => {
    const { id, parked } = await parkLivePatch('0');
    await db
      .update(agentApprovals)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(agentApprovals.id, parked.agentApprovalId!));
    const result = await approve(parked.approvalId!);
    expect(result).toMatchObject({ status: 'denied', message: 'Approval expired' });
    expect((await itemRow(id)).data).toMatchObject({ price: '10' });
  });

  it('a cancelled run is not resumed by a late approval', async () => {
    const { id, parked } = await parkLivePatch('0');
    await new AgentRunService(db, SITE).cancelRun(parked.runId!);
    const result = await approve(parked.approvalId!);
    expect(result.status).toBe('denied');
    expect((await itemRow(id)).data).toMatchObject({ price: '10' });
  });

  it('the kill switch blocks both new writes and approved execution', async () => {
    const { id, parked } = await parkLivePatch('0');
    await new KillSwitchService({ db, siteId: SITE }).freeze('site', { reason: '#578', actor: ADMIN });

    const approved = await approve(parked.approvalId!);
    expect(approved.status).toBe('denied');
    expect(approved.message).toMatch(/^frozen:/);
    expect((await itemRow(id)).data).toMatchObject({ price: '10' });

    const fresh = await exec('createItem', { collection: 'posts', data: { title: 'draft' } });
    expect(fresh.status).toBe('denied');
    expect(await itemCount()).toBe(1);

    // The approval is still pending, so lifting the freeze lets it run once.
    const [row] = await db
      .select({ status: agentApprovals.status })
      .from(agentApprovals)
      .where(and(eq(agentApprovals.id, parked.agentApprovalId!), eq(agentApprovals.siteId, SITE)));
    expect(row!.status).toBe('pending');
  });

  // ── Editorial gate on create (REST and agent share ItemService) ──────────

  it('creating a published item on an editorial collection is refused', async () => {
    await db
      .update(collections)
      .set({ meta: sql`jsonb_build_object('editorialWorkflow', true)` })
      .where(eq(collections.id, collectionId));
    const grant = await adminGrant();
    const service = itemServiceForPrincipal({ db, siteId: SITE, userId: ADMIN }, grant.permissionContext!);
    await expect(service.create('posts', { data: { title: 'x' }, status: 'published' })).rejects.toMatchObject({
      code: 'EDITORIAL_GATE_REQUIRED',
    } satisfies Partial<ItemServiceError>);
    expect(await itemCount()).toBe(0);
    // A draft create on the same collection is unaffected.
    await service.create('posts', { data: { title: 'x' } });
    expect(await itemCount()).toBe(1);
  });
});
