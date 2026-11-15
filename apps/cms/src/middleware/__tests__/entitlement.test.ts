import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  ENTITLEMENT_DIMENSIONS,
  limitFor,
  type AuthorizeDecision,
  type AuthorizeRequest,
  type EntitlementResolver,
} from '@lumibase/contracts/platform';
import { MemoryCacheProvider, type RuntimeContext } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { deliverPathSiteId } from '../../modules/activation/delivery-mark';
import { entitlementsFor, tenantRefFor } from '../../platform/request';
import { registerPlatformSeams, resetPlatformSeamsForTests } from '../../platform/registry';
import type { CmsSeamContext } from '../../platform/types';
import { siteOwnerDb } from '../../test-utils/site-owner-db';
import { apiSurface, withEntitlement } from '../entitlement';

/**
 * `withEntitlement` and the request-scoped helpers behind it.
 *
 * What these tests pin down:
 *  1. nothing registered → the mount is invisible: same response, no lookup;
 *  2. a registered resolver is consulted and its answer is available to the
 *     handler for the rest of the request;
 *  3. a resolver that throws never fails the request, and the failure is logged;
 *  4. a refusal has one shape on every surface.
 */

const OWNERS = { site_a: 'org_1', site_b: 'org_2' };
const ENV = {} as AppEnv['Bindings'];

interface Harness {
  app: Hono<AppEnv>;
  lookups: string[];
  cacheReads: () => number;
  runtime: RuntimeContext;
  handlerRuns: () => number;
}

function buildApp(options: { mounted?: boolean; auth?: AppEnv['Variables']['auth'] } = {}): Harness {
  const { db, lookups } = siteOwnerDb(OWNERS);
  const cache = new MemoryCacheProvider();
  const getEntry = vi.spyOn(cache, 'getEntry');
  const runtime = { cache } as unknown as RuntimeContext;
  let runs = 0;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_test');
    c.set('runtime', runtime);
    c.set('db', db);
    const siteId = c.req.header('x-lumi-site');
    if (siteId) c.set('siteId', siteId);
    if (options.auth) c.set('auth', options.auth);
    await next();
  });
  if (options.mounted !== false) {
    app.use('/api/v1/deliver/*', withEntitlement({
      dimension: ENTITLEMENT_DIMENSIONS.deliveryRequests, surface: 'delivery', siteId: deliverPathSiteId,
    }));
    app.use('/api/v1/*', async (c, next) => {
      if (c.req.path.startsWith('/api/v1/deliver/')) return next();
      return withEntitlement({ dimension: ENTITLEMENT_DIMENSIONS.apiRequests, surface: apiSurface })(c, next);
    });
  }
  app.all('/api/v1/*', async (c) => {
    runs += 1;
    // Two reads in one request: the second must not reach the resolver again.
    const first = await entitlementsFor(c);
    const second = await entitlementsFor(c);
    return c.json({
      data: {
        organizationId: first.organizationId,
        sites: limitFor(first, 'sites'),
        seats: limitFor(first, 'seats'),
        sameSnapshot: first === second,
        memoisedTenant: c.get('tenantRef') !== undefined,
      },
    });
  });
  return { app, lookups, cacheReads: () => getEntry.mock.calls.length, runtime, handlerRuns: () => runs };
}

function get(app: Hono<AppEnv>, path: string, siteId?: string) {
  return app.request(path, { headers: siteId ? { 'x-lumi-site': siteId } : {} }, ENV);
}

interface Recorded {
  authorize: { ctx: CmsSeamContext; req: AuthorizeRequest }[];
  resolve: { ctx: CmsSeamContext; organizationId: string | null }[];
}

function stubResolver(overrides: {
  decide?: (req: AuthorizeRequest) => AuthorizeDecision | Promise<AuthorizeDecision>;
  limits?: Record<string, number | 'unlimited'>;
  resolveThrows?: boolean;
} = {}): { resolver: EntitlementResolver<RuntimeContext>; calls: Recorded } {
  const calls: Recorded = { authorize: [], resolve: [] };
  return {
    calls,
    resolver: {
      async resolve(ctx, organizationId) {
        calls.resolve.push({ ctx, organizationId });
        if (overrides.resolveThrows) throw new Error('entitlement store unreachable');
        return { organizationId, limits: overrides.limits ?? { sites: 3 }, resolvedAt: 1 };
      },
      async authorize(ctx, req) {
        calls.authorize.push({ ctx, req });
        return overrides.decide ? overrides.decide(req) : { allowed: true };
      },
    },
  };
}

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  resetPlatformSeamsForTests();
  errorLog.mockRestore();
});

describe('withEntitlement — nothing registered', () => {
  it('answers exactly as an app without the mount', async () => {
    const bare = buildApp({ mounted: false });
    const mounted = buildApp();

    for (const [method, path] of [['GET', '/api/v1/items/posts'], ['POST', '/api/v1/graphql'], ['GET', '/api/v1/deliver/items/site_a/posts']] as const) {
      const expected = await bare.app.request(path, { method, headers: { 'x-lumi-site': 'site_a' } }, ENV);
      const actual = await mounted.app.request(path, { method, headers: { 'x-lumi-site': 'site_a' } }, ENV);
      expect(actual.status).toBe(expected.status);
      expect([...actual.headers.entries()]).toEqual([...expected.headers.entries()]);
      expect(await actual.text()).toBe(await expected.text());
    }
  });

  it('resolves every limit as unlimited', async () => {
    const { app } = buildApp();
    const body = await (await get(app, '/api/v1/items/posts', 'site_a')).json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ sites: 'unlimited', seats: 'unlimited', sameSnapshot: true });
  });

  it('adds no database lookup and no cache read to the request', async () => {
    const { app, lookups, cacheReads } = buildApp();
    await get(app, '/api/v1/items/posts', 'site_a');
    await get(app, '/api/v1/deliver/items/site_b/posts');

    expect(lookups).toEqual([]);
    expect(cacheReads()).toBe(0);
  });

  it('never resolves the tenant unless something asks', async () => {
    const { app } = buildApp();
    const body = await (await get(app, '/api/v1/items/posts', 'site_a')).json() as { data: { memoisedTenant: boolean } };
    expect(body.data.memoisedTenant).toBe(false);
    expect(errorLog).not.toHaveBeenCalled();
  });
});

describe('withEntitlement — a registered resolver', () => {
  it('is consulted once per request with the resolved tenant', async () => {
    const { resolver, calls } = stubResolver();
    registerPlatformSeams({ entitlements: resolver });
    const { app, runtime } = buildApp();

    const res = await get(app, '/api/v1/items/posts', 'site_a');

    expect(res.status).toBe(200);
    expect(calls.authorize).toHaveLength(1);
    expect(calls.authorize[0]!.req).toEqual({
      tenant: { siteId: 'site_a', organizationId: 'org_1' },
      dimension: 'api.requests',
      surface: 'rest',
    });
    expect(calls.authorize[0]!.ctx.requestId).toBe('req_test');
    expect(calls.authorize[0]!.ctx.runtime).toBe(runtime);
  });

  it('makes its snapshot available to the handler, resolved once per request', async () => {
    const { resolver, calls } = stubResolver({ limits: { sites: 3 } });
    registerPlatformSeams({ entitlements: resolver });
    const { app, lookups } = buildApp();

    const body = await (await get(app, '/api/v1/items/posts', 'site_a')).json() as { data: Record<string, unknown> };

    expect(body.data).toEqual({
      organizationId: 'org_1', sites: 3, seats: 'unlimited', sameSnapshot: true, memoisedTenant: true,
    });
    // The handler read the snapshot twice; the resolver was asked once.
    expect(calls.resolve).toHaveLength(1);
    expect(calls.resolve[0]!.organizationId).toBe('org_1');
    // authorize and resolve shared one site → organization lookup.
    expect(lookups).toEqual(['site_a']);
  });

  it('does not carry a snapshot or a tenant from one request into the next', async () => {
    const { resolver, calls } = stubResolver();
    registerPlatformSeams({ entitlements: resolver });
    const { app, lookups } = buildApp();

    const a = await (await get(app, '/api/v1/items/posts', 'site_a')).json() as { data: { organizationId: string } };
    const b = await (await get(app, '/api/v1/items/posts', 'site_b')).json() as { data: { organizationId: string } };
    const again = await (await get(app, '/api/v1/items/posts', 'site_a')).json() as { data: { organizationId: string } };

    expect([a.data.organizationId, b.data.organizationId, again.data.organizationId]).toEqual(['org_1', 'org_2', 'org_1']);
    expect(calls.authorize.map((call) => call.req.tenant)).toEqual([
      { siteId: 'site_a', organizationId: 'org_1' },
      { siteId: 'site_b', organizationId: 'org_2' },
      { siteId: 'site_a', organizationId: 'org_1' },
    ]);
    expect(calls.resolve).toHaveLength(3);
    // The third request found site_a in the cache.
    expect(lookups).toEqual(['site_a', 'site_b']);
  });

  it('names the surface the request arrived on', async () => {
    const { resolver, calls } = stubResolver();
    registerPlatformSeams({ entitlements: resolver });
    const { app } = buildApp();

    await app.request('/api/v1/graphql', { method: 'POST', headers: { 'x-lumi-site': 'site_a' } }, ENV);
    await app.request('/api/v1/mcp', { method: 'POST', headers: { 'x-lumi-site': 'site_a' } }, ENV);
    await get(app, '/api/v1/collections', 'site_a');
    await get(app, '/api/v1/deliver/items/site_b/posts');

    expect(calls.authorize.map((call) => [call.req.surface, call.req.dimension])).toEqual([
      ['graphql', 'api.requests'],
      ['mcp', 'api.requests'],
      ['rest', 'api.requests'],
      ['delivery', 'delivery.requests'],
    ]);
  });

  it('takes the site from the URL on the delivery surface', async () => {
    const { resolver, calls } = stubResolver();
    registerPlatformSeams({ entitlements: resolver });
    const { app } = buildApp();

    await get(app, '/api/v1/deliver/items/site_b/posts');

    expect(calls.authorize[0]!.req.tenant).toEqual({ siteId: 'site_b', organizationId: 'org_2' });
  });

  it('reports an unknown site with a null organization rather than failing', async () => {
    const { resolver, calls } = stubResolver();
    registerPlatformSeams({ entitlements: resolver });
    const { app } = buildApp();

    const res = await get(app, '/api/v1/deliver/items/ghost/posts');

    expect(res.status).toBe(200);
    expect(calls.authorize[0]!.req.tenant).toEqual({ siteId: 'ghost', organizationId: null });
  });

  it('uses an organization key\'s own organization on routes that carry no site', async () => {
    const { resolver, calls } = stubResolver();
    registerPlatformSeams({ entitlements: resolver });
    const { app, lookups } = buildApp({
      auth: { apiKeyId: 'key_1', apiKey: { scope: 'organization', organizationId: 'org_7' } } as never,
    });

    await get(app, '/api/v1/orgs/org_other/sites');

    // From the verified principal — not from the `:orgId` in the path.
    expect(calls.authorize[0]!.req.tenant).toEqual({ siteId: null, organizationId: 'org_7' });
    expect(lookups).toEqual([]);
  });
});

describe('withEntitlement — a resolver that fails', () => {
  it('lets the request through when authorize throws, and logs it', async () => {
    const { resolver } = stubResolver({ decide: () => { throw new Error('entitlement store unreachable'); } });
    registerPlatformSeams({ entitlements: resolver });
    const { app, handlerRuns } = buildApp();

    const res = await get(app, '/api/v1/items/posts', 'site_a');

    expect(res.status).toBe(200);
    expect(handlerRuns()).toBe(1);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('platform seam failed'),
      expect.objectContaining({ seam: 'entitlements', operation: 'authorize', requestId: 'req_test' }),
    );
    const logged = errorLog.mock.calls[0]![1] as { err: unknown };
    expect(JSON.stringify(logged.err)).toContain('entitlement store unreachable');
  });

  it('lets the request through when authorize rejects', async () => {
    const { resolver } = stubResolver({ decide: () => Promise.reject(new Error('timeout')) });
    registerPlatformSeams({ entitlements: resolver });
    const { app } = buildApp();

    expect((await get(app, '/api/v1/deliver/items/site_a/posts')).status).toBe(200);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('falls back to the unlimited snapshot when resolve throws, and logs it', async () => {
    const { resolver } = stubResolver({ resolveThrows: true });
    registerPlatformSeams({ entitlements: resolver });
    const { app } = buildApp();

    const res = await get(app, '/api/v1/items/posts', 'site_a');
    const body = await res.json() as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ organizationId: 'org_1', sites: 'unlimited', seats: 'unlimited' });
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('platform seam failed'),
      expect.objectContaining({ seam: 'entitlements', operation: 'resolve' }),
    );
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an object without `allowed`', { code: 'LIMIT_EXCEEDED' }],
    ['a non-boolean `allowed`', { allowed: 'no' }],
  ])('treats %s as a failure, not as a refusal', async (_label, answer) => {
    const { resolver } = stubResolver({ decide: () => answer as never });
    registerPlatformSeams({ entitlements: resolver });
    const { app } = buildApp();

    expect((await get(app, '/api/v1/items/posts', 'site_a')).status).toBe(200);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});

describe('withEntitlement — a resolver that refuses', () => {
  const denial = { allowed: false, code: 'LIMIT_EXCEEDED', dimension: 'api.requests', limit: 1000, retryable: true } as const;

  it('answers 429 with the LIMIT_EXCEEDED body and does not run the handler', async () => {
    const { resolver } = stubResolver({ decide: () => denial });
    registerPlatformSeams({ entitlements: resolver });
    const { app, handlerRuns } = buildApp();

    const res = await get(app, '/api/v1/items/posts', 'site_a');

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      errors: [{ code: 'LIMIT_EXCEEDED', dimension: 'api.requests', limit: 1000, retryable: true }],
    });
    expect(handlerRuns()).toBe(0);
  });

  it('passes an optional help link through and adds nothing of its own', async () => {
    const { resolver } = stubResolver({
      decide: () => ({ ...denial, retryable: false, helpUrl: 'https://example.test/limits', extra: 'dropped' } as never),
    });
    registerPlatformSeams({ entitlements: resolver });
    const { app } = buildApp();

    expect(await (await get(app, '/api/v1/items/posts', 'site_a')).json()).toEqual({
      errors: [{
        code: 'LIMIT_EXCEEDED', dimension: 'api.requests', limit: 1000, retryable: false,
        helpUrl: 'https://example.test/limits',
      }],
    });
  });

  it('refuses identically on REST, GraphQL and MCP', async () => {
    const { resolver } = stubResolver({ decide: () => denial });
    registerPlatformSeams({ entitlements: resolver });
    const { app } = buildApp();

    const responses = await Promise.all([
      get(app, '/api/v1/items/posts', 'site_a'),
      app.request('/api/v1/graphql', { method: 'POST', headers: { 'x-lumi-site': 'site_a' } }, ENV),
      app.request('/api/v1/mcp', { method: 'POST', headers: { 'x-lumi-site': 'site_a' } }, ENV),
    ]);
    const bodies = await Promise.all(responses.map((res) => res.text()));

    expect(responses.map((res) => res.status)).toEqual([429, 429, 429]);
    expect(new Set(bodies).size).toBe(1);
  });

  it('can refuse one tenant while serving another', async () => {
    const { resolver } = stubResolver({
      decide: (req) => (req.tenant.organizationId === 'org_2' ? denial : { allowed: true }),
    });
    registerPlatformSeams({ entitlements: resolver });
    const { app } = buildApp();

    expect((await get(app, '/api/v1/items/posts', 'site_a')).status).toBe(200);
    expect((await get(app, '/api/v1/items/posts', 'site_b')).status).toBe(429);
    expect((await get(app, '/api/v1/items/posts', 'site_a')).status).toBe(200);
  });
});

describe('tenantRefFor', () => {
  it('resolves lazily and memoises on the context', async () => {
    const { db, lookups } = siteOwnerDb(OWNERS);
    const app = new Hono<AppEnv>();
    app.get('/', async (c) => {
      c.set('db', db);
      c.set('runtime', { cache: new MemoryCacheProvider() } as unknown as RuntimeContext);
      c.set('siteId', 'site_a');
      const before = lookups.length;
      const [first, second] = await Promise.all([tenantRefFor(c), tenantRefFor(c)]);
      return c.json({ before, first, same: first === second });
    });

    expect(await (await app.request('/', {}, ENV)).json()).toEqual({
      before: 0, first: { siteId: 'site_a', organizationId: 'org_1' }, same: true,
    });
    // Two concurrent callers, one lookup.
    expect(lookups).toEqual(['site_a']);
  });

  it('answers with a null organization when no database handle is on the context', async () => {
    const app = new Hono<AppEnv>();
    app.get('/', async (c) => {
      c.set('siteId', 'site_a');
      return c.json(await tenantRefFor(c));
    });

    expect(await (await app.request('/', {}, ENV)).json()).toEqual({ siteId: 'site_a', organizationId: null });
  });
});
