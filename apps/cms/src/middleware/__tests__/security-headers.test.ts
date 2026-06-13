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
});
