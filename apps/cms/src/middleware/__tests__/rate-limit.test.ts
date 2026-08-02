import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { withRateLimit } from '../rate-limit';

/** Minimal in-memory CacheProvider stand-in for the runtime cache. */
function makeCache() {
  const store = new Map<string, string>();
  return {
    store,
    get: async <T = string>(key: string): Promise<T | null> => {
      const raw = store.get(key);
      return raw == null ? null : (JSON.parse(raw) as T);
    },
    getEntry: async <T>(key: string) => {
      const raw = store.get(key);
      if (raw == null) return { state: 'miss' as const };
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (
          parsed &&
          typeof parsed === 'object' &&
          (parsed as { __lumi?: string }).__lumi === 'neg'
        ) {
          return { state: 'negative' as const };
        }
        return { state: 'hit' as const, value: parsed as T };
      } catch {
        return { state: 'unavailable' as const };
      }
    },
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    setNegative: async (key: string) => {
      store.set(key, JSON.stringify({ __lumi: 'neg', v: 1 }));
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

function buildApp(opts: {
  cache?: ReturnType<typeof makeCache>;
  auth?: Record<string, unknown> | null;
  ip?: string;
}) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (opts.cache) c.set('runtime', { cache: opts.cache } as never);
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
  LUMIBASE_RATE_LIMIT_MAX: '3',
  LUMIBASE_RATE_LIMIT_WINDOW_S: '60',
  ...over,
});

describe('withRateLimit (CWE-400)', () => {
  it('allows requests under the limit and 429s once exceeded', async () => {
    const cache = makeCache();
    const app = buildApp({ cache, ip: '1.2.3.4', auth: null });

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
    const cache = makeCache();
    const appA = buildApp({ cache, auth: { userId: 'user-a' } });
    const appB = buildApp({ cache, auth: { userId: 'user-b' } });

    // Exhaust user-a's budget.
    for (let i = 0; i < 3; i += 1) await appA.request('/x', {}, env());
    const aBlocked = await appA.request('/x', {}, env());
    expect(aBlocked.status).toBe(429);

    // user-b is unaffected.
    const bOk = await appB.request('/x', {}, env());
    expect(bOk.status).toBe(200);
  });

  it('is disabled via LUMIBASE_RATE_LIMIT_DISABLED', async () => {
    const cache = makeCache();
    const app = buildApp({ cache, ip: '9.9.9.9', auth: null });
    for (let i = 0; i < 10; i += 1) {
      const res = await app.request('/x', {}, env({ LUMIBASE_RATE_LIMIT_DISABLED: 'true' }));
      expect(res.status).toBe(200);
    }
  });

  it('fails open when no cache is available', async () => {
    const app = buildApp({ auth: null, ip: '5.5.5.5' }); // no cache set
    for (let i = 0; i < 10; i += 1) {
      const res = await app.request('/x', {}, env());
      expect(res.status).toBe(200);
    }
  });

  it('fails closed with 503 when no cache is available and FAIL_CLOSED is set', async () => {
    const app = buildApp({ auth: null, ip: '5.5.5.5' }); // no cache set
    const res = await app.request('/x', {}, env({ LUMIBASE_RATE_LIMIT_FAIL_CLOSED: 'true' }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe('RATE_LIMIT_UNAVAILABLE');
  });

  it('fails closed with 503 when the cache read throws and FAIL_CLOSED is set', async () => {
    const cache = makeCache();
    cache.get = async () => {
      throw new Error('cache down');
    };
    const app = buildApp({ cache, ip: '6.6.6.6', auth: null });
    const res = await app.request('/x', {}, env({ LUMIBASE_RATE_LIMIT_FAIL_CLOSED: 'true' }));
    expect(res.status).toBe(503);
  });
});
