import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { healthRouter } from '../health';

function never<T>(): Promise<T> {
  return new Promise(() => {
    // Intentionally never resolves. Used to ensure /health remains bounded.
  });
}

function buildApp(runtime: unknown) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('runtime', runtime as never);
    await next();
  });
  app.route('/health', healthRouter);
  return app;
}

describe('health route', () => {
  it('returns degraded quickly when dependency probes hang', async () => {
    const runtime = {
      database: {
        getConnection: () => () => never(),
      },
      cache: {
        set: () => never(),
        get: () => never(),
      },
      search: {
        getIndex: () => never(),
      },
      storage: {
        list: () => never(),
      },
      queue: {
        enqueue: () => never(),
      },
    };

    const start = Date.now();
    const res = await buildApp(runtime).request('/health');
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(1_500);
    expect(await res.json()).toEqual({
      status: 'degraded',
      services: {
        database: 'unhealthy',
        cache: 'unhealthy',
        search: 'unhealthy',
        storage: 'unhealthy',
        queue: 'unhealthy',
      },
    });
  });
});
