import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Platform extension points — wiring tripwires.
 *
 * Source-level on purpose, like `security-guards.wiring.test.ts`: booting the
 * full app needs live services, and each rule here is one a refactor could
 * break while every behavioural test of the pieces keeps passing.
 */

const srcRoot = resolve(__dirname, '..');
const appRoot = resolve(srcRoot, '..');
const read = (rel: string) => readFileSync(resolve(srcRoot, rel), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('platform seams — the stock build registers nothing', () => {
  it('no file outside tests calls registerPlatformSeams', () => {
    const callers = sourceFiles(srcRoot)
      .filter((file) => !file.includes('__tests__') && !file.includes('test-utils'))
      .filter((file) => relative(srcRoot, file) !== join('platform', 'registry.ts'))
      .filter((file) => /\bregisterPlatformSeams\s*\(/.test(
        // Calls only: strip comments so the usage examples in doc blocks do not count.
        readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
      ))
      .map((file) => relative(srcRoot, file));

    expect(callers, 'core must run on the built-in defaults; registration belongs to a wrapping entry').toEqual([]);
  });

  it('the registry does not read seams at module load', () => {
    // A module-scope `platform()` would seal the registry before a wrapping
    // entry's own module body runs, and its registration would then throw.
    for (const file of sourceFiles(srcRoot).filter((f) => !f.includes('__tests__'))) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      for (const line of code.split('\n')) {
        if (/\bplatform\(\)/.test(line) && /^(const|let|var|export const)\s/.test(line)) {
          throw new Error(`${relative(srcRoot, file)} reads platform() at module scope: ${line.trim()}`);
        }
      }
    }
  });
});

describe('platform seams — entitlement check mounts (index.ts)', () => {
  const source = read('index.ts');

  it('mounts withEntitlement on the authenticated chain, after the guard chain', () => {
    const chain = source.indexOf("api.use('*', withTenant(),");
    const mount = source.indexOf("api.use('*', withEntitlement({ dimension: ENTITLEMENT_DIMENSIONS.apiRequests, surface: apiSurface }));");
    const firstRoute = source.indexOf("api.route('/orgs', orgsRouter);");
    expect(chain).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(chain);
    // Before any route is attached, so every authenticated route sits behind it.
    expect(firstRoute).toBeGreaterThan(mount);
  });

  it('mounts withEntitlement on the delivery surface, after its rate limiter', () => {
    const limiter = source.indexOf("app.use('/api/v1/deliver/*', withDb(), withDeliverRateLimit());");
    const mount = source.indexOf("app.use('/api/v1/deliver/*', withEntitlement({");
    const router = source.indexOf("app.route('/api/v1/deliver', deliverRouter);");
    expect(limiter).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(limiter);
    expect(router).toBeGreaterThan(mount);
    expect(source.slice(mount, router)).toContain('siteId: deliverPathSiteId');
  });
});

describe('platform seams — site → organization cache invalidation', () => {
  it('routes/orgs.ts invalidates after site delete and site transfer', () => {
    const source = read('routes/orgs.ts');
    const handler = (marker: string) => {
      const start = source.indexOf(marker);
      expect(start, marker).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf('\n});', start));
    };
    for (const marker of [
      "orgsRouter.delete('/:orgId/sites/:siteId'",
      "orgsRouter.post('/:orgId/sites/:siteId/transfer'",
    ]) {
      const body = handler(marker);
      const commit = body.indexOf('executeOrganizationMutation(');
      const invalidate = body.indexOf('invalidateSiteOrganization(');
      expect(invalidate, `${marker} must invalidate the cached owner`).toBeGreaterThan(-1);
      // After the transaction: invalidating first lets a concurrent reader put
      // the pre-commit owner straight back.
      expect(invalidate).toBeGreaterThan(commit);
    }
  });

  it('the approval path invalidates for both operations it can execute', () => {
    const source = read('services/organization-harness.ts');
    expect(source).toMatch(/operation === 'transfer_site'[^\n]*transferredSiteId = /);
    expect(source).toMatch(/for \(const siteId of \[deletedSiteId, transferredSiteId\]\)[\s\S]{0,120}invalidateSiteOrganization\(/);
  });

  it('site provisioning clears a negative entry for the new site', () => {
    expect(read('services/site-provisioning.ts')).toContain('invalidateSiteOrganization(runtime.cache, siteId)');
  });

  it('nothing else writes sites.organization_id', () => {
    // If a new writer appears, it must invalidate too — extend the tests above.
    const writers = sourceFiles(srcRoot)
      .filter((file) => !file.includes('__tests__'))
      .filter((file) => /\.(update|delete)\(sites\)/.test(readFileSync(file, 'utf8')))
      .filter((file) => {
        const code = readFileSync(file, 'utf8');
        return /\.delete\(sites\)/.test(code) || /update\(sites\)\s*\.set\(\{[^}]*organizationId/.test(code);
      })
      .map((file) => relative(srcRoot, file));
    expect(writers).toEqual([join('services', 'organization-operations.ts')]);
  });
});

describe('platform seams — package entry points', () => {
  const pkg = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };

  it('exports the app, both runtime entries and the registry', () => {
    expect(Object.keys(pkg.exports)).toEqual(
      expect.arrayContaining(['.', './app', './cloudflare', './node', './platform']),
    );
  });

  it('every exported path exists', () => {
    for (const [name, target] of Object.entries(pkg.exports)) {
      expect(existsSync(resolve(appRoot, target)), `${name} → ${target}`).toBe(true);
    }
  });

  it('the Workers entry still exports the handler and both Durable Objects', () => {
    const entry = read('cloudflare.ts');
    expect(entry).toMatch(/export default Sentry\.withSentry\(/);
    expect(entry).toContain("export { SiteRoom } from './realtime/site-room';");
    expect(entry).toContain("export { PageviewCounter } from './pageviews/counter-do';");
  });

  it('the contracts package exports the seam contracts', () => {
    const contracts = JSON.parse(
      readFileSync(resolve(appRoot, '../../packages/contracts/package.json'), 'utf8'),
    ) as { exports: Record<string, string>; publishConfig: { exports: Record<string, unknown> } };
    expect(contracts.exports['./platform']).toBe('./src/platform/index.ts');
    expect(contracts.publishConfig.exports['./platform']).toBeDefined();
  });
});
