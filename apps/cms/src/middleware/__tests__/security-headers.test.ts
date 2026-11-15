import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { serializeContentSecurityPolicy, withSecurityHeaders } from '../security-headers';

describe('security headers middleware', () => {
  it('serializes Content Security Policy directives', () => {
    expect(serializeContentSecurityPolicy({ 'default-src': ["'none'"], 'img-src': ["'self'", 'data:'] })).toBe(
      "default-src 'none'; img-src 'self' data:",
    );
  });

  it('adds browser security headers to responses', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', withSecurityHeaders());
    app.get('/health', (c) => c.json({ ok: true }));

    const res = await app.request('/health');

    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('keeps a stricter route CSP (user-content sandbox) and adds the baseline alongside it (#740)', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', withSecurityHeaders());
    app.get('/media/x', () =>
      new Response('x', { headers: { 'Content-Security-Policy': "default-src 'none'; sandbox" } }),
    );

    const res = await app.request('/media/x');
    const csp = res.headers.get('content-security-policy') ?? '';
    // Both policies are delivered (and therefore both enforced by browsers).
    expect(csp).toContain('sandbox');
    expect(csp).toContain("script-src 'self'");
  });

  it('sends exactly the baseline when the route set none', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', withSecurityHeaders());
    app.get('/x', (c) => c.text('x'));
    const csp = (await app.request('/x')).headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain('sandbox');
    expect(csp.split(', ').length).toBe(1);
  });
});
