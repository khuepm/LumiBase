import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { withRls } from '../rls';

/**
 * Build a tiny app that wires the request-scoped context the RLS middleware
 * reads (`siteId`, `runtime`) and a downstream 200 handler, so we can assert
 * whether the guard let the request through or failed closed.
 */
function buildApp(opts: {
  siteId: string | undefined;
  connection: unknown;
  env?: Record<string, string>;
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (opts.siteId !== undefined) c.set('siteId', opts.siteId);
    c.set('runtime', {
      database: { getConnection: () => opts.connection },
    } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.use('*', withRls());
  app.all('*', (c) => c.json({ ok: true }, 200));
  return app;
}

/** A postgres.js-style tagged-template stub whose query rejects. */
function failingConnection(): unknown {
  return () => Promise.reject(new Error('connection lost'));
}

/** A tagged-template stub whose query resolves (SET LOCAL succeeds). */
function okConnection(): unknown {
  return () => Promise.resolve([]);
}

describe('withRls — fail-closed on RLS scope failure', () => {
  it('rejects with 503 when SET LOCAL app.site_id fails in production', async () => {
    const app = buildApp({ siteId: 'site-a', connection: failingConnection() });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.request(
      '/anything',
      {},
      { LUMIBASE_ENV: 'production' },
    );
    errSpy.mockRestore();

    // RLS could not be established → the request must NOT reach the handler,
    // otherwise a single missed application-level `.where(siteId)` filter
    // would leak cross-tenant rows.
    expect(res.status).toBe(503);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]?.code).toBe('RLS_UNAVAILABLE');
  });

  it('passes through when SET LOCAL succeeds', async () => {
    const app = buildApp({ siteId: 'site-a', connection: okConnection() });
    const res = await app.request('/anything', {}, { LUMIBASE_ENV: 'production' });
    expect(res.status).toBe(200);
  });

  it('skips RLS (passes through) in development mode', async () => {
    // Dev mode intentionally skips the raw pool query (Wrangler I/O limits),
    // so a failing connection must not block the request there.
    const app = buildApp({ siteId: 'site-a', connection: failingConnection() });
    const res = await app.request('/anything', {}, { LUMIBASE_ENV: 'development' });
    expect(res.status).toBe(200);
  });

  it('passes through when no siteId is set (nothing to scope)', async () => {
    const app = buildApp({ siteId: undefined, connection: failingConnection() });
    const res = await app.request('/anything', {}, { LUMIBASE_ENV: 'production' });
    expect(res.status).toBe(200);
  });
});
