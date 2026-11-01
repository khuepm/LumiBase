import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Shared-domain environments (dev / staging / demo) serve Studio from Pages and
 * the CMS from this Worker on ONE hostname. Only the paths a Worker route
 * matches reach the Worker; every other path is answered by Pages with Studio's
 * `index.html` and a 200.
 *
 * A Cloudflare route pattern without a trailing `*` matches one path exactly.
 * Staging routed `/health` but not `/health/*`, so `/health/ready` (the
 * endpoint that reports dependency readiness with a 503) returned 200 HTML from
 * Pages (#461, measured 2026-11-01). Nothing failed, which is the problem: the
 * deploy check and any uptime monitor read "200" as "ready".
 *
 * This test derives the health sub-routes from `routes/health.ts`, so adding a
 * new `/health/<x>` handler without routing it fails here instead of silently
 * falling through to Pages.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

interface Route {
  pattern: string;
  customDomain: boolean;
}

/** `[[env.<name>.routes]]` blocks → routes per env. Small parser: the file is ours. */
function parseEnvRoutes(toml: string): Map<string, Route[]> {
  const routes = new Map<string, Route[]>();
  const blocks = toml.matchAll(/^\[\[env\.(\w+)\.routes\]\]$([\s\S]*?)(?=^\[|(?![\s\S]))/gm);
  for (const [, env = '', body = ''] of blocks) {
    const pattern = /^pattern\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    if (!pattern) continue;
    const list = routes.get(env) ?? [];
    list.push({ pattern, customDomain: /^custom_domain\s*=\s*true/m.test(body) });
    routes.set(env, list);
  }
  return routes;
}

/** Cloudflare route matching: trailing `*` is a prefix match, otherwise exact. */
function routeMatches(pattern: string, host: string, path: string): boolean {
  const url = `${host}${path}`;
  if (pattern.endsWith('*')) return url.startsWith(pattern.slice(0, -1));
  return url === pattern;
}

/** Paths under `/health` that the health router serves, e.g. `/health`, `/health/ready`. */
function healthPaths(): string[] {
  const source = read('../routes/health.ts');
  const subPaths = [...source.matchAll(/healthRouter\.get\(\s*'([^']*)'/g)].map((m) => m[1] ?? '');
  return subPaths.map((sub) => (sub === '/' || sub === '' ? '/health' : `/health${sub}`));
}

describe('shared-domain Worker routes', () => {
  const routes = parseEnvRoutes(read('../../wrangler.toml'));
  // A shared-domain env routes paths on its own host (no custom_domain).
  const shared = [...routes.entries()]
    .map(([env, list]) => {
      const scoped = list.filter((r) => !r.customDomain && !r.pattern.startsWith('*'));
      const host = scoped[0]?.pattern.split('/')[0];
      return { env, host, list: scoped };
    })
    .filter((e) => e.host && e.list.some((r) => r.pattern === `${e.host}/health`));

  it('finds the shared-domain envs (guards against a parser that matches nothing)', () => {
    expect(shared.map((e) => e.env).sort()).toEqual(['demo', 'dev', 'staging']);
  });

  it('derives the health sub-routes from routes/health.ts', () => {
    expect(healthPaths()).toEqual(expect.arrayContaining(['/health', '/health/ready']));
  });

  const probes = () => [
    ...healthPaths(),
    '/metrics',
    '/api/v1/system/version',
    '/api/v1/realtime',
    '/scim/v2/Users',
  ];

  it.each(['dev', 'staging', 'demo'])('%s routes every CMS path outside the SPA to the Worker', (env) => {
    const entry = shared.find((e) => e.env === env);
    expect(entry, `env ${env}`).toBeDefined();
    const unrouted = probes().filter(
      (path) => !entry!.list.some((r) => routeMatches(r.pattern, entry!.host!, path)),
    );
    expect(unrouted, `${entry!.host} paths that would fall through to Pages`).toEqual([]);
  });

  it('matches Cloudflare semantics: no trailing * means exact', () => {
    expect(routeMatches('staging.lumibase.dev/health', 'staging.lumibase.dev', '/health')).toBe(true);
    expect(routeMatches('staging.lumibase.dev/health', 'staging.lumibase.dev', '/health/ready')).toBe(false);
    expect(routeMatches('staging.lumibase.dev/health/*', 'staging.lumibase.dev', '/health/ready')).toBe(true);
  });
});
