import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { resolveMaxJsonBody, withJsonBodyLimit } from '../body-limit';

/**
 * Tests for the app-level JSON body-size guard
 * (high-load-cache-readiness Req 6.2).
 */

function appWith(env: Partial<AppEnv['Bindings']> = {}) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    // Emulate Hono binding env for c.env reads in the middleware.
    (c as unknown as { env: unknown }).env = env;
    await next();
  });
  app.use('*', withJsonBodyLimit());
  app.post('/api/v1/items/posts', (c) => c.json({ ok: true }, 201));
  app.get('/api/v1/items/posts', (c) => c.json({ ok: true }));
  return app;
}

describe('resolveMaxJsonBody', () => {
  it('defaults to 1 MiB', () => {
    expect(resolveMaxJsonBody(undefined)).toBe(1024 * 1024);
  });
  it('honours a configured value', () => {
    expect(resolveMaxJsonBody('2048')).toBe(2048);
  });
  it('falls back to default on garbage / non-positive', () => {
    expect(resolveMaxJsonBody('nope')).toBe(1024 * 1024);
    expect(resolveMaxJsonBody('0')).toBe(1024 * 1024);
    expect(resolveMaxJsonBody('-9')).toBe(1024 * 1024);
  });
});

describe('withJsonBodyLimit', () => {
  it('rejects an oversized JSON body with 413', async () => {
    const res = await appWith({ LUMIBASE_MAX_JSON_BODY: '100' }).request('/api/v1/items/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '500' },
      body: JSON.stringify({ data: 'x'.repeat(500) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      errors: [{ code: 'PAYLOAD_TOO_LARGE', message: expect.stringContaining('100 byte') }],
    });
  });

  it('allows a JSON body within the limit', async () => {
    const res = await appWith({ LUMIBASE_MAX_JSON_BODY: '10000' }).request('/api/v1/items/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '20' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(201);
  });

  it('ignores GET requests entirely', async () => {
    const res = await appWith({ LUMIBASE_MAX_JSON_BODY: '1' }).request('/api/v1/items/posts');
    expect(res.status).toBe(200);
  });

  it('ignores non-JSON content types (uploads have their own policy)', async () => {
    const res = await appWith({ LUMIBASE_MAX_JSON_BODY: '1' }).request('/api/v1/items/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data', 'Content-Length': '9999' },
      body: 'x'.repeat(50),
    });
    expect(res.status).toBe(201);
  });

  it('passes through when Content-Length is absent', async () => {
    const res = await appWith({ LUMIBASE_MAX_JSON_BODY: '1' }).request('/api/v1/items/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(201);
  });
});
