import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { MemoryRateLimiter } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { withRateLimit } from '../rate-limit';

function buildApp(opts: {
  rateLimiter?: MemoryRateLimiter;
  auth?: Record<string, unknown> | null;
  ip?: string;
}) {
  const rateLimiter = opts.rateLimiter ?? new MemoryRateLimiter();
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('runtime', { rateLimiter } as never);
    c.set('siteId', 'site-1');
    if (opts.ip) c.set('ip', opts.ip);
    if (opts.auth !== undefined) c.set('auth', opts.auth as never);
    await next();
  });
  app.use('*', withRateLimit());
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

const env = (over: Record<string, string> = {}) => ({
  LUMIBASE_API_RATE_LIMIT: '3',
  ...over,
});

describe('withRateLimit (CWE-400)', () => {
  it('allows requests under the limit and 429s once exceeded', async () => {
    const rateLimiter = new MemoryRateLimiter();
    const app = buildApp({ rateLimiter, ip: '1.2.3.4', auth: null });

    for (let i = 0; i < 3; i += 1) {
      const res = await app.request('/x', {}, env());
      expect(res.status).toBe(200);
      expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
    }

    const blocked = await app.request('/x', {}, env());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    const body = (await blocked.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe('RATE_LIMITED');
  });

  it('keys separate principals independently', async () => {
    const store = new Map<string, { count: number; resetAtMs: number }>();
    const rateLimiter = new MemoryRateLimiter(store);
    const appA = buildApp({ rateLimiter, auth: { userId: 'user-a' } });
    const appB = buildApp({ rateLimiter, auth: { userId: 'user-b' } });

    for (let i = 0; i < 3; i += 1) await appA.request('/x', {}, env());
    const aBlocked = await appA.request('/x', {}, env());
    expect(aBlocked.status).toBe(429);

    const bOk = await appB.request('/x', {}, env());
    expect(bOk.status).toBe(200);
  });

  it('is disabled when LUMIBASE_API_RATE_LIMIT=0', async () => {
    const rateLimiter = new MemoryRateLimiter();
    const app = buildApp({ rateLimiter, ip: '9.9.9.9', auth: null });
    for (let i = 0; i < 10; i += 1) {
      const res = await app.request('/x', {}, env({ LUMIBASE_API_RATE_LIMIT: '0' }));
      expect(res.status).toBe(200);
    }
  });

  it('skips /health and /metrics', async () => {
    const rateLimiter = new MemoryRateLimiter();
    const app = buildApp({ rateLimiter, auth: null });
    for (let i = 0; i < 10; i += 1) {
      expect((await app.request('/health', {}, env())).status).toBe(404);
      expect((await app.request('/metrics', {}, env())).status).toBe(404);
    }
  });

  it('fails open when no rate limiter is available', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('runtime', {} as never);
      c.set('siteId', 'site-1');
      await next();
    });
    app.use('*', withRateLimit());
    app.get('/x', (c) => c.json({ ok: true }));

    for (let i = 0; i < 10; i += 1) {
      const res = await app.request('/x', {}, env());
      expect(res.status).toBe(200);
    }
  });

  it('fails closed with 503 when no limiter is available and FAIL_CLOSED is set', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('runtime', {} as never);
      c.set('siteId', 'site-1');
      await next();
    });
    app.use('*', withRateLimit());
    app.get('/x', (c) => c.json({ ok: true }));

    const res = await app.request('/x', {}, env({ LUMIBASE_RATE_LIMIT_FAIL_CLOSED: 'true' }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe('RATE_LIMIT_UNAVAILABLE');
  });
});
