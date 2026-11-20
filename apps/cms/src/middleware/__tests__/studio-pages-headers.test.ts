import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { withSecurityHeaders } from '../security-headers';

/**
 * #995 — the Studio deployed as a static Cloudflare Pages site gets its
 * security headers from `apps/studio/public/_headers`. They must be the ones
 * the CMS sends when it serves the Studio itself, or the two deployments of
 * the same admin UI would have different protection.
 */
const HEADERS_FILE = join(__dirname, '..', '..', '..', '..', 'studio', 'public', '_headers');

function pagesHeaders(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(HEADERS_FILE, 'utf8').split('\n')) {
    const match = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
    if (match) map.set(match[1]!.toLowerCase(), match[2]!.trim());
  }
  return map;
}

async function cmsStudioHeaders(): Promise<Headers> {
  const app = new Hono<AppEnv>();
  app.use('*', withSecurityHeaders());
  app.get('/', (c) => c.html('<!doctype html><title>Studio</title>'));
  return (await app.request('/')).headers;
}

describe('Studio Pages _headers', () => {
  it.each([
    'content-security-policy',
    'x-content-type-options',
    'x-frame-options',
    'referrer-policy',
    'permissions-policy',
    'cross-origin-opener-policy',
  ])('%s matches what the CMS sends for the Studio', async (name) => {
    const cms = await cmsStudioHeaders();
    expect(pagesHeaders().get(name), name).toBe(cms.get(name));
  });

  it('forbids framing and adds HSTS', () => {
    const headers = pagesHeaders();
    expect(headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(headers.get('strict-transport-security')).toMatch(/max-age=\d{7,}/);
  });
});
