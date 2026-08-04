import type { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { siteRouter } from '../site';

const BASE_SITE = {
  id: '__default__',
  name: 'LumiBase',
  domain: null as string | null,
  displayTitle: 'LumiBase',
  siteUrl: 'https://example.com',
  descriptor: null,
  defaultLanguage: 'en',
  defaultAppearance: 'auto',
  branding: {},
  themeOverrides: {},
  customCss: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

interface FakeDbOptions {
  /** Row returned by SELECT … FROM sites. `null` → no row (404). */
  existing?: typeof BASE_SITE | null;
  /** When set, UPDATE throws a Postgres error with this SQLSTATE. */
  updateError?: string;
  /** Place the SQLSTATE on `error.cause` (how Drizzle wraps driver errors). */
  updateErrorOnCause?: boolean;
  /** Captures the SET payload passed to UPDATE. */
  captured?: { set?: Record<string, unknown> };
}

function fakeDb(opts: FakeDbOptions): Database {
  const existing = opts.existing === undefined ? BASE_SITE : opts.existing;
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(existing ? [existing] : []),
  };
  const updateChain = {
    set: (payload: Record<string, unknown>) => {
      if (opts.captured) opts.captured.set = payload;
      return updateChain;
    },
    where: () => updateChain,
    returning: () => {
      if (opts.updateError) {
        if (opts.updateErrorOnCause) {
          // Mirror Drizzle: outer Error with the driver error on `cause`.
          const driver = new Error('duplicate key') as Error & { code: string };
          driver.code = opts.updateError;
          return Promise.reject(new Error('Failed query', { cause: driver }));
        }
        const err = new Error('duplicate key') as Error & { code: string };
        err.code = opts.updateError;
        return Promise.reject(err);
      }
      return Promise.resolve([{ ...existing, ...(opts.captured?.set ?? {}) }]);
    },
  };
  return {
    select: () => selectChain,
    update: () => updateChain,
  } as unknown as Database;
}

function buildApp(opts: FakeDbOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', fakeDb(opts));
    c.set('siteId', '__default__');
    // Minimal runtime stub; cache is optional in the handler.
    c.set('runtime', { cache: { delete: async () => {} } } as never);
    await next();
  });
  app.route('/api/v1/site', siteRouter);
  return app;
}

describe('GET /api/v1/site', () => {
  it('returns the active site row', async () => {
    const res = await buildApp({}).request('/api/v1/site');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe('__default__');
  });

  it('404s when the site row is missing', async () => {
    const res = await buildApp({ existing: null }).request('/api/v1/site');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/v1/site', () => {
  it('updates supplied identity fields and returns the row', async () => {
    const captured: { set?: Record<string, unknown> } = {};
    const res = await buildApp({ captured }).request('/api/v1/site', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayTitle: 'My Site', defaultLanguage: 'vi' }),
    });
    expect(res.status).toBe(200);
    expect(captured.set?.displayTitle).toBe('My Site');
    expect(captured.set?.defaultLanguage).toBe('vi');
    // Always stamps updatedAt.
    expect(captured.set?.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects invalid theme override tokens', async () => {
    const res = await buildApp({}).request('/api/v1/site', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ themeOverrides: { light: { '--evil': '0 0% 0%' } } }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects custom CSS containing a <style> tag', async () => {
    const res = await buildApp({}).request('/api/v1/site', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customCss: '</style><script>alert(1)</script>' }),
    });
    expect(res.status).toBe(400);
  });

  it('maps a domain unique-violation to DOMAIN_TAKEN 409', async () => {
    const res = await buildApp({ updateError: '23505' }).request('/api/v1/site', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'cms.example.com' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]?.code).toBe('DOMAIN_TAKEN');
  });

  it('maps a Drizzle-wrapped unique-violation (code on cause) to 409', async () => {
    const res = await buildApp({ updateError: '23505', updateErrorOnCause: true }).request(
      '/api/v1/site',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain: 'cms.example.com' }),
      },
    );
    expect(res.status).toBe(409);
  });

  it('clears a nullable field when given an empty string', async () => {
    const captured: { set?: Record<string, unknown> } = {};
    await buildApp({ captured }).request('/api/v1/site', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ descriptor: '' }),
    });
    expect(captured.set?.descriptor).toBeNull();
  });
});
