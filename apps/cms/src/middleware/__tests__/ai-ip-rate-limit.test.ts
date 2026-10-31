/**
 * Per-client-IP rate limit for /api/v1/ai/* (#564, B147). It runs before
 * `withAuth`, so a blocked request must cost no auth work, no quota
 * reservation, no provider call and no audit row.
 */
import { MemoryCacheProvider, MemoryRateLimiter, type RateLimiterProvider } from '@lumibase/runtime';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, AuthPrincipal } from '../../env';
import { aiIpRateLimitedTotal } from '../../routes/metrics';
import { withAiIpRateLimit } from '../ai-ip-rate-limit';

const ctx = vi.hoisted(() => ({ audits: [] as unknown[] }));

vi.mock('../../modules/audit/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/audit/logger')>()),
  AuditLogger: class {
    async write(entry: unknown) {
      ctx.audits.push(entry);
    }
  },
}));

const IP = '203.0.113.7';

function buildApp(rateLimiter: RateLimiterProvider | undefined, opts: { ip?: string; siteId?: string } = {}) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('runtime', { rateLimiter } as never);
    c.set('ip', opts.ip ?? IP);
    c.set('siteId', opts.siteId ?? 'site_1');
    await next();
  });
  app.use('*', withAiIpRateLimit());
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

const post = (app: Hono<AppEnv>, path: string, env: Record<string, string>) =>
  app.request(path, { method: 'POST' }, env);

beforeEach(() => {
  ctx.audits = [];
  aiIpRateLimitedTotal.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('withAiIpRateLimit', () => {
  it('429s with Retry-After once the per-IP limit is exceeded, and counts it', async () => {
    const app = buildApp(new MemoryRateLimiter());
    const env = { LUMIBASE_AI_IP_RATE_LIMIT: '2' };
    expect((await post(app, '/api/v1/ai/decisions', env)).status).toBe(200);
    expect((await post(app, '/api/v1/ai/decisions', env)).status).toBe(200);
    const blocked = await post(app, '/api/v1/ai/decisions', env);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(await blocked.json()).toEqual({
      errors: [{ code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' }],
    });
    expect((await aiIpRateLimitedTotal.get()).values[0]?.value).toBe(1);
  });

  it('sets no X-RateLimit headers on allow (the general limiter owns them)', async () => {
    const res = await post(buildApp(new MemoryRateLimiter()), '/api/v1/ai/decisions', { LUMIBASE_AI_IP_RATE_LIMIT: '5' });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBeNull();
  });

  it('never limits paths outside /api/v1/ai (including /api/v1/aix)', async () => {
    const app = buildApp(new MemoryRateLimiter());
    const env = { LUMIBASE_AI_IP_RATE_LIMIT: '1' };
    for (let i = 0; i < 3; i++) {
      expect((await post(app, '/api/v1/items/posts', env)).status).toBe(200);
      expect((await post(app, '/api/v1/aix/x', env)).status).toBe(200);
    }
    expect((await post(app, '/api/v1/ai', env)).status).toBe(200);
    expect((await post(app, '/api/v1/ai/reviews', env)).status).toBe(429);
  });

  it('isolates budgets per site and per IP', async () => {
    const limiter = new MemoryRateLimiter(new Map());
    const env = { LUMIBASE_AI_IP_RATE_LIMIT: '1' };
    expect((await post(buildApp(limiter), '/api/v1/ai/decisions', env)).status).toBe(200);
    expect((await post(buildApp(limiter), '/api/v1/ai/decisions', env)).status).toBe(429);
    expect((await post(buildApp(limiter, { siteId: 'site_2' }), '/api/v1/ai/decisions', env)).status).toBe(200);
    expect((await post(buildApp(limiter, { ip: '198.51.100.9' }), '/api/v1/ai/decisions', env)).status).toBe(200);
  });

  it('is disabled with LUMIBASE_AI_IP_RATE_LIMIT=0 and skipped for an unknown IP', async () => {
    const off = buildApp(new MemoryRateLimiter());
    for (let i = 0; i < 4; i++) expect((await post(off, '/api/v1/ai/decisions', { LUMIBASE_AI_IP_RATE_LIMIT: '0' })).status).toBe(200);
    const consume = vi.fn();
    const unknown = buildApp({ consume } as unknown as RateLimiterProvider, { ip: 'unknown' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 4; i++) expect((await post(unknown, '/api/v1/ai/decisions', { LUMIBASE_AI_IP_RATE_LIMIT: '1' })).status).toBe(200);
    expect(consume).not.toHaveBeenCalled();
  });

  it('fails open when the limiter throws, or 503s with LUMIBASE_RATE_LIMIT_FAIL_CLOSED=true', async () => {
    const throwing = { consume: vi.fn().mockRejectedValue(new Error('redis down')) } as unknown as RateLimiterProvider;
    expect((await post(buildApp(throwing), '/api/v1/ai/decisions', { LUMIBASE_AI_IP_RATE_LIMIT: '1' })).status).toBe(200);
    const closed = await post(buildApp(throwing), '/api/v1/ai/decisions', {
      LUMIBASE_AI_IP_RATE_LIMIT: '1',
      LUMIBASE_RATE_LIMIT_FAIL_CLOSED: 'true',
    });
    expect(closed.status).toBe(503);
    expect(((await closed.json()) as { errors: Array<{ code: string }> }).errors[0]?.code).toBe('RATE_LIMIT_UNAVAILABLE');
    // A missing limiter is "unavailable" too.
    expect((await post(buildApp(undefined), '/api/v1/ai/decisions', { LUMIBASE_RATE_LIMIT_FAIL_CLOSED: 'true' })).status).toBe(503);
  });

  it('keys rl:{siteId}:aiip:{16-hex hash}, never the raw IP', async () => {
    const limiter = new MemoryRateLimiter();
    const consume = vi.spyOn(limiter, 'consume');
    await post(buildApp(limiter), '/api/v1/ai/decisions', {});
    expect(consume).toHaveBeenCalledTimes(1);
    const [key, limit, window] = consume.mock.calls[0]!;
    expect(key).toMatch(/^rl:site_1:aiip:[0-9a-f]{16}$/);
    expect(key).not.toContain(IP);
    expect(limit).toBe(300);
    expect(window).toBe(60);
  });
});

describe('ordering: a 429 costs no auth, quota, provider or audit work', () => {
  it('the second request from one IP stops before auth and the decision route', async () => {
    const { aiRouter } = await import('../../routes/ai');
    const cache = new MemoryCacheProvider();
    const increment = vi.spyOn(cache, 'increment');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const authSpy = vi.fn();
    const rateLimiter = new MemoryRateLimiter();
    const publishable: AuthPrincipal = {
      type: 'api_key',
      apiKeyId: 'key_pub',
      apiKey: { id: 'key_pub', prefix: 'lbk_pub_abcd1234' },
      roles: [],
      raw: { apiKey: { id: 'key_pub', prefix: 'lbk_pub_abcd1234' } },
    };
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('ip', IP);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_1');
      c.set('db', {} as AppEnv['Variables']['db']);
      c.set('runtime', { cache, rateLimiter } as never);
      await next();
    });
    app.use('*', withAiIpRateLimit());
    app.use('*', async (c, next) => {
      authSpy();
      c.set('auth', publishable);
      await next();
    });
    app.route('/api/v1/ai', aiRouter);
    const env = { LUMIBASE_AI_IP_RATE_LIMIT: '1', DECISION_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'k' };
    const body = JSON.stringify({ state: { a: 1 }, questions: {} });
    const send = () =>
      app.request('/api/v1/ai/decisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body }, env);

    // No DB here: capability resolution fails closed (logged), so the first
    // request passes the limiter and is refused by authorizeDecision.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await send()).status).toBe(403);
    expect(authSpy).toHaveBeenCalledTimes(1);
    // …and that refusal did count and audit, so the zeros below mean something.
    expect(increment.mock.calls.some(([key]) => String(key).startsWith('dra:site_1:'))).toBe(true);
    expect(ctx.audits).toHaveLength(1);
    authSpy.mockClear();
    increment.mockClear();
    ctx.audits = [];

    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(authSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(increment.mock.calls.filter(([key]) => /^(dq|dra):/.test(String(key)))).toHaveLength(0);
    expect(ctx.audits).toHaveLength(0);
  });
});
