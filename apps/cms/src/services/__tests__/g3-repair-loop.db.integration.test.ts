import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentApprovals,
  agentGoals,
  agentRuns,
  aiApprovals,
  collections,
  contentDrifts,
  contentIntents,
  contentVersions,
  fields,
  items,
  settings,
  sites,
  users,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { CONTENT_OS_SETTINGS_KEY } from '../feature-flags';

/**
 * G3 (#455) — the reconciler repair loop, end to end on real PostgreSQL.
 *
 * ## What was broken
 *
 * `ReconcilerService` created a goal and flipped the drift to `assigned`, and
 * that was the end of the chain. Measured before this change: after one
 * reconcile plus three further cycles, `agent_runs` was empty, the drift stayed
 * `assigned` with its `goalId` set, and the item still had no translation. That
 * is worse than inaction, because `planReconciliation` skips drifts that already
 * carry a `goalId` — the unexecutable goal locked the drift out of every later
 * cycle.
 *
 * ## What is real here, and what is not
 *
 * Real: PostgreSQL (schema, FKs, drift fingerprint uniqueness), `DriftService`,
 * `ReconcilerService`, `GoalDispatchService`, `processAgentRunJob` (the exact
 * function the queue consumer calls), `AISecureHarness` including its
 * write/autonomy gate and HITL parking, `AgentRunService`,
 * `ContentVersionService`, `ItemService.patch` for the publish, and the
 * post-publish re-scan.
 *
 * Mocked, deliberately and narrowly:
 *
 * - **The LLM provider.** `createConfiguredLLMProvider` is replaced with a
 *   deterministic translator stub. Calling a real provider would spend money on
 *   every CI run and make the assertions non-deterministic; #455 explicitly
 *   forbids provider spend. The stub also counts calls, which is how the
 *   idempotency assertion proves a duplicate delivery does not re-translate.
 * - **The queue transport.** Jobs are collected in memory and handed to
 *   `processAgentRunJob` directly, rather than round-tripping through
 *   BullMQ/Redis. The payload contract and the consumer entrypoint are real; the
 *   broker is not. Cloudflare Workers has no `queue()` consumer export at all
 *   (backlog B10), so async runs are Node/Docker-only — this suite does not
 *   claim Cloudflare parity.
 * - **The approval decision is taken at the service layer** via
 *   `harness.executeApproved`, not through the HTTP route. The approval record,
 *   the claim and the post-approval execution are the real #453 implementation.
 *
 * **Validates: #455 acceptance — traceable repair goal/run, payload governance
 * fields, cross-tenant + over-cap denial, idempotency under repeat/duplicate
 * delivery, approval-gated publish, verified re-evaluation, actionable failure
 * states**
 */

const SITE = 'site_g3_loop';
const OTHER_SITE = 'site_g3_other';
const ADMIN = 'usr_g3_admin';
const COLLECTION = 'articles';
const TRANSLATED = 'Xin chào thế giới';

/** Counts provider calls so "did not re-translate" is measured, not assumed. */
const llmStub = vi.hoisted(() => {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    calls,
    /** Flipped off to reproduce "no provider configured" without module surgery. */
    available: true,
    configured: {
      name: 'stub',
      model: 'stub-translator',
      provider: {
        chat: async (messages: Array<{ role: string; content: string }>) => {
          calls.push({
            system: messages[0]?.content ?? '',
            user: messages[1]?.content ?? '',
          });
          return { content: JSON.stringify({ translation: 'Xin chào thế giới' }) };
        },
      },
    },
  };
});

vi.mock('../llm-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm-provider')>();
  return {
    ...actual,
    createConfiguredLLMProvider: () => (llmStub.available ? llmStub.configured : null),
  };
});

interface CapturedJob {
  queue: string;
  name: string;
  payload: Record<string, unknown>;
}

function memoryQueue() {
  const jobs: CapturedJob[] = [];
  let failNext = false;
  return {
    jobs,
    failNextEnqueue() {
      failNext = true;
    },
    provider: {
      enqueue: async (queue: string, name: string, payload: unknown) => {
        if (failNext) {
          failNext = false;
          throw new Error('broker unreachable');
        }
        jobs.push({ queue, name, payload: payload as Record<string, unknown> });
      },
      process: () => undefined,
    } as never,
  };
}

describe.skipIf(!hasDbIntegrationUrl)('G3 reconciler repair loop — DB integration', () => {
  let db: Database;
  let collectionId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('g3-repair-loop');
    await db.insert(users).values({ id: ADMIN, email: 'g3@example.dev' }).onConflictDoNothing();
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
    llmStub.calls.length = 0;
    await db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER_SITE})`);
    await db.insert(sites).values([
      { id: SITE, name: 'G3 loop' },
      { id: OTHER_SITE, name: 'G3 other tenant' },
    ]);
    for (const siteId of [SITE, OTHER_SITE]) {
      const [coll] = await db
        .insert(collections)
        .values({ siteId, name: COLLECTION, label: 'Articles' })
        .returning({ id: collections.id });
      await db.insert(fields).values([
        { siteId, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' },
        { siteId, collectionId: coll!.id, name: 'translations', type: 'json', interface: 'input' },
      ]);
      await db.insert(settings).values({
        siteId,
        key: CONTENT_OS_SETTINGS_KEY,
        value: { reconciler: true },
        scope: 'site',
      });
      if (siteId === SITE) collectionId = coll!.id;
    }
  });

  /** Seeds an active translations intent plus one item missing the `vi` locale. */
  async function seedMissingTranslation(
    siteId: string,
    collId: string,
    autonomyCap = 2,
  ): Promise<{ intentId: string; itemId: string }> {
    const [intent] = await db
      .insert(contentIntents)
      .values({
        siteId,
        name: 'articles-translations',
        collection: COLLECTION,
        rules: [{ type: 'translations', fields: ['translations'], locales: ['en', 'vi'] }],
        schedule: '0 * * * *',
        budget: { maxGoalsPerCycle: 10 },
        autonomyCap,
        status: 'active',
      })
      .returning({ id: contentIntents.id });
    const [item] = await db
      .insert(items)
      .values({
        siteId,
        collectionId: collId,
        status: 'published',
        data: { title: 'Hello', translations: { en: 'Hello world' } },
      })
      .returning({ id: items.id });
    return { intentId: intent!.id, itemId: item!.id };
  }

  async function scanAndReconcile(siteId: string, intentId: string) {
    const { DriftService } = await import('../drift-service');
    const { ReconcilerService } = await import('../reconciler-service');
    const deps = { db, siteId };
    const scan = await new DriftService(deps).scanIntent(intentId);
    const reconcile = await new ReconcilerService(deps).reconcileIntent(intentId);
    return { scan, reconcile };
  }

  async function dispatcherFor(siteId: string, queue?: never) {
    const { GoalDispatchService } = await import('../goal-dispatch-service');
    return new GoalDispatchService({ db, siteId, ...(queue ? { queue } : {}) });
  }

  /** Runs one captured job through the real consumer entrypoint. */
  async function runJob(job: CapturedJob, env: Record<string, string | undefined> = {}) {
    const { processAgentRunJob } = await import('../agent-run-worker');
    await processAgentRunJob({ db, env }, job.payload as never);
  }

  /** Harness shaped like the worker's, used to take the approval decision. */
  async function harnessForApproval(siteId: string) {
    const { AISecureHarness } = await import('../ai-harness');
    const { SchemaService } = await import('../schema-service');
    const { itemServiceForSystem } = await import('../item-service-factory');
    const { createConfiguredLLMProvider } = await import('../llm-provider');
    return new AISecureHarness({
      db,
      siteId,
      schemaService: new SchemaService({ db, siteId }),
      itemService: itemServiceForSystem({ db, siteId, userId: null }, 'background-worker'),
      llm: createConfiguredLLMProvider({}),
      enableAgentHarnessAudit: true,
    });
  }

  async function liveTranslations(itemId: string): Promise<Record<string, unknown>> {
    const [row] = await db.select().from(items).where(eq(items.id, itemId));
    return ((row!.data as Record<string, unknown>)['translations'] ?? {}) as Record<string, unknown>;
  }

  async function goalRow(siteId: string) {
    const [goal] = await db
      .select()
      .from(agentGoals)
      .where(and(eq(agentGoals.siteId, siteId), eq(agentGoals.origin, 'reconciler')))
      .limit(1);
    return goal!;
  }

  it('drives intent → drift → goal → draft → approval → publish → verified resolution', async () => {
    const queue = memoryQueue();
    const { intentId, itemId } = await seedMissingTranslation(SITE, collectionId);

    const { reconcile } = await scanAndReconcile(SITE, intentId);
    expect(reconcile.goalsCreated).toBe(1);

    const [drift] = await db
      .select()
      .from(contentDrifts)
      .where(and(eq(contentDrifts.siteId, SITE), eq(contentDrifts.intentId, intentId)));
    expect(drift!.ruleKey).toBe('translations:vi');

    // ── Phase 1: dispatch the draft ────────────────────────────────────────
    const dispatcher = await dispatcherFor(SITE, queue.provider);
    const first = await dispatcher.dispatchReconcilerGoals();
    expect(first.dispatched).toBe(1);
    expect(queue.jobs).toHaveLength(1);

    // The governance envelope must survive the queue hop, or the intent's
    // autonomy ceiling is enforced nowhere at execution time.
    const draftJob = queue.jobs[0]!;
    expect(draftJob.queue).toBe('agent-runs');
    expect(draftJob.payload).toMatchObject({
      siteId: SITE,
      skillName: 'repairTranslation',
      origin: 'reconciler',
      intentId,
      driftFingerprint: drift!.fingerprint,
      autonomyCap: 2,
      agentRole: 'translator',
    });
    expect(draftJob.payload['arguments']).toMatchObject({
      collection: COLLECTION,
      itemId,
      field: 'translations',
      locale: 'vi',
    });
    // No capability snapshot rides along: the worker re-resolves from the role.
    expect(draftJob.payload['capabilities']).toBeUndefined();

    const draftRunId = draftJob.payload['runId'] as string;
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, draftRunId)))[0]!.status).toBe(
      'queued',
    );

    // ── Phase 1 execution: the draft lands in a version branch, not on main ──
    await runJob(draftJob);
    const [draftRun] = await db.select().from(agentRuns).where(eq(agentRuns.id, draftRunId));
    expect(draftRun!.status).toBe('succeeded');
    expect(llmStub.calls).toHaveLength(1);

    const versions = await db
      .select()
      .from(contentVersions)
      .where(and(eq(contentVersions.siteId, SITE), eq(contentVersions.itemId, itemId)));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.key).toBe(`drift-repair:${drift!.fingerprint}`);
    expect((versions[0]!.data as Record<string, Record<string, string>>)['translations']).toEqual({
      en: 'Hello world',
      vi: TRANSLATED,
    });
    // Published content is untouched until a human approves.
    expect(await liveTranslations(itemId)).toEqual({ en: 'Hello world' });

    // ── Phase 2: dispatch the promote, which parks for human approval ───────
    const second = await dispatcher.dispatchReconcilerGoals();
    expect(second.dispatched).toBe(1);
    expect(queue.jobs).toHaveLength(2);
    const promoteJob = queue.jobs[1]!;
    expect(promoteJob.payload).toMatchObject({
      skillName: 'promoteVersion',
      intentId,
      driftFingerprint: drift!.fingerprint,
      autonomyCap: 2,
    });

    await runJob(promoteJob);
    const promoteRunId = promoteJob.payload['runId'] as string;
    const [promoteRun] = await db.select().from(agentRuns).where(eq(agentRuns.id, promoteRunId));
    expect(promoteRun!.status).toBe('awaiting_approval');
    // Still nothing published: parking is not publishing.
    expect(await liveTranslations(itemId)).toEqual({ en: 'Hello world' });

    const [pending] = await db
      .select()
      .from(aiApprovals)
      .where(and(eq(aiApprovals.siteId, SITE), eq(aiApprovals.status, 'pending')));
    expect(pending!.skillName).toBe('promoteVersion');
    const [approvalRow] = await db
      .select()
      .from(agentApprovals)
      .where(and(eq(agentApprovals.siteId, SITE), eq(agentApprovals.status, 'pending')));
    expect(approvalRow!.runId).toBe(promoteRunId);

    // A goal awaiting a human is skipped, not re-dispatched.
    const whileWaiting = await dispatcher.dispatchReconcilerGoals();
    expect(whileWaiting.dispatched).toBe(0);
    expect(whileWaiting.skipped).toBe(1);
    expect(queue.jobs).toHaveLength(2);

    // ── Phase 3: human approves → publish through the content API ───────────
    const harness = await harnessForApproval(SITE);
    const decision = await harness.executeApproved(pending!.id, ADMIN, [
      'items:read',
      'items:write',
      'translations:write',
    ]);
    expect(decision.status).toBe('executed');
    expect(await liveTranslations(itemId)).toEqual({ en: 'Hello world', vi: TRANSLATED });
    // Promote consumes the branch.
    expect(
      await db
        .select()
        .from(contentVersions)
        .where(and(eq(contentVersions.siteId, SITE), eq(contentVersions.itemId, itemId))),
    ).toHaveLength(0);

    // ── Phase 4: only a verified re-evaluation resolves the drift ───────────
    const third = await dispatcher.dispatchReconcilerGoals();
    expect(third.completed).toBe(1);

    const [finalDrift] = await db
      .select()
      .from(contentDrifts)
      .where(eq(contentDrifts.id, drift!.id));
    expect(finalDrift!.status).toBe('resolved');
    expect((await goalRow(SITE)).status).toBe('done');

    // Steady state: further passes do nothing and enqueue nothing.
    const fourth = await dispatcher.dispatchReconcilerGoals();
    expect(fourth).toMatchObject({ dispatched: 0, completed: 0 });
    expect(queue.jobs).toHaveLength(2);
    expect(llmStub.calls).toHaveLength(1);
  });

  it('a duplicate delivery of the same job is stopped by the run state machine', async () => {
    // At-least-once delivery is the queue's contract. The first defence is
    // `markRunning`, which refuses a run already in a terminal state — so the
    // second delivery returns before the harness, the skill or the provider is
    // reached. Measured, not assumed: the provider call count stays at one.
    const queue = memoryQueue();
    const { intentId, itemId } = await seedMissingTranslation(SITE, collectionId);
    await scanAndReconcile(SITE, intentId);
    const dispatcher = await dispatcherFor(SITE, queue.provider);
    await dispatcher.dispatchReconcilerGoals();

    const job = queue.jobs[0]!;
    await runJob(job);
    await runJob(job);

    expect(llmStub.calls).toHaveLength(1);
    expect(
      await db
        .select()
        .from(contentVersions)
        .where(and(eq(contentVersions.siteId, SITE), eq(contentVersions.itemId, itemId))),
    ).toHaveLength(1);
  });

  it('a fresh run for the same drift reuses the existing draft instead of re-translating', async () => {
    // The second defence, and the one the run state machine cannot provide: a
    // *new* run for the same drift (an operator retry, or a redelivery after the
    // phase was reset) passes `markRunning` because its run row is `queued`.
    // Without the branch-exists check in `repairTranslation` this would spend a
    // second provider call and then fail on the duplicate version key.
    const queue = memoryQueue();
    const { intentId, itemId } = await seedMissingTranslation(SITE, collectionId);
    await scanAndReconcile(SITE, intentId);
    const dispatcher = await dispatcherFor(SITE, queue.provider);
    await dispatcher.dispatchReconcilerGoals();

    const job = queue.jobs[0]!;
    await runJob(job);
    expect(llmStub.calls).toHaveLength(1);

    const { AgentRunService } = await import('../agent-run-service');
    const retry = await new AgentRunService(db, SITE).ensureRun({
      goalId: job.payload['goalId'] as string,
      agentName: 'translator',
      status: 'queued',
    });
    await runJob({ ...job, payload: { ...job.payload, runId: retry.runId } });

    const [retryRun] = await db.select().from(agentRuns).where(eq(agentRuns.id, retry.runId));
    expect(retryRun!.status).toBe('succeeded');
    // No second provider call, and still exactly one draft branch.
    expect(llmStub.calls).toHaveLength(1);
    expect(
      await db
        .select()
        .from(contentVersions)
        .where(and(eq(contentVersions.siteId, SITE), eq(contentVersions.itemId, itemId))),
    ).toHaveLength(1);
  });

  it('repeated reconcile + dispatch passes create exactly one run per phase', async () => {
    const queue = memoryQueue();
    const { intentId } = await seedMissingTranslation(SITE, collectionId);
    const dispatcher = await dispatcherFor(SITE, queue.provider);

    for (let i = 0; i < 3; i++) {
      await scanAndReconcile(SITE, intentId);
      await dispatcher.dispatchReconcilerGoals();
    }

    expect(await db.select().from(agentGoals).where(eq(agentGoals.siteId, SITE))).toHaveLength(1);
    expect(queue.jobs).toHaveLength(1);
    expect(await db.select().from(agentRuns).where(eq(agentRuns.siteId, SITE))).toHaveLength(1);
  });

  it('an over-cap intent parks the draft for approval instead of writing it', async () => {
    // autonomyCap 1 (PROPOSE) cannot write unattended: the write gate parks the
    // draft itself. The cap has to be enforced at execution, not just recorded.
    const queue = memoryQueue();
    const { intentId, itemId } = await seedMissingTranslation(SITE, collectionId, 1);
    await scanAndReconcile(SITE, intentId);
    const dispatcher = await dispatcherFor(SITE, queue.provider);
    await dispatcher.dispatchReconcilerGoals();

    await runJob(queue.jobs[0]!);
    const [run] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, queue.jobs[0]!.payload['runId'] as string));
    expect(run!.status).toBe('awaiting_approval');
    // Nothing drafted, nothing published, no provider spend.
    expect(
      await db
        .select()
        .from(contentVersions)
        .where(and(eq(contentVersions.siteId, SITE), eq(contentVersions.itemId, itemId))),
    ).toHaveLength(0);
    expect(await liveTranslations(itemId)).toEqual({ en: 'Hello world' });
  });

  it('an L0 (shadow) intent fails the run without writing anything', async () => {
    const queue = memoryQueue();
    const { intentId, itemId } = await seedMissingTranslation(SITE, collectionId, 0);
    await scanAndReconcile(SITE, intentId);
    const dispatcher = await dispatcherFor(SITE, queue.provider);
    await dispatcher.dispatchReconcilerGoals();

    await runJob(queue.jobs[0]!);
    const [run] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, queue.jobs[0]!.payload['runId'] as string));
    expect(run!.status).toBe('failed');
    expect(String(run!.metrics && (run!.metrics as Record<string, unknown>)['stopReason'])).toBe(
      'autonomy_shadow',
    );
    expect(await liveTranslations(itemId)).toEqual({ en: 'Hello world' });

    // The next pass reports the dead end instead of retrying it forever.
    const after = await dispatcher.dispatchReconcilerGoals();
    expect(after.blocked).toBe(1);
    const goal = await goalRow(SITE);
    expect(goal.status).toBe('blocked');
    expect((goal.metadata as Record<string, unknown>)['blockedReason']).toBe('RUN_FAILED');
  });

  it('a disabled agent role stops work already in the queue', async () => {
    const queue = memoryQueue();
    const { intentId, itemId } = await seedMissingTranslation(SITE, collectionId);
    await scanAndReconcile(SITE, intentId);
    const dispatcher = await dispatcherFor(SITE, queue.provider);
    await dispatcher.dispatchReconcilerGoals();

    // Disable the role AFTER enqueue: capabilities are resolved at pickup (#472),
    // so this must take effect on the job already accepted.
    const { AgentRoleService } = await import('../agent-role-service');
    const roles = new AgentRoleService({ db, siteId: SITE });
    await roles.ensureSeeded();
    await roles.update('translator', { enabled: false });

    await runJob(queue.jobs[0]!);
    const [run] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, queue.jobs[0]!.payload['runId'] as string));
    expect(run!.status).toBe('failed');
    expect((run!.metrics as Record<string, unknown>)['stopReason']).toBe('capabilities_denied');
    expect(await liveTranslations(itemId)).toEqual({ en: 'Hello world' });
    expect(llmStub.calls).toHaveLength(0);
  });

  it('missing LLM provider fails the run with the cause, not a placeholder draft', async () => {
    const queue = memoryQueue();
    const { intentId, itemId } = await seedMissingTranslation(SITE, collectionId);
    await scanAndReconcile(SITE, intentId);
    const dispatcher = await dispatcherFor(SITE, queue.provider);
    await dispatcher.dispatchReconcilerGoals();

    // No provider configured: `createConfiguredLLMProvider` returns null and the
    // skill must fail loudly rather than draft an empty or invented translation.
    llmStub.available = false;
    try {
      await runJob(queue.jobs[0]!);
    } finally {
      llmStub.available = true;
    }

    const [run] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, queue.jobs[0]!.payload['runId'] as string));
    expect(run!.status).toBe('failed');
    expect(run!.error ?? '').toContain('LLM_NOT_CONFIGURED');
    expect(
      await db
        .select()
        .from(contentVersions)
        .where(and(eq(contentVersions.siteId, SITE), eq(contentVersions.itemId, itemId))),
    ).toHaveLength(0);
  });

  it('a queue that refuses the job blocks the goal and settles the run', async () => {
    const queue = memoryQueue();
    const { intentId } = await seedMissingTranslation(SITE, collectionId);
    await scanAndReconcile(SITE, intentId);
    const dispatcher = await dispatcherFor(SITE, queue.provider);
    queue.failNextEnqueue();

    const result = await dispatcher.dispatchReconcilerGoals();
    expect(result.blocked).toBe(1);
    expect(queue.jobs).toHaveLength(0);

    const goal = await goalRow(SITE);
    expect(goal.status).toBe('blocked');
    expect((goal.metadata as Record<string, unknown>)['blockedReason']).toBe('ENQUEUE_FAILED');
    // The run row is settled, not left `queued` with nothing to pick it up.
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.siteId, SITE));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('failed');
    expect((runs[0]!.metrics as Record<string, unknown>)['stopReason']).toBe('enqueue_failed');
  });

  it("the intent's write budget applies to dispatched runs", async () => {
    // `maxWritesPerMinute` is read from `envelope.budget` inside the harness. If
    // the dispatcher does not put the intent's budget on the payload, the limit is
    // stored on the intent and enforced nowhere — the run writes at full rate
    // while the intent claims a cap. Two missing locales give two draft runs
    // sharing one `${siteId}:${intentId}` window, so a cap of 1 must defer the
    // second one.
    const queue = memoryQueue();
    const [intent] = await db
      .insert(contentIntents)
      .values({
        siteId: SITE,
        name: 'articles-translations-budgeted',
        collection: COLLECTION,
        rules: [{ type: 'translations', fields: ['translations'], locales: ['en', 'vi', 'fr'] }],
        schedule: '0 * * * *',
        budget: { maxGoalsPerCycle: 10, maxWritesPerMinute: 1 },
        autonomyCap: 2,
        status: 'active',
      })
      .returning({ id: contentIntents.id });
    await db.insert(items).values({
      siteId: SITE,
      collectionId,
      status: 'published',
      data: { title: 'Hello', translations: { en: 'Hello world' } },
    });

    await scanAndReconcile(SITE, intent!.id);
    const dispatcher = await dispatcherFor(SITE, queue.provider);
    const dispatched = await dispatcher.dispatchReconcilerGoals();
    expect(dispatched.dispatched).toBe(2);
    expect(queue.jobs[0]!.payload['budget']).toMatchObject({ maxWritesPerMinute: 1 });

    await runJob(queue.jobs[0]!);
    await runJob(queue.jobs[1]!);

    const runs = await db.select().from(agentRuns).where(eq(agentRuns.siteId, SITE));
    const statuses = runs.map((r) => r.status).sort();
    // One write consumed the window. The other is settled as a deferral, not a
    // failure and not left `running`: a run stuck in `running` would make its goal
    // skip forever as RUN_ACTIVE.
    expect(statuses).toEqual(['cancelled', 'succeeded']);
    const deferred = runs.find((r) => r.status === 'cancelled')!;
    expect((deferred.metrics as Record<string, unknown>)['stopReason']).toBe('deferred');
    expect(llmStub.calls).toHaveLength(1);
    expect(
      await db.select().from(contentVersions).where(eq(contentVersions.siteId, SITE)),
    ).toHaveLength(1);

    // And the deferral is re-issued rather than blocking the goal, so the repair
    // resumes once quota returns instead of needing a human to unblock it.
    const jobsBefore = queue.jobs.length;
    const next = await dispatcher.dispatchReconcilerGoals();
    expect(next.blocked).toBe(0);
    expect(queue.jobs.length).toBeGreaterThan(jobsBefore);
    const deferredGoal = (
      await db.select().from(agentGoals).where(eq(agentGoals.id, deferred.goalId))
    )[0]!;
    expect(deferredGoal.status).not.toBe('blocked');
  });

  it('a runtime without a queue adapter reports it instead of pretending to dispatch', async () => {
    const { intentId } = await seedMissingTranslation(SITE, collectionId);
    await scanAndReconcile(SITE, intentId);
    const dispatcher = await dispatcherFor(SITE);

    const result = await dispatcher.dispatchReconcilerGoals();
    expect(result).toMatchObject({ dispatched: 0, queueUnavailable: true });
    // The goal is left dispatchable, so adding a queue later needs no unblocking.
    expect((await goalRow(SITE)).status).toBe('open');
  });

  it('a rule type with no wired repair path blocks the goal explicitly', async () => {
    const queue = memoryQueue();
    const [intent] = await db
      .insert(contentIntents)
      .values({
        siteId: SITE,
        name: 'articles-freshness',
        collection: COLLECTION,
        rules: [{ type: 'freshness', maxAgeDays: 0 }],
        schedule: '0 * * * *',
        budget: { maxGoalsPerCycle: 10 },
        autonomyCap: 2,
        status: 'active',
      })
      .returning({ id: contentIntents.id });
    await db.insert(items).values({
      siteId: SITE,
      collectionId,
      status: 'published',
      data: { title: 'Old' },
      updatedAt: new Date(Date.now() - 86_400_000 * 10),
    });

    await scanAndReconcile(SITE, intent!.id);
    const dispatcher = await dispatcherFor(SITE, queue.provider);
    const result = await dispatcher.dispatchReconcilerGoals();

    expect(result.blocked).toBe(1);
    expect(queue.jobs).toHaveLength(0);
    const goal = await goalRow(SITE);
    expect(goal.status).toBe('blocked');
    expect((goal.metadata as Record<string, unknown>)['blockedReason']).toBe('NO_REPAIR_SKILL');
  });

  it('never dispatches or completes across tenants', async () => {
    const queue = memoryQueue();
    const [otherColl] = await db
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.siteId, OTHER_SITE), eq(collections.name, COLLECTION)))
      .limit(1);

    const mine = await seedMissingTranslation(SITE, collectionId);
    const theirs = await seedMissingTranslation(OTHER_SITE, otherColl!.id);
    await scanAndReconcile(SITE, mine.intentId);
    await scanAndReconcile(OTHER_SITE, theirs.intentId);

    // This tenant's dispatcher must not see the other tenant's goal.
    const dispatcher = await dispatcherFor(SITE, queue.provider);
    const result = await dispatcher.dispatchReconcilerGoals();
    expect(result.dispatched).toBe(1);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]!.payload['siteId']).toBe(SITE);
    expect(queue.jobs[0]!.payload['arguments']).toMatchObject({ itemId: mine.itemId });

    await runJob(queue.jobs[0]!);
    // The other tenant's item and drift are untouched.
    expect(await liveTranslations(theirs.itemId)).toEqual({ en: 'Hello world' });
    expect(
      await db
        .select()
        .from(contentVersions)
        .where(eq(contentVersions.siteId, OTHER_SITE)),
    ).toHaveLength(0);
    expect(
      await db.select().from(agentRuns).where(eq(agentRuns.siteId, OTHER_SITE)),
    ).toHaveLength(0);
  });

  it('a frozen site advances nothing and leaves goals untouched', async () => {
    const queue = memoryQueue();
    const { intentId } = await seedMissingTranslation(SITE, collectionId);
    await scanAndReconcile(SITE, intentId);

    const { KillSwitchService } = await import('../kill-switch-service');
    await new KillSwitchService({ db, siteId: SITE }).freeze('site', {
      reason: 'incident drill',
      actor: ADMIN,
    });

    const dispatcher = await dispatcherFor(SITE, queue.provider);
    const result = await dispatcher.dispatchReconcilerGoals();
    expect(result).toMatchObject({ frozen: true, dispatched: 0 });
    expect(queue.jobs).toHaveLength(0);
    expect((await goalRow(SITE)).status).toBe('open');
  });

  it('a promote that does not actually fix the violation blocks instead of reporting success', async () => {
    // The core of "only verified content re-evaluation resolves the drift". The
    // draft is tampered with to hold whitespace, so the promote succeeds, real
    // content is published, and the translations rule still finds the locale
    // empty. Completing the goal here would be the worst available outcome: the
    // drift would read as repaired while the reader still sees nothing.
    const queue = memoryQueue();
    const { intentId, itemId } = await seedMissingTranslation(SITE, collectionId);
    await scanAndReconcile(SITE, intentId);
    const dispatcher = await dispatcherFor(SITE, queue.provider);

    await dispatcher.dispatchReconcilerGoals();
    await runJob(queue.jobs[0]!);

    // Tamper with the draft: a valid branch whose payload does not fix the drift.
    await db
      .update(contentVersions)
      .set({ data: { title: 'Hello', translations: { en: 'Hello world', vi: '   ' } } })
      .where(and(eq(contentVersions.siteId, SITE), eq(contentVersions.itemId, itemId)));

    await dispatcher.dispatchReconcilerGoals();
    await runJob(queue.jobs[1]!);

    const [pending] = await db
      .select()
      .from(aiApprovals)
      .where(and(eq(aiApprovals.siteId, SITE), eq(aiApprovals.status, 'pending')));
    const harness = await harnessForApproval(SITE);
    const decision = await harness.executeApproved(pending!.id, ADMIN, [
      'items:read',
      'items:write',
      'translations:write',
    ]);
    expect(decision.status).toBe('executed');
    // The publish really happened — this is not a promote failure.
    expect(await liveTranslations(itemId)).toEqual({ en: 'Hello world', vi: '   ' });

    const result = await dispatcher.dispatchReconcilerGoals();
    expect(result).toMatchObject({ completed: 0, blocked: 1 });
    const goal = await goalRow(SITE);
    expect(goal.status).toBe('blocked');
    expect((goal.metadata as Record<string, unknown>)['blockedReason']).toBe('VERIFY_FAILED');
    const [driftAfter] = await db
      .select()
      .from(contentDrifts)
      .where(eq(contentDrifts.siteId, SITE));
    expect(driftAfter!.status).not.toBe('resolved');
  });

  it('blocks when the drift it was created for has disappeared', async () => {
    const queue = memoryQueue();
    const { intentId } = await seedMissingTranslation(SITE, collectionId);
    await scanAndReconcile(SITE, intentId);
    await db.delete(contentDrifts).where(eq(contentDrifts.siteId, SITE));

    const dispatcher = await dispatcherFor(SITE, queue.provider);
    const result = await dispatcher.dispatchReconcilerGoals();
    expect(result.blocked).toBe(1);
    expect(queue.jobs).toHaveLength(0);
    const goal = await goalRow(SITE);
    expect(goal.status).toBe('blocked');
    expect((goal.metadata as Record<string, unknown>)['blockedReason']).toBe('DRIFT_MISSING');
  });

  it('a paused intent stops dispatch without blocking the goal', async () => {
    const queue = memoryQueue();
    const { intentId } = await seedMissingTranslation(SITE, collectionId);
    await scanAndReconcile(SITE, intentId);
    await db
      .update(contentIntents)
      .set({ status: 'paused' })
      .where(eq(contentIntents.id, intentId));

    const dispatcher = await dispatcherFor(SITE, queue.provider);
    const result = await dispatcher.dispatchReconcilerGoals();
    expect(result).toMatchObject({ dispatched: 0, skipped: 1 });
    expect(queue.jobs).toHaveLength(0);
    expect((await goalRow(SITE)).status).toBe('open');
  });
});
