import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { metricsRouter } from '../metrics';

function appWithEnv(env: Partial<AppEnv['Bindings']>) {
  const app = new Hono<AppEnv>();
  app.route('/metrics', metricsRouter);
  return { app, env: env as AppEnv['Bindings'] };
}

describe('metrics route access control', () => {
  it('allows metrics in non-production without a token', async () => {
    const { app, env } = appWithEnv({ LUMIBASE_ENV: 'development' });

    const res = await app.request('/metrics', {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('hides metrics in production when METRICS_TOKEN is not configured', async () => {
    const { app, env } = appWithEnv({ LUMIBASE_ENV: 'production' });

    const res = await app.request('/metrics', {}, env);

    expect(res.status).toBe(404);
  });

  it('requires the configured bearer token in production', async () => {
    const { app, env } = appWithEnv({
      LUMIBASE_ENV: 'production',
      METRICS_TOKEN: 'metrics-secret',
    });

    const denied = await app.request('/metrics', { headers: { authorization: 'Bearer wrong' } }, env);
    const allowed = await app.request('/metrics', { headers: { authorization: 'Bearer metrics-secret' } }, env);

    expect(denied.status).toBe(404);
    expect(allowed.status).toBe(200);
  });
});
