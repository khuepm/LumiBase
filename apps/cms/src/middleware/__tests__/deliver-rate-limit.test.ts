/**
 * Deliver IP rate-limit middleware tests
 * (high-load-cache-readiness Req 19.10–19.11).
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { MemoryRateLimiter } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { withDeliverRateLimit } from '../deliver-rate-limit';

function buildApp(rateLimiter: MemoryRateLimiter, ip = '203.0.113.9') {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('runtime', { rateLimiter } as never);
    c.set('ip', ip);
    await next();
  });
  app.use('*', withDeliverRateLimit());
  app.get('/api/v1/deliver/page/x/y', (c) => c.json({ ok: true }));
  return app;
}

describe('withDeliverRateLimit', () => {
  it('allows traffic under the limit and 429s with no-store once exceeded', async () => {
    const rateLimiter = new MemoryRateLimiter();
    const app = buildApp(rateLimiter);
    const env = { LUMIBASE_DELIVER_RATE_LIMIT: '3' };

    for (let i = 0; i < 3; i += 1) {
      const res = await app.request('/api/v1/deliver/page/x/y', {}, env);
      expect(res.status).toBe(200);
    }
    const blocked = await app.request('/api/v1/deliver/page/x/y', {}, env);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    expect(blocked.headers.get('Cache-Control')).toBe('no-store');
  });

  it('is disabled when LUMIBASE_DELIVER_RATE_LIMIT=0', async () => {
    const rateLimiter = new MemoryRateLimiter();
    const app = buildApp(rateLimiter);
    const env = { LUMIBASE_DELIVER_RATE_LIMIT: '0' };
    for (let i = 0; i < 5; i += 1) {
      expect((await app.request('/api/v1/deliver/page/x/y', {}, env)).status).toBe(200);
    }
  });

  it('keys budgets per IP', async () => {
    const store = new Map<string, { count: number; resetAtMs: number }>();
    const rateLimiter = new MemoryRateLimiter(store);
    const a = buildApp(rateLimiter, '1.1.1.1');
    const b = buildApp(rateLimiter, '2.2.2.2');
    const env = { LUMIBASE_DELIVER_RATE_LIMIT: '2' };
    await a.request('/api/v1/deliver/page/x/y', {}, env);
    await a.request('/api/v1/deliver/page/x/y', {}, env);
    expect((await a.request('/api/v1/deliver/page/x/y', {}, env)).status).toBe(429);
    expect((await b.request('/api/v1/deliver/page/x/y', {}, env)).status).toBe(200);
  });
});
