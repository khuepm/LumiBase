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

/** CSP directives as a map; Pages adds `https:` to these for the cross-origin CMS. */
const PAGES_CROSS_ORIGIN_DIRECTIVES = new Set(['img-src', 'media-src']);

/** The hosted Pages Studio may load the Cloudflare Web Analytics beacon (#1045). */
const PAGES_SCRIPT_EXTRA = 'https://static.cloudflareinsights.com';

function cspDirectives(value: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (value ?? '').split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) map.set(name, sources.join(' '));
  }
  return map;
}

describe('Studio Pages _headers', () => {
  it('content-security-policy matches the CMS, plus https: media for a cross-origin CMS and the analytics beacon', async () => {
    const cms = cspDirectives((await cmsStudioHeaders()).get('content-security-policy'));
    const pages = cspDirectives(pagesHeaders().get('content-security-policy'));
    expect([...pages.keys()].sort()).toEqual([...cms.keys()].sort());
    for (const [name, sources] of cms) {
      const expected = PAGES_CROSS_ORIGIN_DIRECTIVES.has(name)
        ? `${sources} https:`
        : name === 'script-src'
          ? `${sources} ${PAGES_SCRIPT_EXTRA}`
          : sources;
      expect(pages.get(name), name).toBe(expected);
    }
  });

  it.each([
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
