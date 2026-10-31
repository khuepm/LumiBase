import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  agentApprovals,
  agentAutonomyGrants,
  aiAutomationActions,
  collections,
  fields,
  items,
  revisions,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { AUTOMATION_AGENT } from '../ai-automation';
import { automationRuntimeFromEnv, reconcileAutomationAction, revertAutomationAction } from '../ai-automation-ops';
import { DrizzleAutomationActionStore, type AutomationActionInsert } from '../ai-automation-store';
import { AISecureHarness } from '../ai-harness';
import { EffectiveCapabilityService } from '../effective-capability-service';
import { resolvePrincipalCapabilities } from '../governed-capabilities';
import { itemServiceForPrincipal } from '../item-service-factory';
import { DrizzleReviewStore } from '../review-store';

/**
 * Migration 0021 against Postgres (#518): the table exists, the unique key
 * (site, flow run, node, item) backs idempotency, every store query is site
 * scoped, and a live proposal through the REAL governed harness is capped at
 * L1: with an L3 grant it parks an approval and writes nothing; once a human
 * approves, the write lands with agent provenance and revert restores the
 * previous value. Skips when DATABASE_URL is unset/unreachable.
 */

const SITE_A = 'site_automation_it_a';
const SITE_B = 'site_automation_it_b';
const ADMIN = 'usr_automation_it_admin';
const ADMIN_ROLE = 'role_automation_it_admin';

describe.skipIf(!hasDbIntegrationUrl)('Automation actions — DB integration', () => {
  let db: Database;
  let store: DrizzleAutomationActionStore;
  let itemId: string;
  let n = 0;
  const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(n += 1)}`;

  const action = (siteId: string, overrides: Partial<AutomationActionInsert> = {}): AutomationActionInsert => ({
    id: uid('act'),
    siteId,
    flowRunId: 'flow_run_1',
    nodeId: 'tag',
    reviewRunId: null,
    collection: 'posts',
    itemId: 'itm_1',
    action: 'tag',
    mode: 'shadow',
    status: 'recorded',
    principalType: 'user',
    principalId: ADMIN,
    ...overrides,
  });

  beforeAll(async () => {
    db = await connectDbIntegration('ai-automation-actions');
    store = new DrizzleAutomationActionStore(db);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(inArray(sites.id, [SITE_A, SITE_B])).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [SITE_A, SITE_B]));
    await db.delete(users).where(eq(users.id, ADMIN));
    await db.insert(sites).values([
      { id: SITE_A, name: 'Automation IT A' },
      { id: SITE_B, name: 'Automation IT B' },
    ]);
    await db.insert(users).values({ id: ADMIN, email: 'automation-it-admin@example.dev' });
    await db.insert(roles).values({ id: ADMIN_ROLE, siteId: SITE_A, name: 'Automation IT admin', adminAccess: true, appAccess: true });
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE_A, roleId: ADMIN_ROLE });
    const [collection] = await db.insert(collections).values({ siteId: SITE_A, name: 'posts', label: 'Posts' }).returning();
    await db.insert(fields).values([
      { siteId: SITE_A, collectionId: collection!.id, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE_A, collectionId: collection!.id, name: 'tags', type: 'json', interface: 'tags' },
    ]);
    const [item] = await db
      .insert(items)
      .values({ siteId: SITE_A, collectionId: collection!.id, data: { title: 'Tin nóng', tags: ['featured'] } })
      .returning();
    itemId = item!.id;
  });

  it('migration 0021 created the table and its unique index', async () => {
    const tables = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables WHERE table_name = 'lumibase_ai_automation_actions'`);
    const tableRows = Array.isArray(tables) ? tables : (tables as { rows: Array<{ table_name: string }> }).rows;
    expect(tableRows).toHaveLength(1);
    const indexes = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'lumibase_ai_automation_actions' ORDER BY indexname`);
    const names = (Array.isArray(indexes) ? indexes : (indexes as { rows: Array<{ indexname: string }> }).rows).map(
      (row) => row.indexname,
    );
    expect(names).toContain('ai_automation_actions_site_run_node_item_uq');
  });

  it('the unique key refuses a second row and the store returns the first', async () => {
    const first = await store.claim(action(SITE_A));
    const again = await store.claim(action(SITE_A, { status: 'pending', mode: 'live' }));
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, row: { id: first.row.id, status: 'recorded', mode: 'shadow' } });
    await expect(db.insert(aiAutomationActions).values(action(SITE_A))).rejects.toThrow();
    // Another site, node or item is a different action.
    expect((await store.claim(action(SITE_B))).created).toBe(true);
    expect((await store.claim(action(SITE_A, { nodeId: 'route' }))).created).toBe(true);
    expect((await store.claim(action(SITE_A, { itemId: 'itm_2' }))).created).toBe(true);
    const rows = await db.select().from(aiAutomationActions).where(eq(aiAutomationActions.siteId, SITE_A));
    expect(rows).toHaveLength(3);
  });

  it('a live row orphaned past the window is settled denied/orphaned on redelivery; a fresh one is left alone (B120)', async () => {
    const live = (overrides: Partial<AutomationActionInsert> = {}) =>
      action(SITE_A, { mode: 'live', status: 'pending', ...overrides });
    const { row: stuck } = await store.claim(live({ flowRunId: 'flow_run_old' }));
    await db
      .update(aiAutomationActions)
      .set({ createdAt: sql`now() - interval '10 minutes'` })
      .where(eq(aiAutomationActions.id, stuck.id));
    const { row: fresh } = await store.claim(live({ flowRunId: 'flow_run_new' }));
    const { row: parked } = await store.claim(live({ flowRunId: 'flow_run_parked' }));
    await db
      .update(aiAutomationActions)
      .set({ createdAt: sql`now() - interval '10 minutes'`, approvalId: 'apr_linked' })
      .where(eq(aiAutomationActions.id, parked.id));

    expect(await store.claim(live({ flowRunId: 'flow_run_old' }))).toMatchObject({
      created: false,
      row: { id: stuck.id, status: 'denied', reason: 'orphaned' },
    });
    // Within the window, or already linked to an approval: unchanged.
    expect(await store.claim(live({ flowRunId: 'flow_run_new' }))).toMatchObject({ created: false, row: { id: fresh.id, status: 'pending' } });
    expect(await store.claim(live({ flowRunId: 'flow_run_parked' }))).toMatchObject({
      created: false,
      row: { id: parked.id, status: 'pending', approvalId: 'apr_linked' },
    });
    // Another site's identical key is never touched.
    const { row: other } = await store.claim(action(SITE_B, { mode: 'live', status: 'pending', flowRunId: 'flow_run_old' }));
    await db.update(aiAutomationActions).set({ createdAt: sql`now() - interval '10 minutes'` }).where(eq(aiAutomationActions.id, other.id));
    expect((await store.get(SITE_B, other.id))?.status).toBe('pending');
  });

  it('every store query is site scoped', async () => {
    const a = await store.claim(action(SITE_A));
    expect(await store.get(SITE_B, a.row.id)).toBeNull();
    expect(await store.update(SITE_B, a.row.id, { status: 'applied' })).toBeNull();
    expect(await store.markReverted(SITE_B, a.row.id, 'x', new Date())).toBeNull();
    expect(await store.list(SITE_B, { limit: 10 })).toEqual([]);
    expect((await store.get(SITE_A, a.row.id))?.status).toBe('recorded');
  });

  it('keeps the action when the review run is purged (review_run_id → null)', async () => {
    const reviews = new DrizzleReviewStore(db);
    const profile = await reviews.insertFirstProfile({
      id: uid('rp'),
      siteId: SITE_A,
      collection: 'posts',
      key: 'taxonomy',
      version: 1,
      preset: null,
      fields: ['title'],
      questions: { category: { type: 'choice', instructions: 'Section?', criteria: { news: 'News' } } },
      sourceField: null,
      minConfidence: null,
      note: null,
      createdBy: ADMIN,
    });
    const { run } = await reviews.claimRun({
      id: uid('rr'),
      siteId: SITE_A,
      profileId: profile!.id,
      profileKey: 'taxonomy',
      profileVersion: 1,
      collection: 'posts',
      itemId,
      revisionId: null,
      contentHash: 'sha256:' + '0'.repeat(64),
      source: 'item',
      omittedFields: [],
      principalType: 'user',
      principalId: ADMIN,
      status: 'running',
      idempotencyKey: uid('idem'),
    });
    const { row } = await store.claim(action(SITE_A, { reviewRunId: run.id, questionKey: 'category' }));
    await db.execute(sql`DELETE FROM lumibase_review_runs WHERE id = ${run.id}`);
    expect((await store.get(SITE_A, row.id))?.reviewRunId).toBeNull();
  });

  it('a live proposal through the real harness is capped at L1, then approved, then reverted', async () => {
    // An L3 grant for the automation agent: without the cap this would execute.
    await db.insert(agentAutonomyGrants).values({ siteId: SITE_A, agentRole: AUTOMATION_AGENT, capability: 'items:update', level: 3 });
    const ref = { type: 'user' as const, siteId: SITE_A, userId: ADMIN };
    const runtime = automationRuntimeFromEnv({ db, siteId: SITE_A, runId: 'flow_run_1', principal: ref });
    const grant = await runtime.resolveGrant(ref);
    expect(grant.allowed, grant.message ?? '').toBe(true);

    const target = await runtime.readTarget(grant.permissionContext!, 'posts', itemId, 'tags');
    expect(target).toMatchObject({ readable: true, value: ['featured'], pinnedFields: [], editorialState: 'draft' });

    const { row } = await store.claim(
      action(SITE_A, {
        itemId,
        mode: 'live',
        status: 'pending',
        proposed: { field: 'tags', value: ['featured', 'news'], target: 'news', choice: 'news', targets: {} },
        previous: { field: 'tags', value: ['featured'] },
      }),
    );
    const result = await runtime.governedWrite(grant.permissionContext!, grant, ref, {
      collection: 'posts',
      itemId,
      data: { tags: ['featured', 'news'] },
      expect: { tags: ['featured'] },
      title: 'automation IT',
    });
    expect(result.status, result.message ?? '').toBe('pending_approval');
    const tagsNow = async () => ((await db.select().from(items).where(eq(items.id, itemId)))[0]!.data as Record<string, unknown>)['tags'];
    expect(await tagsNow(), 'no write before a human approves').toEqual(['featured']);
    const [approval] = await db.select().from(agentApprovals).where(eq(agentApprovals.id, result.agentApprovalId!));
    expect(approval).toMatchObject({ siteId: SITE_A, status: 'pending', requestedByAgent: AUTOMATION_AGENT });
    await store.update(SITE_A, row.id, { status: 'pending_approval', approvalId: result.agentApprovalId! });

    // A human approves through the existing decision path.
    const admin = await resolvePrincipalCapabilities(new EffectiveCapabilityService({ db, siteId: SITE_A }), ref);
    const harness = new AISecureHarness({
      db,
      siteId: SITE_A,
      itemService: itemServiceForPrincipal({ db, siteId: SITE_A }, admin.permissionContext!),
    });
    const executed = await harness.executeApproved(result.approvalId!, ADMIN, admin.capabilities);
    expect(executed.status, executed.message ?? '').toBe('executed');
    expect(await tagsNow()).toEqual(['featured', 'news']);
    const [revision] = await db
      .select()
      .from(revisions)
      .where(and(eq(revisions.siteId, SITE_A), eq(revisions.itemId, itemId)))
      .orderBy(sql`${revisions.createdAt} desc`)
      .limit(1);
    expect(revision?.authorType, 'the revision carries agent provenance').toBe('agent');

    const reconciled = await reconcileAutomationAction(store, (await store.get(SITE_A, row.id))!);
    expect(reconciled).toMatchObject({ status: 'applied', applied: true });

    const items_ = itemServiceForPrincipal({ db, siteId: SITE_A }, admin.permissionContext!);
    await revertAutomationAction(
      {
        store,
        siteId: SITE_A,
        readField: async (collection, id, field) => ((await items_.detail(collection, id, [field])) as Record<string, unknown>)[field],
        writeField: async (collection, id, field, value) => {
          await items_.patch(collection, id, { data: { [field]: value } });
        },
      },
      row.id,
      ADMIN,
    );
    expect(await tagsNow()).toEqual(['featured']);
    expect((await store.get(SITE_A, row.id))?.status).toBe('reverted');
  });

  it('an approval that runs after a human changed the field writes nothing (B119)', async () => {
    await db.insert(agentAutonomyGrants).values({ siteId: SITE_A, agentRole: AUTOMATION_AGENT, capability: 'items:update', level: 3 });
    const ref = { type: 'user' as const, siteId: SITE_A, userId: ADMIN };
    const runtime = automationRuntimeFromEnv({ db, siteId: SITE_A, runId: 'flow_run_1', principal: ref });
    const grant = await runtime.resolveGrant(ref);
    const { row } = await store.claim(
      action(SITE_A, {
        itemId,
        mode: 'live',
        status: 'pending',
        proposed: { field: 'tags', value: ['featured', 'news'], target: 'news', choice: 'news', targets: {} },
        previous: { field: 'tags', value: ['featured'] },
      }),
    );
    const result = await runtime.governedWrite(grant.permissionContext!, grant, ref, {
      collection: 'posts',
      itemId,
      data: { tags: ['featured', 'news'] },
      expect: { tags: ['featured'] },
      title: 'automation IT',
    });
    expect(result.status, result.message ?? '').toBe('pending_approval');
    await store.update(SITE_A, row.id, { status: 'pending_approval', approvalId: result.agentApprovalId! });

    // A human edits the tags while the proposal waits for approval.
    const admin = await resolvePrincipalCapabilities(new EffectiveCapabilityService({ db, siteId: SITE_A }), ref);
    const human = itemServiceForPrincipal({ db, siteId: SITE_A }, admin.permissionContext!);
    await human.patch('posts', itemId, { data: { tags: ['opinion'] } });

    const harness = new AISecureHarness({ db, siteId: SITE_A, itemService: itemServiceForPrincipal({ db, siteId: SITE_A }, admin.permissionContext!) });
    const executed = await harness.executeApproved(result.approvalId!, ADMIN, admin.capabilities);
    expect(executed).toMatchObject({ status: 'denied', code: 'ITEM_PRECONDITION_FAILED' });
    const tags = ((await db.select().from(items).where(eq(items.id, itemId)))[0]!.data as Record<string, unknown>)['tags'];
    expect(tags, "the human's edit is kept").toEqual(['opinion']);

    const [approval] = await db.select().from(agentApprovals).where(eq(agentApprovals.id, result.agentApprovalId!));
    expect(approval?.status).toBe('failed');
    expect(approval?.decisionReason).toMatch(/^ITEM_PRECONDITION_FAILED: tags changed since this update was proposed/);
    const reconciled = await reconcileAutomationAction(store, (await store.get(SITE_A, row.id))!);
    expect(reconciled).toMatchObject({ status: 'denied', reason: 'stale_at_approval', applied: false });
  });
});
