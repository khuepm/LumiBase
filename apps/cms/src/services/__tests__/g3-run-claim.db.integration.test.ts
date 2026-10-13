import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentApprovals,
  agentRoles,
  agentRuns,
  collections,
  fields,
  items,
  sites,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import {
  AgentRunService,
  RUN_STALE_MS,
  STALE_RUN_STOP_REASON,
  sweepStaleRuns,
} from '../agent-run-service';
import { processAgentRunJob, type AgentRunJobPayload } from '../agent-run-worker';

/**
 * At-least-once delivery must not become at-least-once *execution* (#455 F3).
 *
 * ## What was measured before the fix
 *
 * The worker started a run through `markRunning`, which read the status and then
 * wrote — and accepted `running` as a startable state, returning `true`. On
 * Postgres, with real services:
 *
 * - the same job delivered twice concurrently created **two items**;
 * - the same job delivered again while its run sat in `awaiting_approval` created
 *   a **second pending approval** for the same run;
 * - `markRunning` itself answered `true` on both the first and the duplicate call.
 *
 * Several comments — including the dispatcher's justification for re-dispatching a
 * lost job — asserted the opposite. The R4 recovery was therefore resting on a
 * property that did not exist.
 *
 * ## What replaces it
 *
 * `claimQueuedRun` is one conditional UPDATE, so the database picks the winner.
 * `awaiting_approval` is not claimable from the queue at all; resuming a parked
 * run belongs to the approval decision (`resumeApprovedRun`). Crash recovery is
 * kept by allowing a `running` row older than `RUN_STALE_MS` to be taken over,
 * which a duplicate arriving seconds later cannot satisfy.
 *
 * ## Evidence class
 *
 * REAL PostgreSQL, REAL worker entry point (`processAgentRunJob`), real
 * ItemService writes. No broker: duplicate delivery is expressed by calling the
 * delivery handler twice, which is what a broker redelivery does. Provider is the
 * built-in echo, so no network and no LLM.
 *
 * **Validates: #455 F3 — duplicate delivery executes once**
 */

const SITE = 'site_run_claim';
const AGENT_ROLE = 'run-claim-writer';

describe.skipIf(!hasDbIntegrationUrl)('#455 F3 run claim is exclusive — DB integration', () => {
  let db: Database;
  let collectionId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('g3-run-claim');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Run claim' });
    await db.insert(agentRoles).values({
      siteId: SITE,
      name: AGENT_ROLE,
      description: 'F3 fixture',
      capabilities: ['items:read', 'items:write', 'items:update', 'items:create'],
    });
    const [collection] = await db
      .insert(collections)
      .values({ siteId: SITE, name: 'articles', label: 'Articles' })
      .returning();
    collectionId = collection!.id;
    await db.insert(fields).values({
      siteId: SITE,
      collectionId,
      name: 'title',
      type: 'string',
      interface: 'input',
    });
  });

  const workerDeps = () => ({ db, env: { LLM_PROVIDER: 'echo' } }) as never;

  function createPayload(runId: string, goalId: string): AgentRunJobPayload {
    return {
      siteId: SITE,
      goalId,
      runId,
      skillName: 'createItem',
      arguments: { collection: 'articles', data: { title: 'duplicate probe' } },
      agentRole: AGENT_ROLE,
      autonomyCap: 2,
    } as AgentRunJobPayload;
  }

  async function itemCount(): Promise<number> {
    const rows = await db.select().from(items).where(eq(items.siteId, SITE));
    return rows.length;
  }

  it('two concurrent deliveries of one job write ONCE', async () => {
    const runService = new AgentRunService(db, SITE);
    const run = await runService.ensureRun({ title: 'F3 concurrent', status: 'queued' });
    const payload = createPayload(run.runId, run.goalId);

    await Promise.all([
      processAgentRunJob(workerDeps(), payload),
      processAgentRunJob(workerDeps(), payload),
    ]);

    expect(await itemCount(), 'the duplicate delivery must not write a second item').toBe(1);
    const after = await runService.getRun(run.runId);
    expect(after!.status).toBe('succeeded');
  });

  it('a redelivery while the run waits for approval does not park a SECOND approval', async () => {
    // `promoteVersion` is classified dangerous, so the first delivery parks. The
    // second delivery is what used to create a duplicate pending approval — two
    // humans would then each see an action to approve for one run.
    const runService = new AgentRunService(db, SITE);
    const [item] = await db
      .insert(items)
      .values({ siteId: SITE, collectionId, status: 'published', data: { title: 'seed' } })
      .returning();
    const run = await runService.ensureRun({ title: 'F3 parked', status: 'queued' });
    const payload = {
      ...createPayload(run.runId, run.goalId),
      skillName: 'promoteVersion',
      arguments: { collection: 'articles', itemId: item!.id, key: 'probe' },
      autonomyCap: 1,
    } as AgentRunJobPayload;

    await processAgentRunJob(workerDeps(), payload);
    await processAgentRunJob(workerDeps(), payload);

    const approvals = await db
      .select()
      .from(agentApprovals)
      .where(eq(agentApprovals.runId, run.runId));
    expect(approvals, 'one parked action, one approval').toHaveLength(1);
  });

  it('claimQueuedRun admits exactly one of two simultaneous claims', async () => {
    const runService = new AgentRunService(db, SITE);
    const run = await runService.ensureRun({ title: 'F3 claim', status: 'queued' });

    const [a, b] = await Promise.all([
      runService.claimQueuedRun(run.runId),
      runService.claimQueuedRun(run.runId),
    ]);
    expect([a, b].filter(Boolean), 'only one caller may start the run').toHaveLength(1);
  });

  it('refuses a cancelled run and a terminal run', async () => {
    const runService = new AgentRunService(db, SITE);
    for (const status of ['cancelled', 'succeeded', 'failed'] as const) {
      const run = await runService.ensureRun({ title: `F3 ${status}`, status: 'queued' });
      await db.update(agentRuns).set({ status }).where(eq(agentRuns.id, run.runId));
      expect(await runService.claimQueuedRun(run.runId), status).toBe(false);
      const after = await runService.getRun(run.runId);
      expect(after!.status, 'the status must be left alone').toBe(status);
    }
  });

  it('refuses a run parked at awaiting_approval, which only the approval may resume', async () => {
    const runService = new AgentRunService(db, SITE);
    const run = await runService.ensureRun({ title: 'F3 parked claim', status: 'queued' });
    await db
      .update(agentRuns)
      .set({ status: 'awaiting_approval' })
      .where(eq(agentRuns.id, run.runId));

    expect(await runService.claimQueuedRun(run.runId)).toBe(false);
    expect(await runService.resumeApprovedRun(run.runId), 'the approval path may').toBe(true);
  });

  /**
   * A stale `running` run is NEVER taken over (#481 R3.1).
   *
   * The first version of this fix allowed it after 15 minutes, to recover from a
   * crashed worker. Measured, that reopened the hole the claim had just closed —
   * see the replay case below. Age cannot distinguish "did nothing" from "wrote an
   * item and then died", so recovery goes through `quarantineStaleRuns` and a
   * human instead.
   */
  it('never re-claims a running run, fresh or stale', async () => {
    const runService = new AgentRunService(db, SITE);
    const run = await runService.ensureRun({ title: 'F3 stale', status: 'queued' });

    expect(await runService.claimQueuedRun(run.runId), 'first claim').toBe(true);
    expect(await runService.claimQueuedRun(run.runId), 'a live run is not stealable').toBe(false);

    await db
      .update(agentRuns)
      .set({ startedAt: new Date(Date.now() - RUN_STALE_MS - 1_000) })
      .where(eq(agentRuns.id, run.runId));
    expect(
      await runService.claimQueuedRun(run.runId),
      'age does not make a started run claimable',
    ).toBe(false);
  });

  it('does NOT replay a run that wrote before its worker died (R3.1)', async () => {
    // The exact window: content committed, terminal status never saved. Reproduced
    // with a fault on the run's terminal write — the same shape a killed process
    // leaves behind, without killing anything.
    const runService = new AgentRunService(db, SITE);
    const run = await runService.ensureRun({ title: 'R3.1 replay', status: 'queued' });
    const payload = createPayload(run.runId, run.goalId);

    const faultyDb = new Proxy(db, {
      get(target, prop) {
        if (prop !== 'update') {
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        }
        return (table: unknown) => {
          const builder = (target.update as (t: unknown) => unknown)(table) as Record<
            string,
            unknown
          >;
          if (table !== agentRuns) return builder;
          return new Proxy(builder, {
            get(inner, key) {
              if (key === 'set') {
                return (values: Record<string, unknown>) => {
                  if (values['status'] === 'succeeded' || values['status'] === 'failed') {
                    throw new Error('FAULT_AFTER_WRITE_BEFORE_RUN_TERMINAL');
                  }
                  return (inner['set'] as (v: unknown) => unknown)(values);
                };
              }
              const value = Reflect.get(inner, key) as unknown;
              return typeof value === 'function' ? (value as () => unknown).bind(inner) : value;
            },
          });
        };
      },
    }) as typeof db;

    await expect(
      processAgentRunJob({ db: faultyDb, env: { LLM_PROVIDER: 'echo' } } as never, payload),
    ).rejects.toThrow(/FAULT_AFTER_WRITE_BEFORE_RUN_TERMINAL/);
    expect(await itemCount(), 'the side effect DID happen').toBe(1);
    const stuck = await runService.getRun(run.runId);
    expect(stuck!.status).toBe('running');

    // Push it past the stale window and redeliver, exactly as a broker would.
    await db
      .update(agentRuns)
      .set({ startedAt: new Date(Date.now() - RUN_STALE_MS - 1_000) })
      .where(eq(agentRuns.id, run.runId));
    await processAgentRunJob(workerDeps(), payload);

    expect(await itemCount(), 'the committed write must not be repeated').toBe(1);
  });

  it('quarantines an abandoned run so it is actionable instead of invisible', async () => {
    // Refusing to replay is only half an answer: the run must stop looking alive,
    // or the dispatcher reads it as in-flight forever and the goal never moves.
    const runService = new AgentRunService(db, SITE);
    const run = await runService.ensureRun({ title: 'R3.1 quarantine', status: 'queued' });
    expect(await runService.claimQueuedRun(run.runId)).toBe(true);

    // Not yet stale: a live run must never be touched by the sweep.
    expect(await runService.quarantineStaleRuns()).toEqual([]);

    await db
      .update(agentRuns)
      .set({ startedAt: new Date(Date.now() - RUN_STALE_MS - 1_000) })
      .where(eq(agentRuns.id, run.runId));

    const quarantined = await runService.quarantineStaleRuns();
    expect(quarantined.map((r) => r.runId)).toEqual([run.runId]);

    const after = await runService.getRun(run.runId);
    expect(after!.status).toBe('failed');
    expect((after!.metrics as Record<string, unknown>)['stopReason']).toBe(STALE_RUN_STOP_REASON);
    expect(after!.error ?? '', 'the reason must tell an operator what to do').toMatch(
      /not retried automatically/i,
    );

    // Idempotent: a second pass has nothing left to quarantine.
    expect(await runService.quarantineStaleRuns()).toEqual([]);
  });

  it('leaves a run that finished normally alone', async () => {
    // The guard in the sweep's write: a run can complete between the candidate
    // read and the update, and overwriting a real outcome with `failed` would be
    // worse than doing nothing.
    const runService = new AgentRunService(db, SITE);
    const run = await runService.ensureRun({ title: 'R3.1 finished', status: 'queued' });
    await db
      .update(agentRuns)
      .set({ status: 'succeeded', startedAt: new Date(Date.now() - RUN_STALE_MS - 1_000) })
      .where(eq(agentRuns.id, run.runId));

    expect(await runService.quarantineStaleRuns()).toEqual([]);
    const after = await runService.getRun(run.runId);
    expect(after!.status).toBe('succeeded');
  });

  it('the multi-tenant sweep only visits sites with an abandoned run', async () => {
    const runService = new AgentRunService(db, SITE);
    const stale = await runService.ensureRun({ title: 'R3.1 sweep stale', status: 'queued' });
    const healthy = await runService.ensureRun({ title: 'R3.1 sweep healthy', status: 'queued' });
    expect(await runService.claimQueuedRun(stale.runId)).toBe(true);
    await db
      .update(agentRuns)
      .set({ startedAt: new Date(Date.now() - RUN_STALE_MS - 1_000) })
      .where(eq(agentRuns.id, stale.runId));

    const swept = await sweepStaleRuns({ db });
    expect(swept.filter((r) => r.siteId === SITE).map((r) => r.runId)).toEqual([stale.runId]);
    const untouched = await runService.getRun(healthy.runId);
    expect(untouched!.status, 'a queued run is not the sweep\'s business').toBe('queued');
  });

  it('a run cancelled between enqueue and pickup executes nothing', async () => {
    const runService = new AgentRunService(db, SITE);
    const run = await runService.ensureRun({ title: 'F3 cancel race', status: 'queued' });
    await runService.cancelRun(run.runId, 'cancelled_by_user');

    await processAgentRunJob(workerDeps(), createPayload(run.runId, run.goalId));

    expect(await itemCount(), 'a cancelled run must not write').toBe(0);
    const after = await runService.getRun(run.runId);
    expect(after!.status).toBe('cancelled');
  });

});
