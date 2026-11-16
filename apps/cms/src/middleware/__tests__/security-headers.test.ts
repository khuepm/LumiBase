import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import {
  DEFAULT_STUDIO_FRAME_SRC,
  resolveStudioFrameSrc,
  serializeContentSecurityPolicy,
  withSecurityHeaders,
} from '../security-headers';

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

  describe('Studio frame-src for the live preview pane (#667, ADR-014)', () => {
    const htmlApp = (env: Record<string, string> = {}) => {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        (c as unknown as { env: Record<string, string> }).env = env;
        await next();
      });
      app.use('*', withSecurityHeaders());
      app.get('/', (c) => c.html('<!doctype html><div id="root"></div>'));
      app.get('/api', (c) => c.json({ ok: true }));
      app.get('/media/x', () =>
        new Response('<p>x</p>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'; sandbox" } }),
      );
      return app;
    };

    it('lets Studio HTML frame previews, but not JSON or sandboxed user content', async () => {
      const app = htmlApp();
      const studio = (await app.request('/')).headers.get('content-security-policy') ?? '';
      expect(studio).toContain(`frame-src ${DEFAULT_STUDIO_FRAME_SRC.join(' ')}`);
      // Studio itself still may not be framed.
      expect(studio).toContain("frame-ancestors 'none'");
      expect((await app.request('/api')).headers.get('content-security-policy')).not.toContain('frame-src');
      expect((await app.request('/media/x')).headers.get('content-security-policy')).not.toContain('frame-src');
    });

    it('never allows unsafe-eval or unsafe-inline scripts', async () => {
      const csp = (await htmlApp().request('/')).headers.get('content-security-policy') ?? '';
      expect(csp).not.toContain('unsafe-eval');
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    });

    it('honours LUMIBASE_STUDIO_FRAME_SRC and drops junk', async () => {
      const csp = (await htmlApp({ LUMIBASE_STUDIO_FRAME_SRC: 'https://www.example.com, http://localhost:3000' }).request('/'))
        .headers.get('content-security-policy');
      expect(csp).toMatch(/frame-src https:\/\/www\.example\.com http:\/\/localhost:3000(;|$)/);
      expect(resolveStudioFrameSrc("'none'")).toEqual(["'none'"]);
      expect(resolveStudioFrameSrc("javascript: 'unsafe-inline' *")).toEqual(["'none'"]);
      expect(resolveStudioFrameSrc('https://*.example.com data:')).toEqual(['https://*.example.com']);
      expect(resolveStudioFrameSrc(undefined)).toEqual(DEFAULT_STUDIO_FRAME_SRC);
    });
  });
});
