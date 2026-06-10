import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { healthRouter } from '../health';

function buildApp(options?: { unhealthy?: boolean }) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('runtime', {
      runtime: 'docker',
      database: {
        getConnection: () => async () => {
          if (options?.unhealthy) throw new Error('db down');
          return [{ ok: 1 }];
        },
        close: async () => {},
      },
      cache: {
        get: async () => (options?.unhealthy ? null : 'ok'),
        set: async () => {},
        delete: async () => {},
      },
      search: {
        getIndex: async () => {
          if (options?.unhealthy) throw new Error('connection refused');
          throw new Error('index_not_found');
        },
      },
      storage: {
        list: async () => {
          if (options?.unhealthy) throw new Error('storage down');
          return [];
        },
      },
      queue: {
        enqueue: async () => (options?.unhealthy ? '' : 'job_1'),
      },
    } as never);
    await next();
  });
  app.route('/health', healthRouter);
  return app;
}

describe('health routes', () => {
  it('keeps /health as a 200 degraded-info endpoint', async () => {
    const res = await buildApp({ unhealthy: true }).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'degraded' });
  });

  it('exposes /health/ready with a 503 when dependencies are degraded', async () => {
    const res = await buildApp({ unhealthy: true }).request('/health/ready');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'degraded' });
  });

  it('returns 200 from /health/ready when all probes are healthy', async () => {
    const res = await buildApp().request('/health/ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'healthy' });
  });
});
