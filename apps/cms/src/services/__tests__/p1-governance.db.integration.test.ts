import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { agentGoals, agentRuns, agentToolCalls, contentIntents, sites, type Database } from '@lumibase/database';
import type { QueueProvider, RuntimeContext } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { agentRouter } from '../../routes/agent';
import { intentsRouter } from '../../routes/intents';
import { processCloudflareAgentQueue } from '../../cloudflare-agent-queue';
import { processAgentRunJob, type AgentRunJobPayload } from '../agent-run-worker';

const SITE = 'p1-governance-a';
const OTHER = 'p1-governance-b';
describe.skipIf(!hasDbIntegrationUrl)('P1 governance: real PostgreSQL + routes + worker', () => {
  let db: Database;
  beforeAll(async () => { db = await connectDbIntegration('p1-governance'); });
  async function clean() {
    for (const site of [SITE, OTHER]) await db.delete(sites).where(eq(sites.id, site));
  }
  beforeEach(async () => {
    await clean();
    await db.insert(sites).values([{ id: SITE, name: 'P1 A' }, { id: OTHER, name: 'P1 B' }]);
  });
  afterAll(async () => { if (db) await clean(); });
  function app() {
    const jobs: AgentRunJobPayload[] = [];
    const queue: QueueProvider = {
      enqueue: async (_queue, _name, data) => { jobs.push(data as AgentRunJobPayload); return 'job'; },
      process: () => {}, getStatus: async () => null,
    };
    const hono = new Hono<AppEnv>();
    hono.use('*', async (c, next) => {
      c.set('db', db); c.set('siteId', SITE);
      c.set('auth', { roles: ['admin'], raw: { dev: true } });
      c.set('runtime', { queue } as RuntimeContext);
      await next();
    });
    hono.route('/agent', agentRouter); hono.route('/intents', intentsRouter);
    return { hono, jobs };
  }
  it('renaming an intent keeps its L0 ceiling and strict budget, without touching another site', async () => {
    const budget = { maxGoalsPerCycle: 1, maxWritesPerMinute: 1, maxCostUsd: 0.1 };
    const inserted = await db.insert(contentIntents).values([SITE, OTHER].map((siteId) => ({
      siteId, name: 'original', collection: 'posts', schedule: '0 * * * *',
      rules: [{ type: 'required_fields', fields: ['title'] }], autonomyCap: 0, budget,
    }))).returning();
    const { hono } = app();
    const res = await hono.request(`/intents/${inserted[0]!.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'renamed' }),
    }, { LUMIBASE_ENV: 'development' });
    expect(res.status, await res.text()).toBe(200);
    for (const row of inserted) {
      const [actual] = await db.select().from(contentIntents).where(and(eq(contentIntents.siteId, row.siteId), eq(contentIntents.id, row.id)));
      expect(actual).toMatchObject({ name: row.siteId === SITE ? 'renamed' : 'original', autonomyCap: 0, budget });
    }
  });
  it.each(['worker', 'legacy', 'cloudflare'])('async maxToolCalls=0 prevents execution (%s transport)', async (transport) => {
    const { hono, jobs } = app();
    const res = await hono.request('/agent/goals', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'bounded', execution: 'async', budget: { maxToolCalls: 0 }, task: { skillName: 'listCollections', arguments: {} } }),
    }, { LUMIBASE_ENV: 'development' });
    expect(res.status, await res.text()).toBe(202);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.budget).toEqual({ maxToolCalls: 0 });
    const job = { ...jobs[0]! };
    if (transport === 'legacy') delete job.budget;
    if (transport === 'cloudflare') {
      let acknowledged = false;
      const batch: MessageBatch<unknown> = {
        queue: 'lumibase-agent-runs-local', metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, ackAll: () => {}, retryAll: () => {},
        messages: [{ id: 'job', timestamp: new Date(), attempts: 1,
          body: { id: 'job', jobName: 'execute', data: job },
          ack: () => { acknowledged = true; }, retry: () => { throw new Error('unexpected retry'); },
        }],
      };
      await processCloudflareAgentQueue(batch, { LUMIBASE_ENV: 'development', DATABASE_URL: process.env.DATABASE_URL });
      expect(acknowledged).toBe(true);
    } else await processAgentRunJob({ db, env: { LUMIBASE_ENV: 'development', LLM_PROVIDER: 'echo' } }, job);
    const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.siteId, SITE), eq(agentRuns.id, job.runId)));
    expect(run).toMatchObject({ status: 'failed', budget: { maxToolCalls: 0 }, metrics: { stopReason: 'max_tool_calls' } });
    expect(await db.select().from(agentToolCalls).where(eq(agentToolCalls.siteId, SITE))).toEqual([]);
    // At-least-once delivery must not execute the already-settled run.
    await processAgentRunJob({ db, env: { LUMIBASE_ENV: 'development' } }, job);
    expect(await db.select().from(agentToolCalls).where(eq(agentToolCalls.siteId, SITE))).toEqual([]);
    expect(await db.select().from(agentGoals).where(eq(agentGoals.siteId, OTHER))).toEqual([]);
  });
});
