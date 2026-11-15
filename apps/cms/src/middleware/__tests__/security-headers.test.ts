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

  it('allows geolocation for the same origin only (Studio "Use my location", #746)', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', withSecurityHeaders());
    app.get('/', (c) => c.text('ok'));
    const policy = (await app.request('/')).headers.get('permissions-policy') ?? '';
    expect(policy).toContain('geolocation=(self)');
    for (const feature of ['camera=()', 'microphone=()', 'payment=()', 'usb=()']) expect(policy).toContain(feature);
    // The worker MapLibre starts is a same-origin file, so `script-src 'self'` covers it.
    expect((await app.request('/')).headers.get('content-security-policy')).toContain("script-src 'self'");
  });
});
