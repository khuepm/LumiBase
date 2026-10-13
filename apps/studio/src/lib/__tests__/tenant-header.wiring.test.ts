/**
 * Tripwire: every Studio request must name the tenant with `X-Lumi-Site`.
 *
 * `withTenant` (apps/cms/src/middleware/tenant.ts) reads exactly one header,
 * `x-lumi-site`. Before this test, eleven hand-rolled fetch helpers sent
 * `x-site-id` instead. The CMS answered 400 `TENANT_REQUIRED`, so on the
 * published Docker image the version panel, presets, Mission Control, AI
 * approvals, Insights, email settings, materialisation, image-transform
 * presets and push subscription were all broken for every user — while the
 * component tests stayed green because they mock `fetch`.
 *
 * The scan is case-insensitive and covers any `x-…site…` header name, so a
 * new helper cannot reintroduce a different misspelling either.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../..');
const HEADER_LITERAL = /['"`](x-[a-z0-9-]*site[a-z0-9-]*)['"`]/gi;
const ALLOWED = 'x-lumi-site';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

export function findWrongTenantHeaders(files: Array<{ path: string; source: string }>): string[] {
  const offenders: string[] = [];
  for (const { path, source } of files) {
    for (const match of source.matchAll(HEADER_LITERAL)) {
      if (match[1]!.toLowerCase() !== ALLOWED) offenders.push(`${path}: ${match[1]}`);
    }
  }
  return offenders;
}

describe('Studio tenant header', () => {
  it('only ever sends X-Lumi-Site', () => {
    const files = sourceFiles(SRC).map((path) => ({
      path: relative(SRC, path),
      source: readFileSync(path, 'utf8'),
    }));
    expect(files.length).toBeGreaterThan(50);
    expect(findWrongTenantHeaders(files)).toEqual([]);
  });

  it('reads site and token through the shared accessors, never raw storage keys', () => {
    // `lumibase_site_id` / `lumibase_dev_token` are never written by the
    // Studio, so reading them sent an empty site + token: presence tickets
    // failed with 400 on every item page. Use getActiveSite()/getActiveToken().
    const RAW_KEY = /localStorage\.getItem\(\s*['"`](lumibase_site_id|lumibase_dev_token)['"`]/g;
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      for (const match of readFileSync(path, 'utf8').matchAll(RAW_KEY)) {
        offenders.push(`${relative(SRC, path)}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('flags the misspellings it exists to catch', () => {
    const offenders = findWrongTenantHeaders([
      { path: 'a.ts', source: `headers: { 'x-site-id': site }` },
      { path: 'b.ts', source: `headers: { "X-Site": site }` },
      { path: 'c.ts', source: `headers: { 'X-Lumi-Site': site, 'x-lumi-site': site }` },
    ]);
    expect(offenders).toEqual(['a.ts: x-site-id', 'b.ts: X-Site']);
  });
});
