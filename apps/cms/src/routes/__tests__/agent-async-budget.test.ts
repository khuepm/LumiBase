import { type Database } from '@lumibase/database';
import type { QueueProvider } from '@lumibase/runtime';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import { AgentRunService } from '../../services/agent-run-service';
import { KillSwitchService } from '../../services/kill-switch-service';
import { agentRouter } from '../agent';

afterEach(() => vi.restoreAllMocks());
function fixture(available = true) {
  const insert = vi.fn(() => ({ values: () => ({ returning: async () => [{ id: 'goal-a' }] }) }));
  const enqueue = vi.fn<QueueProvider['enqueue']>().mockResolvedValue('job-a');
  const queue: QueueProvider = { enqueue, supportsQueue: () => available, process: () => {}, getStatus: async () => null };
  vi.spyOn(KillSwitchService.prototype, 'isSiteFrozen').mockResolvedValue(false);
  const ensureRun = vi.spyOn(AgentRunService.prototype, 'ensureRun').mockResolvedValue({ runId: 'run-a', goalId: 'goal-a', agentName: 'writer' });
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', { insert } as unknown as Database); c.set('siteId', 'site-a');
    c.set('auth', { roles: ['admin'], raw: { dev: true } });
    c.set('runtime', { queue } as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/', agentRouter);
  return { app, enqueue, ensureRun, insert };
}
const budget = { maxToolCalls: 0, maxWritesPerMinute: 1 };
const body = { title: 'bounded run', execution: 'async', task: { skillName: 'listCollections', arguments: {} }, budget };
function post(app: Hono<AppEnv>) {
  return app.request('/goals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { LUMIBASE_ENV: 'development' });
}
describe('async goal enqueue (B92/B10)', () => {
  it('carries exactly the saved budget and tenant/principal through the queue hop', async () => {
    const { app, enqueue, ensureRun } = fixture();
    expect((await post(app)).status).toBe(202);
    expect(ensureRun).toHaveBeenCalledWith(expect.objectContaining({ budget, status: 'queued' }));
    expect(enqueue).toHaveBeenCalledWith('agent-runs', 'execute', expect.objectContaining({
      budget, siteId: 'site-a', runId: 'run-a', principal: { type: 'dev', siteId: 'site-a', roles: ['admin'] },
    }));
  });
  it('refuses an unconfigured logical queue before inserting a goal or run', async () => {
    const { app, enqueue, insert, ensureRun } = fixture(false);
    const res = await post(app);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'ASYNC_UNAVAILABLE' }] });
    expect(insert).not.toHaveBeenCalled(); expect(ensureRun).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  });
});
