import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deploymentsRouter } from '../deployments';
import { DeploymentService } from '../../services/deployment/deployment-service';
import type { AppEnv } from '../../env';
/**
 * `GET /api/v1/deployments?limit=` validation (B162, issue #568). An invalid
 * `limit` used to reach the query as `NaN` or a negative number, which drizzle
 * drops (unbounded list), or as a fraction, which fails the query (500). It is
 * now rejected with 400 before the service runs; valid values,
 * including `0` and ones above the 200 cap, behave as before.
 */
function appWith(list: ReturnType<typeof vi.fn>) {
  vi.spyOn(DeploymentService.prototype, 'listDeployments').mockImplementation(list as never);
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', 'site-a');
    c.set('auth', { roles: ['admin'], raw: { dev: true } } as never);
    c.set('db', {} as never);
    c.set('runtime', { keys: {} } as never);
    await next();
  });
  app.route('/deployments', deploymentsRouter);
  return app;
}

describe('GET /deployments limit validation', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['abc', '-5', '1.5', 'Infinity'])('rejects limit=%s with 400 VALIDATION', async (raw) => {
    const list = vi.fn(async () => []);
    const res = await appWith(list).request(`/deployments?limit=${raw}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe('VALIDATION');
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    ['', undefined],
    ['0', 0], // empty list, unchanged
    ['25', 25],
    ['500', 500], // the service caps it at 200, unchanged
  ])('passes limit=%s through as %s', async (raw, expected) => {
    const list = vi.fn(async () => []);
    const res = await appWith(list).request(`/deployments?limit=${raw}&status=ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(list).toHaveBeenCalledWith({ targetId: undefined, status: 'ready', limit: expected });
  });
});
