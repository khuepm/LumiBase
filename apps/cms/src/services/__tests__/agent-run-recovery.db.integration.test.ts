import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  activity,
  agentApprovals,
  agentGoals,
  agentRuns,
  agentToolCalls,
  aiApprovals,
  collections,
  fields,
  items,
  revisions,
  sites,
  type Database,
} from '@lumibase/database';
import type { QueueProvider, RuntimeContext } from '@lumibase/runtime';
import type { AppEnv, AuthPrincipal } from '../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { agentRouter } from '../../routes/agent';
import { AgentRunService, type RetryRequester } from '../agent-run-service';
import { processAgentRunJob, type AgentRunJobPayload } from '../agent-run-worker';

/**
 * Traces, idempotency and partial-failure recovery of agent runs (#584).
 *
 * ## What was wrong (measured at 5a92d6ea, before the fix)
 *
 * - F1: `cancelRun` read the status, then wrote `cancelled` without checking it
 *   again. A run that succeeded in between was rewritten as `cancelled`, and a
 *   cancelled run is retryable, so the retry repeated a side effect that had
 *   already happened.
 * - F2: `awaitApproval` wrote `awaiting_approval` unconditionally. A run cancelled
 *   while the harness was classifying a dangerous call came back to life as
 *   `awaiting_approval`, with a pending approval that executed when a human
 *   approved it.
 * - F3: when the skill succeeded and recording the outcome failed, the worker
 *   settled the run as `failed` (`worker_error`) while its tool call said
 *   `executed`. `retryRun` only looked at the run status, so it re-executed the
 *   write: two items for one request.
 * - F4: a failed database write surfaced Drizzle's error message, which embeds
 *   the full parameter list. The run's `error` (returned by `GET /agent/runs`)
 *   and the tool call's `error` therefore carried values that `maskSecrets`
 *   removes from the recorded input, such as a field named `apiToken`.
 *
 * ## Evidence class
 *
 * REAL PostgreSQL, the REAL worker entry point and harness (echo provider, no
 * model), REAL route on Hono. Faults are injected by wrapping one
 * `AgentRunService` method for one call; every assertion reads rows back.
 */

const SITE = 'site_584_recovery';
const OTHER_SITE = 'site_584_recovery_other';
const COLLECTION = 'articles';
const SECRET_CANARY = 'canary-secret-584-ZQ9X';
const PII_CANARY = 'canary.pii.584@example.dev';

const devAdmin: AuthPrincipal = { roles: ['admin'], raw: { dev: true } };
const requester: RetryRequester = {
  principal: { type: 'dev', siteId: SITE, roles: ['admin'] },
  userId: null,
};

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

describe.skipIf(!hasDbIntegrationUrl)('#584 agent run recovery — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('agent-run-recovery');
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
      { id: SITE, name: '584 recovery' },
      { id: OTHER_SITE, name: '584 recovery (other tenant)' },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const workerDeps = () =>
    ({ db, env: { LLM_PROVIDER: 'echo', LUMIBASE_ENV: 'development' } }) as never;

  async function createArticles(siteId = SITE): Promise<void> {
    const [collection] = await db
      .insert(collections)
      .values({ siteId, name: COLLECTION, label: 'Articles' })
      .returning();
    for (const name of ['title', 'apiToken', 'email']) {
      await db.insert(fields).values({
        siteId,
        collectionId: collection!.id,
        name,
        type: 'string',
        interface: 'input',
      });
    }
  }

  async function queuedRun(title: string) {
    return new AgentRunService(db, SITE).ensureRun({ title, status: 'queued' });
  }

  function job(
    run: { goalId: string; runId: string },
    skillName: string,
    args: Record<string, unknown>,
    extra: Partial<AgentRunJobPayload> = {},
  ): AgentRunJobPayload {
    return {
      siteId: SITE,
      goalId: run.goalId,
      runId: run.runId,
      skillName,
      arguments: args,
      principal: requester.principal,
      ...extra,
    };
  }

  async function siteItems(siteId = SITE) {
    return db.select().from(items).where(eq(items.siteId, siteId));
  }

  /**
   * Everything recorded for a goal, joined only on stored ids. If an outcome
   * cannot be told from this, it cannot be reconstructed after the fact.
   */
  async function traceOf(goalId: string) {
    const [goal] = await db
      .select()
      .from(agentGoals)
      .where(and(eq(agentGoals.siteId, SITE), eq(agentGoals.id, goalId)));
    const runs = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.siteId, SITE), eq(agentRuns.goalId, goalId)))
      .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id));
    const runIds = new Set(runs.map((r) => r.id));
    const calls = (
      await db.select().from(agentToolCalls).where(eq(agentToolCalls.siteId, SITE))
    ).filter((c) => runIds.has(c.runId));
    const approvals = (
      await db.select().from(agentApprovals).where(eq(agentApprovals.siteId, SITE))
    ).filter((a) => runIds.has(a.runId));
    const revs = (await db.select().from(revisions).where(eq(revisions.siteId, SITE))).filter(
      (r) => r.createdByRunId !== null && runIds.has(r.createdByRunId),
    );
    const audit = (
      await db.select().from(activity).where(eq(activity.siteId, SITE))
    ).filter((a) => a.action === 'agent_run.retried' && (a.payload as { goalId?: string }).goalId === goalId);
    return { goal: goal!, runs, calls, approvals, revisions: revs, audit };
  }

  // ── acceptance 1: success, denial and recovered failure are reconstructable ──

  it('reconstructs a success from correlated rows: run → tool call → revision', async () => {
    await createArticles();
    const run = await queuedRun('trace success');
    await processAgentRunJob(workerDeps(), job(run, 'createItem', { collection: COLLECTION, data: { title: 'ok' } }));

    const trace = await traceOf(run.goalId);
    expect(trace.runs.map((r) => r.status)).toEqual(['succeeded']);
    expect(trace.calls).toHaveLength(1);
    expect(trace.calls[0]).toMatchObject({ runId: run.runId, toolName: 'createItem', status: 'executed' });
    const created = (trace.calls[0]!.output as { item?: { id?: string } }).item?.id;
    expect(typeof created).toBe('string');
    // The content change points back at the run that made it.
    expect(trace.revisions.map((r) => [r.itemId, r.createdByRunId, r.authorType])).toEqual([
      [created, run.runId, 'agent'],
    ]);
    expect((await siteItems()).map((i) => i.id)).toEqual([created]);
  });

  it('reconstructs a denial: tool call denied with a reason, run failed, nothing written', async () => {
    await createArticles();
    const run = await queuedRun('trace denial');
    // A pre-#472 job with an empty capability snapshot: the harness must deny.
    await processAgentRunJob(
      workerDeps(),
      job(run, 'createItem', { collection: COLLECTION, data: { title: 'no' } }, { principal: null, capabilities: [] }),
    );

    const trace = await traceOf(run.goalId);
    expect(trace.runs).toHaveLength(1);
    expect(trace.runs[0]).toMatchObject({ status: 'failed', error: 'Insufficient capabilities' });
    expect(trace.calls.map((c) => [c.status, c.error])).toEqual([['denied', 'Insufficient capabilities']]);
    expect(trace.revisions).toHaveLength(0);
    expect(await siteItems()).toHaveLength(0);
  });

  it('reconstructs a recovered failure: failed attempt → audited retry → one success', async () => {
    const run = await queuedRun('trace recovery');
    const args = { collection: COLLECTION, data: { title: 'recovered' } };
    // The collection does not exist yet, so the first attempt fails in the skill.
    await processAgentRunJob(workerDeps(), job(run, 'createItem', args));
    await createArticles();

    const queue = memoryQueue();
    const retried = await new AgentRunService(db, SITE, queue.provider).retryRun(run.runId, requester);
    expect(retried.ok).toBe(true);
    // Redelivery of the retry job must not execute twice.
    await processAgentRunJob(workerDeps(), queue.jobs[0]!.payload);
    await processAgentRunJob(workerDeps(), queue.jobs[0]!.payload);

    const trace = await traceOf(run.goalId);
    expect(trace.runs.map((r) => [r.status, r.retryOfRunId])).toEqual([
      ['failed', null],
      ['succeeded', run.runId],
    ]);
    expect(trace.calls.map((c) => c.status).sort()).toEqual(['executed', 'failed']);
    expect(trace.audit).toHaveLength(1);
    expect(trace.audit[0]!.payload).toMatchObject({
      runId: trace.runs[1]!.id,
      retryOfRunId: run.runId,
      skillName: 'createItem',
    });
    expect(trace.revisions.map((r) => r.createdByRunId)).toEqual([trace.runs[1]!.id]);
    expect(await siteItems()).toHaveLength(1);
  });

  // ── F1: a cancel racing completion must not rewrite the outcome ──────────────

  it('F1: cancel that loses the race to completion leaves the run succeeded and not retryable', async () => {
    await createArticles();
    const run = await queuedRun('cancel race');
    await processAgentRunJob(workerDeps(), job(run, 'createItem', { collection: COLLECTION, data: { title: 'raced' } }));
    // Rewind to the instant the canceller read the run: `running`.
    await db.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, run.runId));

    const canceller = new AgentRunService(db, SITE);
    const realGetRun = AgentRunService.prototype.getRun;
    vi.spyOn(canceller, 'getRun').mockImplementationOnce(async function (this: AgentRunService, id: string) {
      const snapshot = await realGetRun.call(canceller, id);
      // The worker settles the run between the canceller's read and its write.
      await new AgentRunService(db, SITE).closeRun(id, { toolCalls: 1 });
      return snapshot;
    });

    const cancelled = await canceller.cancelRun(run.runId);
    expect(cancelled, 'the cancel lost; it must say so').toBeNull();
    expect((await canceller.getRun(run.runId))!.status).toBe('succeeded');

    const queue = memoryQueue();
    const retry = await new AgentRunService(db, SITE, queue.provider).retryRun(run.runId, requester);
    expect(retry).toMatchObject({ ok: false, code: 'RUN_NOT_RETRYABLE' });
    expect(queue.jobs).toHaveLength(0);
    expect(await siteItems()).toHaveLength(1);
  });

  // ── F2: a run cancelled mid-classification must not be parked ───────────────

  it('F2: a run cancelled while the harness classifies a dangerous call stays cancelled with no approval', async () => {
    await createArticles();
    const [item] = await db
      .insert(items)
      .values({
        siteId: SITE,
        collectionId: (await db.select().from(collections).where(eq(collections.siteId, SITE)))[0]!.id,
        data: { title: 'keep me' },
      })
      .returning();
    const run = await queuedRun('cancel before park');

    // Cancel lands after the harness's boundary check, while it is still
    // recording the tool call and resolving autonomy for `deleteItem`.
    const realAppend = AgentRunService.prototype.appendToolCall;
    vi.spyOn(AgentRunService.prototype, 'appendToolCall').mockImplementationOnce(async function (
      this: AgentRunService,
      input,
    ) {
      const id = await realAppend.call(this, input);
      await new AgentRunService(db, SITE).cancelRun(run.runId);
      return id;
    });

    await processAgentRunJob(workerDeps(), job(run, 'deleteItem', { collection: COLLECTION, id: item!.id }));

    const trace = await traceOf(run.goalId);
    expect(trace.runs.map((r) => r.status)).toEqual(['cancelled']);
    expect(trace.approvals, 'no approval may outlive the cancellation').toHaveLength(0);
    expect(await db.select().from(aiApprovals).where(eq(aiApprovals.siteId, SITE))).toHaveLength(0);
    expect(trace.calls.map((c) => c.status)).toEqual(['denied']);
    expect((await siteItems()).map((i) => i.id)).toEqual([item!.id]);
  });

  // ── F3: an executed side effect must not be replayed by a retry ─────────────

  it('F3: success followed by a recording failure is not re-executed by retry', async () => {
    await createArticles();
    const run = await queuedRun('partial failure');
    vi.spyOn(AgentRunService.prototype, 'closeRun').mockRejectedValueOnce(new Error('connection reset'));

    await processAgentRunJob(workerDeps(), job(run, 'createItem', { collection: COLLECTION, data: { title: 'once' } }));

    const before = await traceOf(run.goalId);
    expect(before.runs[0]).toMatchObject({ status: 'failed' });
    expect((before.runs[0]!.metrics as Record<string, unknown>)['stopReason']).toBe('worker_error');
    expect(before.calls.map((c) => c.status), 'the effect is on record').toEqual(['executed']);
    expect(await siteItems()).toHaveLength(1);

    const queue = memoryQueue();
    const retry = await new AgentRunService(db, SITE, queue.provider).retryRun(run.runId, requester);
    expect(retry).toMatchObject({ ok: false, code: 'RUN_EFFECT_RECORDED' });
    expect(queue.jobs).toHaveLength(0);
    expect(await traceOf(run.goalId).then((t) => t.runs)).toHaveLength(1);
    expect(await siteItems(), 'still one item, not two').toHaveLength(1);
  });

  it('F3 route: the refusal is a 409 with the code', async () => {
    await createArticles();
    const run = await queuedRun('partial failure route');
    vi.spyOn(AgentRunService.prototype, 'closeRun').mockRejectedValueOnce(new Error('connection reset'));
    await processAgentRunJob(workerDeps(), job(run, 'createItem', { collection: COLLECTION, data: { title: 'once' } }));

    const res = await appFor(SITE, memoryQueue().provider).request(`/agent/runs/${run.runId}/retry`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('RUN_EFFECT_RECORDED');
  });

  // ── F4 + acceptance 3: synthetic canaries do not reach traces ───────────────

  it('F4: a failed recording does not copy content into the run error', async () => {
    await createArticles();
    const run = await queuedRun('canary on recording failure');
    // A NUL character is valid JSON but rejected by Postgres jsonb, so recording
    // the tool call fails with the whole row (content included) as parameters.
    await processAgentRunJob(
      workerDeps(),
      job(run, 'createItem', {
        collection: COLLECTION,
        data: { title: 'bad\u0000title', email: PII_CANARY, apiToken: SECRET_CANARY },
      }),
    );

    const trace = await traceOf(run.goalId);
    expect(trace.runs[0]).toMatchObject({ status: 'failed' });
    expect((trace.runs[0]!.metrics as Record<string, unknown>)['stopReason']).toBe('worker_error');
    // Still useful evidence: what failed, and the driver's reason.
    expect(trace.runs[0]!.error).toMatch(/^Database query failed \(SQLSTATE 22P05\)/);
    expect(trace.runs[0]!.error).not.toContain('params:');
    expect(trace.runs[0]!.error).not.toContain(PII_CANARY);
    expect(await siteItems()).toHaveLength(0);

    const listing = await (await appFor(SITE, undefined).request('/agent/runs')).text();
    expect(listing).not.toContain(PII_CANARY);
    expect(listing).not.toContain(SECRET_CANARY);
  });

  it('F4: a failed skill write does not copy a secret-keyed value into the run or tool call error', async () => {
    await createArticles();
    // A real database failure inside the item insert, scoped to this site.
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION lumibase_test_584_reject() RETURNS trigger AS $$
      BEGIN
        IF NEW.site_id = '${SITE}' AND NEW.data->>'title' = 'reject-584' THEN
          RAISE EXCEPTION 'rejected by test trigger' USING ERRCODE = 'P0584';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`));
    await db.execute(sql.raw(`
      DROP TRIGGER IF EXISTS lumibase_test_584_reject ON lumibase_items;
      CREATE TRIGGER lumibase_test_584_reject BEFORE INSERT ON lumibase_items
        FOR EACH ROW EXECUTE FUNCTION lumibase_test_584_reject()`));
    try {
      const run = await queuedRun('canary on skill failure');
      await processAgentRunJob(
        workerDeps(),
        job(run, 'createItem', {
          collection: COLLECTION,
          data: { title: 'reject-584', apiToken: SECRET_CANARY },
        }),
      );

      const trace = await traceOf(run.goalId);
      expect(trace.runs[0]!.status).toBe('failed');
      expect(trace.calls.map((c) => c.status)).toEqual(['failed']);
      expect(trace.calls[0]!.error).toBe('Database query failed (SQLSTATE P0584): rejected by test trigger');
      expect(trace.runs[0]!.error).toBe(trace.calls[0]!.error);
      expect(JSON.stringify({ runs: trace.runs, calls: trace.calls })).not.toContain(SECRET_CANARY);

      const listing = await (await appFor(SITE, undefined).request('/agent/runs')).text();
      expect(listing).not.toContain(SECRET_CANARY);
    } finally {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS lumibase_test_584_reject ON lumibase_items'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS lumibase_test_584_reject()'));
    }
  });

  it('control: a successful call masks a secret-keyed canary in input and output; tenants stay apart', async () => {
    await createArticles();
    await createArticles(OTHER_SITE);
    const run = await queuedRun('canary on success');
    await processAgentRunJob(
      workerDeps(),
      job(run, 'createItem', {
        collection: COLLECTION,
        data: { title: 'fine', apiToken: SECRET_CANARY, email: PII_CANARY },
      }),
    );

    const trace = await traceOf(run.goalId);
    expect(trace.runs[0]!.status).toBe('succeeded');
    expect(JSON.stringify(trace.calls)).not.toContain(SECRET_CANARY);
    // Non-secret content stays as audit evidence (and is what a retry replays).
    expect((trace.calls[0]!.input as { data: { email: string } }).data.email).toBe(PII_CANARY);
    const listing = await (await appFor(SITE, undefined).request('/agent/runs')).text();
    expect(listing).not.toContain(SECRET_CANARY);
    expect(listing).not.toContain(PII_CANARY);
    const otherListing = (await (await appFor(OTHER_SITE, undefined).request('/agent/runs')).json()) as {
      data: unknown[];
    };
    expect(otherListing.data).toHaveLength(0);
  });

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
});
