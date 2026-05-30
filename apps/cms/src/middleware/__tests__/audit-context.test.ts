import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { withAuditContext } from '../audit-context';

/**
 * Unit tests for the `audit-context` middleware (admin-setup-wizard
 * task 11.2; Req 15.1, 15.2; design §6.2).
 *
 * The middleware's job is to stash `ip` + `userAgent` onto the Hono
 * context (alongside the `requestId` that `withLogger` already sets) so
 * downstream handlers + the AuditLogger callers read the three audit
 * dimensions uniformly. We mount it on a tiny Hono app and use
 * `app.request` with `cf-connecting-ip` / `user-agent` headers to
 * assert what it resolves, plus confirm a pre-set `requestId` passes
 * straight through unchanged.
 *
 * **Validates: Requirements 15.1, 15.2**
 */

/**
 * Build a tiny app that mounts `withAuditContext()` and exposes the
 * resolved context values through a probe route. A leading middleware
 * pre-sets `requestId` exactly as `withLogger` would, so we can confirm
 * the audit-context middleware leaves it intact.
 */
function buildApp() {
  const app = new Hono<AppEnv>();
  // Stand in for `withLogger`, which sets requestId upstream.
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_fixed_123');
    await next();
  });
  app.use('*', withAuditContext());
  app.get('/probe', (c) =>
    c.json({
      ip: c.get('ip') ?? null,
      userAgent: c.get('userAgent') ?? null,
      requestId: c.get('requestId') ?? null,
    }),
  );
  return app;
}

describe('withAuditContext — Req 15.1, 15.2 (design §6.2)', () => {
  it('stashes the CF-Connecting-IP and User-Agent on the context', async () => {
    const app = buildApp();
    const res = await app.request('/probe', {
      headers: {
        'cf-connecting-ip': '203.0.113.7',
        'user-agent': 'vitest/1.0',
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ip: '203.0.113.7',
      userAgent: 'vitest/1.0',
      requestId: 'req_fixed_123',
    });
  });

  it('passes the upstream requestId through unchanged', async () => {
    const app = buildApp();
    const res = await app.request('/probe', {
      headers: { 'cf-connecting-ip': '198.51.100.4' },
    });
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe('req_fixed_123');
  });

  it('sets userAgent to null when the header is absent', async () => {
    const app = buildApp();
    const res = await app.request('/probe', {
      headers: { 'cf-connecting-ip': '198.51.100.4' },
    });
    const body = (await res.json()) as { userAgent: string | null };
    expect(body.userAgent).toBeNull();
  });

  it('falls back to the literal "unknown" when no IP signal is present', async () => {
    const app = buildApp();
    // No cf-connecting-ip, no x-forwarded-for, no remote-address
    // resolver → extractClientIp returns the sentinel 'unknown'.
    const res = await app.request('/probe', {
      headers: { 'user-agent': 'curl/8.0' },
    });
    const body = (await res.json()) as { ip: string };
    expect(body.ip).toBe('unknown');
  });

  it('canonicalises an IPv4-mapped loopback CF-Connecting-IP', async () => {
    const app = buildApp();
    // extractClientIp canonicalises `::ffff:127.0.0.1` → `127.0.0.1`,
    // matching the form the LoginGuard writes into login_attempts.ip.
    const res = await app.request('/probe', {
      headers: { 'cf-connecting-ip': '::ffff:127.0.0.1' },
    });
    const body = (await res.json()) as { ip: string };
    expect(body.ip).toBe('127.0.0.1');
  });
});
