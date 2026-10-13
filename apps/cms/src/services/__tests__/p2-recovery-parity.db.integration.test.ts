import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { agentGoals, agentRuns, auditLog, cdcSubscriptions, extensions, flows, sites, type Database } from '@lumibase/database';
import type { CacheProvider, QueueProvider, RuntimeContext } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { agentRouter } from '../../routes/agent';
import { flowsRouter } from '../../routes/flows';
import { extensionsRouter } from '../../routes/extensions';
import { OutboxWriter } from '../../modules/cdc/change-feed/outbox-writer';
import { AgentRunService, RUN_STALE_MS, sweepStaleRuns } from '../agent-run-service';
import { AISecureHarness } from '../ai-harness';
import { ExtensionsService } from '../extensions-service';
import { ExtensionVerifierService } from '../extension-verifier';
import { PermissionService } from '../permission-service';
import { SchemaService } from '../schema-service';
import type { AgentRunJobPayload } from '../agent-run-worker';

const SITE = 'p2-parity-a', OTHER = 'p2-parity-b';
const context = { siteId: SITE, userId: null, roleId: null, user: { roles: ['admin'], dev: true }, ip: null, headers: {}, apiKey: null };
const env = { LUMIBASE_ENV: 'development', LUMIBASE_EXT_SIGNATURE_POLICY: 'warn' } as const;
const activeFlow = { name: 'scheduled', status: 'active', triggerType: 'schedule', triggerOptions: { cron: '* * * * *' }, graph: { entry: 'start', nodes: [{ id: 'start', key: 'log', options: { message: 'hello' } }] } };

describe.skipIf(!hasDbIntegrationUrl)('P2: PostgreSQL recovery and REST/skill parity', () => {
  let db: Database;
  beforeAll(async () => { db = await connectDbIntegration('p2-parity'); });
  async function clean() { for (const id of [SITE, OTHER]) await db.delete(sites).where(eq(sites.id, id)); }
  beforeEach(async () => { await clean(); await db.insert(sites).values([{ id: SITE, name: 'A' }, { id: OTHER, name: 'B' }]); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { if (db) await clean(); });
  function fixture() {
    const values = new Map<string, string>();
    const cache = { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); }, invalidateByTag: async () => {} } as unknown as CacheProvider;
    const jobs: AgentRunJobPayload[] = [];
    const enqueue = vi.fn<QueueProvider['enqueue']>(async (_q, _name, data) => { jobs.push(data as AgentRunJobPayload); return 'job'; });
    const queue: QueueProvider = { enqueue, process: () => {}, getStatus: async () => null };
    const service = new ExtensionsService({ db, siteId: SITE, permissionCtx: context, cache, env });
    const harness = new AISecureHarness({ db, siteId: SITE, schemaService: new SchemaService({ db, siteId: SITE }), extensionsService: service, cache, enableAgentHarnessAudit: false });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('db', db); c.set('siteId', SITE); c.set('auth', { roles: ['admin'], raw: { dev: true } }); c.set('runtime', { cache, queue } as RuntimeContext); await next(); });
    app.route('/agent', agentRouter); app.route('/flows', flowsRouter); app.route('/extensions', extensionsRouter);
    const request = (path: string, body: unknown, method = 'POST') => app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);
    return { service, harness, request, cache, enqueue, queue, jobs };
  }
  it('enqueue failure settles the run, retains a masked task, and permits an actual retry', async () => {
    const f = fixture(); f.enqueue.mockRejectedValueOnce(new Error('provider credential must not leak'));
    const response = await f.request('/agent/goals', { title: 'retry me', execution: 'async', task: { skillName: 'listCollections', arguments: {} }, budget: { maxToolCalls: 1 } });
    expect(response.status).toBe(503);
    const body = await response.json() as { errors: Array<{ runId: string; goalId: string }> };
    const id = body.errors[0]!.runId;
    const svc = new AgentRunService(db, SITE, f.queue);
    expect(await svc.getRun(id)).toMatchObject({ status: 'failed', metrics: { stopReason: 'enqueue_failed' } });
    const retry = await svc.retryRun(id, { principal: { type: 'dev', siteId: SITE, roles: ['admin'] }, userId: null });
    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    expect(f.jobs[0]).toMatchObject({ siteId: SITE, skillName: 'listCollections', arguments: {}, budget: { maxToolCalls: 1 } });
    expect(JSON.stringify(body)).not.toContain('credential');
    expect(await new AgentRunService(db, OTHER, f.queue).getRun(id)).toBeNull();
  });
  it('an accepted delivery winning the claim is not overwritten by enqueue compensation', async () => {
    const svc = new AgentRunService(db, SITE);
    const run = await svc.ensureRun({ title: 'claimed', status: 'queued' });
    expect(await svc.claimQueuedRun(run.runId)).toBe(true);
    expect(await svc.failQueuedRun(run.runId, 'enqueue_failed')).toBe(false);
    expect(await svc.getRun(run.runId)).toMatchObject({ status: 'running' });
  });
  it('sweep releases old queued runs of any origin, preserves young and other-tenant runs, rejects late delivery', async () => {
    const svc = new AgentRunService(db, SITE);
    const old = await svc.ensureRun({ title: 'lost job', status: 'queued' });
    const young = await svc.ensureRun({ title: 'young', status: 'queued' });
    const other = await new AgentRunService(db, OTHER).ensureRun({ title: 'other', status: 'queued' });
    await db.update(agentRuns).set({ createdAt: new Date(Date.now() - RUN_STALE_MS - 1000) }).where(and(eq(agentRuns.siteId, SITE), eq(agentRuns.id, old.runId)));
    await sweepStaleRuns({ db });
    expect(await svc.getRun(old.runId)).toMatchObject({ status: 'failed', metrics: { stopReason: 'queue_timeout' } });
    expect(await svc.claimQueuedRun(old.runId)).toBe(false);
    expect(await svc.getRun(young.runId)).toMatchObject({ status: 'queued' });
    expect(await new AgentRunService(db, OTHER).getRun(other.runId)).toMatchObject({ status: 'queued' });
  });
  it('masked task arguments cannot be replayed as literal masked values', async () => {
    const f = fixture(); f.enqueue.mockRejectedValueOnce(new Error('offline'));
    await f.request('/agent/goals', { title: 'secret', execution: 'async', task: { skillName: 'createWebhook', arguments: { secret: 'never-persist-raw' } } });
    const [goal] = await db.select().from(agentGoals).where(eq(agentGoals.siteId, SITE));
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.siteId, SITE));
    expect(JSON.stringify(goal!.metadata)).not.toContain('never-persist-raw');
    expect(await new AgentRunService(db, SITE, f.queue).retryRun(run!.id, { principal: { type: 'dev', siteId: SITE, roles: ['admin'] }, userId: null })).toMatchObject({ ok: false, code: 'RETRY_UNRECOVERABLE' });
  });
  it('REST and skill reject invalid active graphs and cron; valid schedules get nextRunAt', async () => {
    const f = fixture();
    for (const input of [{ ...activeFlow, graph: { entry: 'start', nodes: [{ id: 'start', key: 'log', next: 'missing' }] } }, { ...activeFlow, triggerOptions: { cron: 'wrong' } }]) {
      expect((await f.request('/flows', input)).status).toBe(400);
      expect((await f.harness.runSkill('createFlow', input)).success).toBe(false);
    }
    expect(await db.select().from(flows).where(eq(flows.siteId, SITE))).toEqual([]);
    expect((await f.request('/flows', activeFlow)).status).toBe(201);
    const result = await f.harness.runSkill('createFlow', { ...activeFlow, name: 'agent schedule' });
    expect(result.success, JSON.stringify(result)).toBe(true);
    const rows = await db.select().from(flows).where(eq(flows.siteId, SITE));
    expect(rows).toHaveLength(2); for (const row of rows) expect(row.nextRunAt).toBeInstanceOf(Date);
    expect(await db.select().from(flows).where(eq(flows.siteId, OTHER))).toEqual([]);
  });
  it('both extension surfaces enforce per-action permission and reserved namespace before insertion', async () => {
    const f = fixture();
    const input = { name: 'lumibase-untrusted', version: '1', type: 'panel', enabled: true, bundleUrl: 'https://example.com/test.js', capabilities: ['items:write'] };
    const can = vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(null);
    const verifier = vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: false, isOfficial: false, reason: 'missing-fields' });
    expect((await f.request('/extensions', input)).status).toBe(403);
    expect((await f.harness.runSkill('installExtension', input)).success).toBe(false);
    expect(verifier).not.toHaveBeenCalled();
    can.mockImplementation(async (collection, action) => ({ collection, action, rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] }));
    expect((await f.request('/extensions', input)).status).toBe(400);
    const result = await f.harness.runSkill('installExtension', input);
    expect(result).toMatchObject({ success: false }); if (result.success) throw new Error('unexpected install');
    expect(result.error).toContain('lumibase-*');
    for (const action of ['install', 'enable', 'grant_capability']) expect(can).toHaveBeenCalledWith('extensions', action);
    expect(await db.select().from(extensions).where(eq(extensions.siteId, SITE))).toEqual([]);
  });
  it('skill refuses enabling an unverified official extension and syncing a hook updates CDC', async () => {
    const f = fixture();
    vi.spyOn(PermissionService.prototype, 'canAccess').mockImplementation(async (collection, action) => ({ collection, action, rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] }));
    const [row] = await db.insert(extensions).values({ siteId: SITE, key: 'hook', name: 'hook', version: '1', type: 'hook', bundleUrl: 'https://example.com/test.js', isOfficial: true, enabled: false, capabilities: ['cdc:subscribe:*'] }).returning();
    expect((await f.request(`/extensions/${row!.id}`, { enabled: true }, 'PATCH')).status).toBe(400);
    expect((await f.harness.runSkill('updateExtension', { id: row!.id, enabled: true })).success).toBe(false);
    await db.update(extensions).set({ isOfficial: false }).where(and(eq(extensions.siteId, SITE), eq(extensions.id, row!.id)));
    expect((await f.harness.runSkill('updateExtension', { id: row!.id, enabled: true })).success).toBe(true);
    const [sub] = await db.select().from(cdcSubscriptions).where(eq(cdcSubscriptions.siteId, SITE));
    expect(sub).toMatchObject({ name: 'ext:hook', status: 'active' });
    expect(await db.select().from(cdcSubscriptions).where(eq(cdcSubscriptions.siteId, OTHER))).toEqual([]);
  });
  it('CDC skill preserves snapshot mode, invalidates a cached disabled feed, and writes audit', async () => {
    const f = fixture();
    const writer = new OutboxWriter({ db, siteId: SITE, cache: f.cache, getSensitiveFields: async () => new Set() });
    expect(await writer.isFeedEnabled()).toBe(false);
    const result = await f.harness.runSkill('createCdcSubscription', { name: 'agent-feed', kind: 'pull', payload_mode: 'snapshot' });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(await writer.isFeedEnabled()).toBe(true);
    const [row] = await db.select().from(cdcSubscriptions).where(eq(cdcSubscriptions.siteId, SITE));
    expect(row!.payloadMode).toBe('snapshot');
    const events = await db.select().from(auditLog).where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'cdc_subscription_created')));
    expect(events).toHaveLength(1);
    expect(await db.select().from(cdcSubscriptions).where(eq(cdcSubscriptions.siteId, OTHER))).toEqual([]);
  });
});
