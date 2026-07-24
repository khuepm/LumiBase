import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { withDeprecation } from '../deprecation';

function buildApp(options?: Parameters<typeof withDeprecation>[0]) {
  const app = new Hono<AppEnv>();
  app.use('*', withDeprecation(options));
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

describe('withDeprecation (OWASP API9)', () => {
  it('sets Deprecation: true when no date is provided', async () => {
    const res = await buildApp().request('/x');
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    expect(res.headers.get('Sunset')).toBeNull();
  });

  it('emits HTTP-date Deprecation and Sunset headers', async () => {
    const res = await buildApp({ since: '2026-07-01', sunset: '2026-10-01' }).request('/x');
    expect(res.headers.get('Deprecation')).toBe(new Date('2026-07-01').toUTCString());
    expect(res.headers.get('Sunset')).toBe(new Date('2026-10-01').toUTCString());
  });

  it('emits a Link rel="deprecation" header', async () => {
    const res = await buildApp({ link: 'https://docs.lumibase.dev/changelog#legacy' }).request('/x');
    expect(res.headers.get('Link')).toBe('<https://docs.lumibase.dev/changelog#legacy>; rel="deprecation"');
  });

  it('ignores unparseable dates and falls back to Deprecation: true', async () => {
    const res = await buildApp({ since: 'not-a-date' }).request('/x');
    expect(res.headers.get('Deprecation')).toBe('true');
  });
});
