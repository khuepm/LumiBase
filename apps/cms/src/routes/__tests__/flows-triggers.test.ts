import type { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { flowsRouter } from '../flows';

/**
 * Flow trigger surface (visual-flow-builder tasks 2.3, 4.3, 5.2).
 *
 * **Validates: Requirements 2.3, 3.2, 5.2**
 */

const LOG_GRAPH = { entry: 'n1', nodes: [{ id: 'n1', key: 'log', options: { message: 'hi' } }] };

const WEBHOOK_FLOW = {
  id: 'f1',
  siteId: '__default__',
  name: 'wh',
  status: 'active',
  triggerType: 'webhook',
  triggerOptions: { token: 'secret-token' },
  graph: LOG_GRAPH,
};

interface FakeDbOptions {
  /** Rows resolved by SELECT chains (flow lookups). */
  flows?: Record<string, unknown>[];
  /** Captures INSERT payloads (flow creates + run rows). */
  inserted?: Record<string, unknown>[];
  /** Captures UPDATE payloads. */
  updates?: Record<string, unknown>[];
}

function fakeDb(opts: FakeDbOptions): Database {
  const db = {
    select() {
      const b: Record<string, unknown> = { from: () => b, where: () => Promise.resolve(opts.flows ?? []) };
      return b;
    },
    insert() {
      return {
        values(v: Record<string, unknown>) {
          opts.inserted?.push(v);
          return { returning: () => Promise.resolve([{ id: 'row_1', ...v }]) };
        },
      };
    },
    update() {
      return {
        set(set: Record<string, unknown>) {
          opts.updates?.push(set);
          const chain = { where: () => ({ returning: () => Promise.resolve([{ id: 'f1', ...set }]) }) };
          return chain;
        },
      };
    },
  };
  return db as unknown as Database;
}

function buildApp(opts: FakeDbOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', fakeDb(opts));
    c.set('siteId', '__default__');
    c.set('auth', { roles: ['admin'] } as never);
    c.set('runtime', { keys: undefined } as never);
    await next();
  });
  app.route('/api/v1/flows', flowsRouter);
  return app;
}

function post(app: Hono<AppEnv>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('GET /api/v1/flows/operations (Req 5.1, 5.3)', () => {
  it('returns the registered operation registry', async () => {
    const res = await buildApp({}).request('/api/v1/flows/operations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { operations: { key: string; description: string }[] } };
    const keys = body.data.operations.map((o) => o.key);
    expect(keys).toContain('log');
    expect(keys).toContain('http');
    expect(keys).toContain('deploy:trigger');
  });
});

describe('graph gate on save (Req 5.2)', () => {
  it('rejects activating a flow whose graph has a dangling edge', async () => {
    const res = await post(buildApp({}), '/api/v1/flows', {
      name: 'bad',
      status: 'active',
      triggerType: 'manual',
      graph: { entry: 'n1', nodes: [{ id: 'n1', key: 'log', next: 'ghost' }] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors.some((e) => e.code === 'GRAPH_DANGLING_EDGE')).toBe(true);
  });

  it('allows saving the same broken graph as a draft', async () => {
    const inserted: Record<string, unknown>[] = [];
    const res = await post(buildApp({ inserted }), '/api/v1/flows', {
      name: 'wip',
      status: 'draft',
      triggerType: 'manual',
      graph: { entry: 'n1', nodes: [{ id: 'n1', key: 'log', next: 'ghost' }] },
    });
    expect(res.status).toBe(201);
    expect(inserted).toHaveLength(1);
  });
});

describe('cron gate on save (Req 2.3)', () => {
  it('rejects an active schedule flow without a valid cron', async () => {
    const res = await post(buildApp({}), '/api/v1/flows', {
      name: 'sched',
      status: 'active',
      triggerType: 'schedule',
      triggerOptions: {},
      graph: LOG_GRAPH,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]?.code).toBe('CRON_REQUIRED');
  });

  it('rejects a malformed cron outright', async () => {
    const res = await post(buildApp({}), '/api/v1/flows', {
      name: 'sched',
      status: 'draft',
      triggerType: 'schedule',
      triggerOptions: { cron: 'every day at noon' },
      graph: LOG_GRAPH,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]?.code).toBe('CRON_INVALID');
  });

  it('activating with a valid cron computes next_run_at', async () => {
    const inserted: Record<string, unknown>[] = [];
    const res = await post(buildApp({ inserted }), '/api/v1/flows', {
      name: 'sched',
      status: 'active',
      triggerType: 'schedule',
      triggerOptions: { cron: '*/5 * * * *' },
      graph: LOG_GRAPH,
    });
    expect(res.status).toBe(201);
    expect(inserted[0]?.nextRunAt).toBeInstanceOf(Date);
  });
});

describe('POST /api/v1/flows/:id/trigger (Req 3.2)', () => {
  it('runs the flow and records a run for a valid token', async () => {
    const inserted: Record<string, unknown>[] = [];
    const updates: Record<string, unknown>[] = [];
    const res = await post(
      buildApp({ flows: [WEBHOOK_FLOW], inserted, updates }),
      '/api/v1/flows/f1/trigger',
      { hello: 'world' },
      { 'x-flow-token': 'secret-token' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { runId: string; status: string } };
    expect(body.data.status).toBe('success');
    expect(inserted[0]).toMatchObject({ flowId: 'f1', status: 'running' });
    expect((inserted[0]?.input as { body: unknown }).body).toEqual({ hello: 'world' });
    expect(updates[0]).toMatchObject({ status: 'success' });
  });

  it('rejects a wrong token with 401 and records nothing', async () => {
    const inserted: Record<string, unknown>[] = [];
    const res = await post(
      buildApp({ flows: [WEBHOOK_FLOW], inserted }),
      '/api/v1/flows/f1/trigger',
      {},
      { 'x-flow-token': 'wrong' },
    );
    expect(res.status).toBe(401);
    expect(inserted).toHaveLength(0);
  });

  it('404s for a non-webhook or inactive flow (no probing)', async () => {
    const manual = { ...WEBHOOK_FLOW, triggerType: 'manual' };
    const res = await post(buildApp({ flows: [manual] }), '/api/v1/flows/f1/trigger', {}, { 'x-flow-token': 'secret-token' });
    expect(res.status).toBe(404);

    const inactive = { ...WEBHOOK_FLOW, status: 'inactive' };
    const res2 = await post(buildApp({ flows: [inactive] }), '/api/v1/flows/f1/trigger', {}, { 'x-flow-token': 'secret-token' });
    expect(res2.status).toBe(404);
  });

  it('does not strip the run input of general headers but drops credentials', async () => {
    const inserted: Record<string, unknown>[] = [];
    await post(
      buildApp({ flows: [WEBHOOK_FLOW], inserted }),
      '/api/v1/flows/f1/trigger',
      {},
      { 'x-flow-token': 'secret-token', 'x-custom': 'yes', authorization: 'Bearer leak' },
    );
    const headers = (inserted[0]?.input as { headers: Record<string, string> }).headers;
    expect(headers['x-custom']).toBe('yes');
    expect(headers['authorization']).toBeUndefined();
    expect(headers['x-flow-token']).toBeUndefined();
  });
});
