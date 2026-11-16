import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { localeGenerationRouter } from '../locale-generation';

/**
 * Request validation of the locale generator (#714) that happens before any
 * database access: body shape, and the refusal to fall back silently on the
 * `echo` test provider when no MT provider is configured.
 */

function app(env: Record<string, unknown> = {}) {
  const root = new Hono<AppEnv>();
  root.use('*', async (c, next) => {
    c.set('siteId', 'site_x');
    c.set('db', {} as never);
    await next();
  });
  root.route('/', localeGenerationRouter);
  return { request: (path: string, init?: RequestInit) => root.request(path, init, env) };
}

const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /locale-generation/jobs — pre-database checks', () => {
  it('rejects an invalid body', async () => {
    const res = await app().request('/jobs', post({ locale: 'ja', extra: true }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('VALIDATION');
  });

  it('refuses to use the echo fallback implicitly when no MT provider is configured', async () => {
    const res = await app().request('/jobs', post({ locale: 'ja', collections: ['posts'] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string; message: string }> };
    expect(body.errors[0]).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(body.errors[0]!.message).toContain('echo');
  });

  it('rejects a named provider that is not configured', async () => {
    const res = await app({ DEEPL_API_KEY: 'k' }).request('/jobs', post({ locale: 'ja', collections: ['posts'], provider: 'openai' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('validates a bulk decision body', async () => {
    const res = await app().request('/suggestions/decide-bulk', post({ decision: 'maybe', locale: 'ja' }));
    expect(res.status).toBe(400);
  });
});
