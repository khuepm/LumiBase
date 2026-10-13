import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  activity,
  agentGoals,
  agentRuns,
  collections,
  contentIntents,
  fields,
  items,
  sites,
  type Database,
} from '@lumibase/database';
import type { QueueProvider, RuntimeContext } from '@lumibase/runtime';
import type { AppEnv, AuthPrincipal } from '../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { agentRouter } from '../../routes/agent';
import {
  AgentRunService,
  type RetriedRun,
  type RetryRequester,
  type RetryRunResult,
} from '../agent-run-service';
import { AGENT_RUNS_QUEUE, processAgentRunJob, type AgentRunJobPayload } from '../agent-run-worker';
import { KillSwitchService } from '../kill-switch-service';

/**
 * `POST /agent/runs/:id/retry` must actually execute the retry, exactly once.
 *
 * ## What was broken
 *
 * `retryRun` inserted a row with `status: 'running'` and returned 201. No job was
 * enqueued, and a `running` row is not claimable by the worker anyway
 * (`claimQueuedRun` only takes `queued`), so nothing ever executed; the row sat
 * until the stale sweep failed it.
 *
 * ## Evidence class
 *
 * REAL PostgreSQL (row lock, partial unique index, transactions), REAL worker entry
 * point (`processAgentRunJob`) and harness with the built-in echo provider, REAL
 * route mounted on Hono. The queue is an in-memory recorder: a broker adds nothing
 * to "was exactly one job enqueued, with this payload", and delivery is expressed
 * by handing the recorded payload to the worker, which is what a broker does.
 */

const SITE = 'site_run_retry';
const OTHER_SITE = 'site_run_retry_other';
const COLLECTION = 'articles';

const devAdmin: AuthPrincipal = { roles: ['admin'], raw: { dev: true } };
const requester: RetryRequester = {
  principal: { type: 'dev', siteId: SITE, roles: ['admin'] },
  userId: null,
};

/** Narrows to an accepted retry, failing the test (not skipping it) otherwise. */
function accepted(result: RetryRunResult): RetriedRun {
  if (!result.ok) throw new Error(`retry refused: ${result.code} — ${result.message}`);
  return result.retry;
}

function memoryQueue() {
  const jobs: Array<{ queue: string; name: string; payload: AgentRunJobPayload }> = [];
  const provider = {
    enqueue: async (queue: string, name: string, payload: unknown) => {
      jobs.push({ queue, name, payload: payload as AgentRunJobPayload });
      return `job_${jobs.length}`;
    },
    process: () => undefined,
    getStatus: async () => null,
  } as unknown as QueueProvider;
  return { jobs, provider };
}

describe.skipIf(!hasDbIntegrationUrl)('agent run retry — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('agent-run-retry');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, OTHER_SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(sites).where(eq(sites.id, OTHER_SITE));
    await db.insert(sites).values([
      { id: SITE, name: 'Run retry' },
      { id: OTHER_SITE, name: 'Run retry (other tenant)' },
    ]);
  });

  const workerDeps = () =>
    ({ db, env: { LLM_PROVIDER: 'echo', LUMIBASE_ENV: 'development' } }) as never;

  async function createArticlesCollection(): Promise<void> {
    const [collection] = await db
      .insert(collections)
      .values({ siteId: SITE, name: COLLECTION, label: 'Articles' })
      .returning();
    await db.insert(fields).values({
      siteId: SITE,
      collectionId: collection!.id,
      name: 'title',
      type: 'string',
      interface: 'input',
    });
  }

  /** A settled run with the tool call the harness would have recorded. */
  async function seedSettledRun(
    status: string,
    input: Record<string, unknown> = { collection: COLLECTION, data: { title: 'retry me' } },
  ): Promise<{ runId: string; goalId: string }> {
    const service = new AgentRunService(db, SITE);
    const run = await service.ensureRun({ title: `seed ${status}`, status: 'queued' });
    await service.appendToolCall({ runId: run.runId, toolName: 'createItem', input });
    await db.update(agentRuns).set({ status }).where(eq(agentRuns.id, run.runId));
    return { runId: run.runId, goalId: run.goalId };
  }

  async function runsOfGoal(goalId: string) {
    return db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.siteId, SITE), eq(agentRuns.goalId, goalId)));
  }

  async function itemCount(): Promise<number> {
    return (await db.select().from(items).where(eq(items.siteId, SITE))).length;
  }

  // ── (a) the retry is queued, enqueued once, and actually executes ───────────

  it('queues the retry, enqueues exactly one job with the original task, and the worker executes it', async () => {
    // A real failure first: the worker runs `createItem` into a collection that
    // does not exist yet, so the harness records the tool call and fails the run.
    const service = new AgentRunService(db, SITE);
    const first = await service.ensureRun({
      title: 'retry end to end',
      contextMessage: 'write the launch article',
      status: 'queued',
    });
    const task = { collection: COLLECTION, data: { title: 'launch' } };
    await processAgentRunJob(workerDeps(), {
      siteId: SITE,
      goalId: first.goalId,
      runId: first.runId,
      skillName: 'createItem',
      arguments: task,
      principal: requester.principal,
    });
    expect((await service.getRun(first.runId))!.status).toBe('failed');
    expect(await itemCount()).toBe(0);

    // The cause is fixed; a human retries.
    await createArticlesCollection();
    const queue = memoryQueue();
    const result = await new AgentRunService(db, SITE, queue.provider).retryRun(first.runId, requester);

    const retry = accepted(result);
    expect(retry).toMatchObject({
      goalId: first.goalId,
      status: 'queued',
      retryOfRunId: first.runId,
    });
    const retryRow = await service.getRun(retry.runId);
    expect(retryRow!.status, 'queued, so the worker claim owns the start').toBe('queued');
    expect(retryRow!.retryOfRunId).toBe(first.runId);

    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]!.queue).toBe(AGENT_RUNS_QUEUE);
    expect(queue.jobs[0]!.name).toBe('execute');
    expect(queue.jobs[0]!.payload).toEqual({
      siteId: SITE,
      goalId: first.goalId,
      runId: retry.runId,
      skillName: 'createItem',
      arguments: task,
      principal: requester.principal,
      userId: null,
      contextMessage: 'write the launch article',
    });

    // The authorization is on record, atomically with the row.
    const audit = await db
      .select()
      .from(activity)
      .where(and(eq(activity.siteId, SITE), eq(activity.action, 'agent_run.retried')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({ runId: retry.runId, retryOfRunId: first.runId });

    // Delivery: the worker executes the retry, and a redelivery is a no-op.
    await processAgentRunJob(workerDeps(), queue.jobs[0]!.payload);
    await processAgentRunJob(workerDeps(), queue.jobs[0]!.payload);
    expect((await service.getRun(retry.runId))!.status).toBe('succeeded');
    expect(await itemCount(), 'executed once, not zero times and not twice').toBe(1);
    expect((await service.getRun(first.runId))!.status, 'history is not rewritten').toBe('failed');
  });

  it('retries a cancelled run as well as a failed one', async () => {
    const { runId } = await seedSettledRun('cancelled');
    const queue = memoryQueue();
    const result = await new AgentRunService(db, SITE, queue.provider).retryRun(runId, requester);
    expect(result.ok).toBe(true);
    expect(queue.jobs).toHaveLength(1);
  });

  // ── (b) a run that is not settled-unsuccessfully is refused ─────────────────

  it('refuses queued, running, awaiting_approval and succeeded runs, writing nothing', async () => {
    for (const status of ['queued', 'running', 'awaiting_approval', 'succeeded']) {
      const { runId, goalId } = await seedSettledRun(status);
      const queue = memoryQueue();
      const result = await new AgentRunService(db, SITE, queue.provider).retryRun(runId, requester);

      expect(result, status).toMatchObject({ ok: false, code: 'RUN_NOT_RETRYABLE' });
      expect(queue.jobs, status).toHaveLength(0);
      expect(await runsOfGoal(goalId), `${status}: no retry row`).toHaveLength(1);
    }
  });

  it('refuses a second retry while the first is in flight, and an older attempt once retried', async () => {
    const { runId, goalId } = await seedSettledRun('failed');
    const queue = memoryQueue();
    const service = new AgentRunService(db, SITE, queue.provider);

    const first = accepted(await service.retryRun(runId, requester));
    const again = await service.retryRun(runId, requester);
    expect(again).toMatchObject({ ok: false, code: 'RUN_ACTIVE' });

    // Parked for approval is still in flight — the partial unique index does not
    // cover `awaiting_approval`, so this refusal comes from the service's own check.
    await db
      .update(agentRuns)
      .set({ status: 'awaiting_approval' })
      .where(eq(agentRuns.id, first.runId));
    expect(await service.retryRun(runId, requester)).toMatchObject({ ok: false, code: 'RUN_ACTIVE' });

    // The retry itself fails; the ORIGINAL is now superseded, the retry is not.
    await service.failRun(first.runId, 'still broken');
    const stale = await service.retryRun(runId, requester);
    expect(stale).toMatchObject({ ok: false, code: 'RETRY_SUPERSEDED' });
    expect(stale.ok ? '' : stale.message).toContain(first.runId);

    const chained = await service.retryRun(first.runId, requester);
    expect(chained.ok).toBe(true);
    expect(queue.jobs, 'one job per accepted retry').toHaveLength(2);
    expect(await runsOfGoal(goalId)).toHaveLength(3);
  });

  // ── (c) concurrent retries of one run enqueue one job ───────────────────────

  it('two concurrent retries of the same run create one row and enqueue one job', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { runId, goalId } = await seedSettledRun('failed');
      const queue = memoryQueue();
      const [a, b] = await Promise.all([
        new AgentRunService(db, SITE, queue.provider).retryRun(runId, requester),
        new AgentRunService(db, SITE, queue.provider).retryRun(runId, requester),
      ]);

      const accepted = [a, b].filter((r) => r.ok);
      const refused = [a, b].filter((r) => !r.ok);
      expect(accepted, `round ${round}`).toHaveLength(1);
      expect(refused.map((r) => (r.ok ? '' : r.code)), `round ${round}`).toEqual([
        expect.stringMatching(/^(RUN_ACTIVE|GOAL_BUSY)$/),
      ]);
      expect(queue.jobs, `round ${round}`).toHaveLength(1);
      const retries = (await runsOfGoal(goalId)).filter((row) => row.retryOfRunId === runId);
      expect(retries, `round ${round}`).toHaveLength(1);
    }
  });

  // ── (d) tenancy ─────────────────────────────────────────────────────────────

  it('a run id from another site is not found and nothing is written anywhere', async () => {
    const { runId, goalId } = await seedSettledRun('failed');
    const queue = memoryQueue();
    const result = await new AgentRunService(db, OTHER_SITE, queue.provider).retryRun(runId, {
      principal: { type: 'dev', siteId: OTHER_SITE, roles: ['admin'] },
      userId: null,
    });

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(queue.jobs).toHaveLength(0);
    expect(await runsOfGoal(goalId)).toHaveLength(1);
    expect(await db.select().from(agentRuns).where(eq(agentRuns.siteId, OTHER_SITE))).toHaveLength(0);
  });

  // ── governance gates the normal path applies ────────────────────────────────

  it('refuses while the site is frozen, and without a queue adapter, before writing', async () => {
    const { runId, goalId } = await seedSettledRun('failed');

    const noQueue = await new AgentRunService(db, SITE).retryRun(runId, requester);
    expect(noQueue).toMatchObject({ ok: false, code: 'ASYNC_UNAVAILABLE' });

    await new KillSwitchService({ db, siteId: SITE }).freeze('site', { actor: null });
    const queue = memoryQueue();
    const frozen = await new AgentRunService(db, SITE, queue.provider).retryRun(runId, requester);
    expect(frozen).toMatchObject({ ok: false, code: 'FROZEN' });

    expect(queue.jobs).toHaveLength(0);
    expect(await runsOfGoal(goalId)).toHaveLength(1);
  });

  it('refuses when the recorded input was masked or no tool call was recorded', async () => {
    const masked = await seedSettledRun('failed', {
      collection: COLLECTION,
      data: { title: 'x', apiKey: 'sk-live-secret' },
    });
    const queue = memoryQueue();
    const service = new AgentRunService(db, SITE, queue.provider);
    const maskedResult = await service.retryRun(masked.runId, requester);
    expect(maskedResult).toMatchObject({ ok: false, code: 'RETRY_UNRECOVERABLE' });
    expect(maskedResult.ok ? '' : maskedResult.message).toMatch(/masked/);

    const bare = await new AgentRunService(db, SITE).ensureRun({ title: 'no tool call', status: 'queued' });
    await db.update(agentRuns).set({ status: 'failed' }).where(eq(agentRuns.id, bare.runId));
    const bareResult = await service.retryRun(bare.runId, requester);
    expect(bareResult).toMatchObject({ ok: false, code: 'RETRY_UNRECOVERABLE' });

    expect(queue.jobs).toHaveLength(0);
  });

  it('settles the retry row as failed when the enqueue throws, so it can be retried again', async () => {
    const { runId } = await seedSettledRun('failed');
    const broken = {
      enqueue: async () => {
        throw new Error('broker down');
      },
      process: () => undefined,
      getStatus: async () => null,
    } as unknown as QueueProvider;

    const result = await new AgentRunService(db, SITE, broken).retryRun(runId, requester);
    expect(result).toMatchObject({ ok: false, code: 'ENQUEUE_FAILED' });

    const [retryRow] = await db.select().from(agentRuns).where(eq(agentRuns.retryOfRunId, runId));
    expect(retryRow!.status, 'no queued row without a job').toBe('failed');
    expect((retryRow!.metrics as Record<string, unknown>)['stopReason']).toBe('enqueue_failed');

    const queue = memoryQueue();
    const next = await new AgentRunService(db, SITE, queue.provider).retryRun(retryRow!.id, requester);
    expect(next.ok).toBe(true);
    expect(queue.jobs).toHaveLength(1);
  });

  it('a reconciler run is retried with the dispatch envelope and its blocked goal resumes', async () => {
    const [intent] = await db
      .insert(contentIntents)
      .values({
        siteId: SITE,
        name: `retry-intent-${Math.random().toString(36).slice(2, 8)}`,
        collection: COLLECTION,
        rules: [{ type: 'translations', fields: ['translations'], locales: ['en', 'vi'] }],
        schedule: '0 * * * *',
        budget: { maxWritesPerMinute: 5 },
        autonomyCap: 1,
        status: 'active',
      })
      .returning({ id: contentIntents.id });
    const [goal] = await db
      .insert(agentGoals)
      .values({
        siteId: SITE,
        title: 'repair translation',
        description: 'missing vi',
        origin: 'reconciler',
        assigneeAgent: 'translator',
        intentId: intent!.id,
        driftFingerprint: 'fp_retry',
        status: 'blocked',
        metadata: { repairPhase: 'drafting', blockedReason: 'RUN_FAILED' },
      })
      .returning();
    const service = new AgentRunService(db, SITE);
    const run = await service.ensureRun({
      goalId: goal!.id,
      agentName: 'translator',
      status: 'queued',
      budget: { maxWritesPerMinute: 5 },
    });
    const args = { collection: COLLECTION, itemId: 'itm_1', field: 'title', locale: 'vi', versionKey: 'drift-repair:fp_retry' };
    await service.appendToolCall({ runId: run.runId, toolName: 'repairTranslation', input: args });
    await service.failRun(run.runId, 'provider timeout');

    const queue = memoryQueue();
    const result = await new AgentRunService(db, SITE, queue.provider).retryRun(run.runId, requester);
    expect(result.ok).toBe(true);
    expect(queue.jobs[0]!.payload).toMatchObject({
      skillName: 'repairTranslation',
      arguments: args,
      origin: 'reconciler',
      intentId: intent!.id,
      driftFingerprint: 'fp_retry',
      autonomyCap: 1,
      agentRole: 'translator',
      budget: { maxWritesPerMinute: 5 },
      principal: requester.principal,
      contextMessage: 'missing vi',
    });

    const [after] = await db.select().from(agentGoals).where(eq(agentGoals.id, goal!.id));
    expect(after!.status).toBe('in_progress');
    expect(after!.metadata).toEqual({ repairPhase: 'drafting' });
  });

  it('refuses a reconciler retry while its intent is paused or a dispatcher holds the goal', async () => {
    const [intent] = await db
      .insert(contentIntents)
      .values({
        siteId: SITE,
        name: `retry-paused-${Math.random().toString(36).slice(2, 8)}`,
        collection: COLLECTION,
        rules: [{ type: 'translations', fields: ['translations'], locales: ['en', 'vi'] }],
        schedule: '0 * * * *',
        budget: {},
        autonomyCap: 2,
        status: 'paused',
      })
      .returning({ id: contentIntents.id });
    const [goal] = await db
      .insert(agentGoals)
      .values({
        siteId: SITE,
        title: 'repair',
        origin: 'reconciler',
        intentId: intent!.id,
        driftFingerprint: 'fp_paused',
        status: 'blocked',
      })
      .returning();
    const service = new AgentRunService(db, SITE);
    const run = await service.ensureRun({ goalId: goal!.id, agentName: 'translator', status: 'queued' });
    await service.appendToolCall({ runId: run.runId, toolName: 'repairTranslation', input: { collection: COLLECTION } });
    await service.failRun(run.runId, 'boom');

    const queue = memoryQueue();
    const retrying = new AgentRunService(db, SITE, queue.provider);
    expect(await retrying.retryRun(run.runId, requester)).toMatchObject({
      ok: false,
      code: 'INTENT_NOT_ACTIVE',
    });

    await db.update(contentIntents).set({ status: 'active' }).where(eq(contentIntents.id, intent!.id));
    await db
      .update(agentGoals)
      .set({ dispatchLeaseUntil: new Date(Date.now() + 30_000), dispatchLeaseBy: 'other#lease' })
      .where(eq(agentGoals.id, goal!.id));
    expect(await retrying.retryRun(run.runId, requester)).toMatchObject({
      ok: false,
      code: 'GOAL_BUSY',
    });
    expect(queue.jobs).toHaveLength(0);
    expect(await runsOfGoal(goal!.id)).toHaveLength(1);
  });

  // ── (e) the route ───────────────────────────────────────────────────────────

  function appFor(siteId: string, queue: QueueProvider | undefined) {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', siteId);
      c.set('auth', devAdmin);
      c.set('runtime', { queue } as unknown as RuntimeContext);
      await next();
    });
    app.route('/agent', agentRouter);
    return app;
  }

  it('route: 201 with the queued retry, 409 on a repeat, 404 for unknown and cross-site ids', async () => {
    const { runId } = await seedSettledRun('failed');
    const queue = memoryQueue();
    const app = appFor(SITE, queue.provider);

    const created = await app.request(`/agent/runs/${runId}/retry`, { method: 'POST' });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ status: 'queued', retryOfRunId: runId });
    expect(typeof body.data['runId']).toBe('string');
    expect(queue.jobs).toHaveLength(1);

    const repeat = await app.request(`/agent/runs/${runId}/retry`, { method: 'POST' });
    expect(repeat.status).toBe(409);
    expect(await repeat.json()).toEqual({
      errors: [{ code: 'RUN_ACTIVE', message: expect.any(String) }],
    });

    const missing = await app.request('/agent/runs/does-not-exist/retry', { method: 'POST' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ errors: [{ code: 'NOT_FOUND', message: 'Run not found' }] });

    const crossSite = await appFor(OTHER_SITE, queue.provider).request(`/agent/runs/${runId}/retry`, {
      method: 'POST',
    });
    expect(crossSite.status).toBe(404);
    expect(queue.jobs, 'only the first request enqueued').toHaveLength(1);
  });

  it('route: 409 for a run that is not retryable, 400 without a queue adapter', async () => {
    const running = await seedSettledRun('running');
    const notRetryable = await appFor(SITE, memoryQueue().provider).request(
      `/agent/runs/${running.runId}/retry`,
      { method: 'POST' },
    );
    expect(notRetryable.status).toBe(409);
    expect(((await notRetryable.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe(
      'RUN_NOT_RETRYABLE',
    );

    const failed = await seedSettledRun('failed');
    const noQueue = await appFor(SITE, undefined).request(`/agent/runs/${failed.runId}/retry`, {
      method: 'POST',
    });
    expect(noQueue.status).toBe(400);
    expect(((await noQueue.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe(
      'ASYNC_UNAVAILABLE',
    );
  });
});
