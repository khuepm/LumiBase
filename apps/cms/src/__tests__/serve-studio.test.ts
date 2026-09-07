/**
 * Behavioural tests for serving the Studio SPA from the CMS (Docker/Node mode).
 *
 * The failure this guards against is not "the SPA does not load" — that is
 * obvious the first time anyone opens a browser. It is the quiet one: an SPA
 * catch-all that also answers `/api/v1/nonexistent` with `index.html` and a
 * 200, breaking the `{ errors }` contract for every client-side error path
 * while every page still looks fine.
 *
 * A real Hono app with `/api/v1` mounted the way `index.ts` mounts it is used
 * rather than a bare middleware, because the hazard only appears in
 * composition: `app.route('/api/v1', api)` matches through the sub-app's
 * `use('*')` middleware without finalizing a response, so control returns to
 * the catch-all.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createStudioMiddleware,
  isBuildAssetPath,
  isReservedApiPath,
  mountStudio,
  resolveStudioRoot,
  RESERVED_API_PREFIXES,
} from '../serve-studio';

const SHELL_HTML = '<!doctype html><title>LumiBase Studio</title><div id="root"></div>';
const CHUNK_JS = 'export const chunk = 1;\n';

let studioRoot: string;
let emptyRoot: string;

beforeAll(() => {
  studioRoot = mkdtempSync(join(tmpdir(), 'studio-dist-'));
  writeFileSync(join(studioRoot, 'index.html'), SHELL_HTML);
  mkdirSync(join(studioRoot, 'assets'));
  writeFileSync(join(studioRoot, 'assets', 'index-abc123.js'), CHUNK_JS);
  writeFileSync(join(studioRoot, 'sw.js'), '// service worker\n');

  emptyRoot = mkdtempSync(join(tmpdir(), 'studio-empty-'));
});

afterAll(() => {
  rmSync(studioRoot, { recursive: true, force: true });
  rmSync(emptyRoot, { recursive: true, force: true });
});

/** An app shaped like `index.ts`: API sub-app first, Studio catch-all after. */
function buildApp(root: string) {
  const app = new Hono();

  const api = new Hono();
  // The middleware that makes this hazardous: it matches every `/api/v1/*`
  // request without answering it.
  api.use('*', async (_c, next) => {
    await next();
  });
  api.get('/items', (c) => c.json({ data: [] }));

  app.route('/api/v1', api);
  app.get('/health', (c) => c.json({ status: 'healthy' }));
  app.notFound((c) => c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404));

  app.use('/*', createStudioMiddleware({ root }));
  return app;
}

describe('isReservedApiPath', () => {
  it.each([
    '/api',
    '/api/v1/items',
    '/api/v1/media/key.png',
    '/api/v1/graphql',
    '/api/v1/realtime',
    '/health',
    '/health/ready',
    '/metrics',
    '/scim/v2/Users',
    '/test-auth',
  ])('reserves %s for the API', (path) => {
    expect(isReservedApiPath(path)).toBe(true);
  });

  it.each([
    '/',
    '/collections',
    '/apiary',
    '/healthcheck-guide',
    '/metrics-dashboard',
    '/my-secret-admin/login',
    '/assets/index-abc123.js',
  ])('leaves %s to the Studio', (path) => {
    expect(isReservedApiPath(path)).toBe(false);
  });

  it('matches only on a segment boundary', () => {
    // Guards the cheap `startsWith` mistake: `/apifoo` is not the API.
    for (const prefix of RESERVED_API_PREFIXES) {
      expect(isReservedApiPath(`${prefix}foo`)).toBe(false);
    }
  });
});

describe('isBuildAssetPath', () => {
  it('recognises the Vite output directory', () => {
    expect(isBuildAssetPath('/assets/index-abc123.js')).toBe(true);
    expect(isBuildAssetPath('/assets')).toBe(true);
    expect(isBuildAssetPath('/assetsomething')).toBe(false);
    expect(isBuildAssetPath('/sw.js')).toBe(false);
  });
});

describe('serving the Studio', () => {
  it('serves the shell at the root', async () => {
    const res = await buildApp(studioRoot).request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('LumiBase Studio');
  });

  it('serves the shell for an unknown client-side route', async () => {
    // The admin path is server-side state and never in the bundle, so the
    // server cannot enumerate valid Studio routes — the catch-all is required.
    const res = await buildApp(studioRoot).request('/my-secret-admin/login');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('LumiBase Studio');
  });

  it('never lets the shell outlive the hashed assets it names', async () => {
    const res = await buildApp(studioRoot).request('/');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves a real build asset with a long immutable cache', async () => {
    const res = await buildApp(studioRoot).request('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CHUNK_JS);
    // Safe here precisely because Vite makes the filename a function of the
    // content — the property the media-cache incident (#388) lacked.
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('serves a non-hashed public file', async () => {
    const res = await buildApp(studioRoot).request('/sw.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('service worker');
  });
});

describe('not shadowing the API', () => {
  it('leaves a matched API route alone', async () => {
    const res = await buildApp(studioRoot).request('/api/v1/items');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it.each(['/api/v1/nonexistent', '/api/v2/anything', '/health/ready', '/metrics', '/scim/v2/Users'])(
    'answers %s with the JSON error envelope, not the shell',
    async (path) => {
      const res = await buildApp(studioRoot).request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({ errors: [{ code: 'NOT_FOUND' }] });
    },
  );

  it('does not answer a write to an unknown path with the shell', async () => {
    const res = await buildApp(studioRoot).request('/collections', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('404s a missing build asset instead of returning HTML as JavaScript', async () => {
    // Deliberate divergence from Cloudflare Pages, which answers 200 + HTML
    // here. HTML delivered where a module was expected surfaces as a syntax
    // error far from its cause.
    const res = await buildApp(studioRoot).request('/assets/deleted-chunk.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it.each(['/../package.json', '/..%2Fpackage.json', '/%2e%2e/package.json', '/assets/../../package.json'])(
    'never leaks a file outside the studio root via %s',
    async (path) => {
      // Status is not the property that matters: `/../package.json` is
      // normalised to `/package.json` by URL parsing before Hono sees it, and
      // answering that with the SPA shell is correct. What must never happen is
      // the file's *contents* coming back.
      const res = await buildApp(studioRoot).request(path);
      const body = await res.text();
      expect(body).not.toContain('@lumibase/cms');
      expect(body).not.toContain('"dependencies"');
    },
  );
});

describe('resolveStudioRoot', () => {
  it('reports ready when index.html is present', () => {
    const result = resolveStudioRoot({ LUMIBASE_STUDIO_DIST: studioRoot });
    expect(result).toMatchObject({ status: 'ready', configured: true, root: studioRoot });
  });

  it('treats a directory without index.html as missing', () => {
    // A half-copied bundle is not a servable SPA; failing at mount beats
    // failing on the first request.
    expect(resolveStudioRoot({ LUMIBASE_STUDIO_DIST: emptyRoot }).status).toBe('missing');
  });

  it('defaults to ./studio relative to the working directory', () => {
    const result = resolveStudioRoot({}, '/srv/app');
    expect(result.root).toBe('/srv/app/studio');
    expect(result.configured).toBe(false);
  });

  it('ignores a blank override rather than resolving the cwd itself', () => {
    const result = resolveStudioRoot({ LUMIBASE_STUDIO_DIST: '   ' }, '/srv/app');
    expect(result.root).toBe('/srv/app/studio');
    expect(result.configured).toBe(false);
  });
});

describe('mountStudio', () => {
  it('mounts when the bundle is present', () => {
    const app = new Hono();
    const result = mountStudio(app, { LUMIBASE_STUDIO_DIST: studioRoot });
    expect(result).toMatchObject({ mounted: true, root: studioRoot });
  });

  it('runs API-only when the bundle is absent, without throwing', async () => {
    const app = new Hono();
    app.get('/health', (c) => c.json({ status: 'healthy' }));
    app.notFound((c) => c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404));

    const result = mountStudio(app, {}, '/nonexistent-cwd');
    expect(result).toMatchObject({ mounted: false, reason: 'not-configured' });

    // The pre-existing behaviour must survive: API up, no HTML anywhere.
    expect((await app.request('/health')).status).toBe(200);
    const root = await app.request('/');
    expect(root.status).toBe(404);
    expect(root.headers.get('content-type')).toContain('application/json');
  });

  it('distinguishes a typo\'d override from an absent bundle', () => {
    // Silent degradation is how the missing-Studio gap survived this long.
    const result = mountStudio(new Hono(), { LUMIBASE_STUDIO_DIST: '/definitely/not/here' });
    expect(result).toMatchObject({ mounted: false, reason: 'configured-but-missing' });
  });

  it.each(['false', '0', 'no', 'FALSE'])(
    'honours LUMIBASE_SERVE_STUDIO=%s even when the bundle is present',
    (value) => {
      // An operator serving the Studio from Pages in front of this CMS would
      // otherwise have two copies that can drift to different versions.
      const result = mountStudio(new Hono(), {
        LUMIBASE_STUDIO_DIST: studioRoot,
        LUMIBASE_SERVE_STUDIO: value,
      });
      expect(result).toMatchObject({ mounted: false, reason: 'disabled' });
    },
  );

  it('serves the Studio when LUMIBASE_SERVE_STUDIO is unset or truthy', () => {
    for (const env of [{}, { LUMIBASE_SERVE_STUDIO: 'true' }, { LUMIBASE_SERVE_STUDIO: '' }]) {
      const result = mountStudio(new Hono(), { LUMIBASE_STUDIO_DIST: studioRoot, ...env });
      expect(result.mounted, JSON.stringify(env)).toBe(true);
    }
  });
});
