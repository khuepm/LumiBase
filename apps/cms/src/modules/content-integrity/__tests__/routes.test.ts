import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../../env';

const build = vi.fn(async (input: { siteId: string; days: number }) => ({ siteId: input.siteId, days: input.days }));
vi.mock('../digest', () => ({ buildContentDigest: (input: { siteId: string; days: number }) => build(input) }));

const { contentIntegrityRouter } = await import('../routes');

function app(roles: string[]) {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('auth', { roles } as never);
    c.set('siteId', 'site_a');
    c.set('db', {} as never);
    await next();
  });
  a.route('/api/v1/admin/security', contentIntegrityRouter);
  return a;
}

describe('GET /admin/security/content-integrity/digest (#989)', () => {
  it('serves the active site digest to an admin, 7 days by default', async () => {
    const res = await app(['admin']).request('/api/v1/admin/security/content-integrity/digest');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { siteId: 'site_a', days: 7 } });
  });

  it('refuses a non-admin', async () => {
    expect((await app(['editor']).request('/api/v1/admin/security/content-integrity/digest')).status).toBe(403);
  });

  it.each(['0', '32', '1.5', 'x'])('rejects days=%s', async (days) => {
    expect((await app(['admin']).request(`/api/v1/admin/security/content-integrity/digest?days=${days}`)).status).toBe(400);
  });
});

describe('weekly digest scheduling', () => {
  it('runs from the hourly cron on Node and on Workers', () => {
    const src = (f: string) => readFileSync(join(__dirname, '../../../', f), 'utf8');
    expect(src('serve.ts')).toContain('runWeeklyContentDigest');
    expect(src('cloudflare.ts')).toContain('runWeeklyContentDigest');
    expect(src('index.ts')).toContain("api.route('/admin/security', contentIntegrityRouter)");
  });
});
