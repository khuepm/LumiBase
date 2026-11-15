import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../../env';
import { opsRouter } from '../routes';

const TOKEN = 't'.repeat(40);

function app() {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('requestId', 'r1');
    await next();
  });
  a.route('/api/v1/ops', opsRouter);
  return a;
}

describe('ops router gate', () => {
  it.each(['/api/v1/ops/diagnostics', '/api/v1/ops/errors', '/api/v1/ops/sites/s1/probe'])(
    '%s answers the canonical 404 without the token',
    async (path) => {
      const res = await app().request(path, {}, { LUMIBASE_OPS_TOKEN: TOKEN });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ errors: [{ code: 'NOT_FOUND', message: 'Route not found.' }] });
    },
  );

  it('answers 404 even with a bearer when no token is configured', async () => {
    const res = await app().request('/api/v1/ops/diagnostics', { headers: { authorization: `Bearer ${TOKEN}` } }, {});
    expect(res.status).toBe(404);
  });

  it('validates error filters behind the gate', async () => {
    const res = await app().request(
      '/api/v1/ops/errors?status=404',
      { headers: { authorization: `Bearer ${TOKEN}` } },
      { LUMIBASE_OPS_TOKEN: TOKEN },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
