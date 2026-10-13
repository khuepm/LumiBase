/**
 * Serve the Studio SPA from the CMS process — Docker/Node only.
 *
 * Why this exists. Until now no shipped artifact contained the Studio:
 * `grep -c studio` was 0 in both compose files, `docker/Dockerfile` copied only
 * `apps/cms/dist`, and the CMS served no HTML at all — a self-hoster following
 * the docs reached `GET /setup` and got `404 NOT_FOUND` in JSON. Meanwhile
 * `docs/en/deployment/overview.md` claimed "Docker serves the Studio from the
 * same origin as the CMS". This module makes that sentence true instead of
 * deleting it, which is what #332 needs before a new user can be promised a
 * reachable CMS *and* Studio.
 *
 * On Cloudflare the Studio stays a separate Pages deployment — Workers has no
 * filesystem. Only `serve.ts` imports this file, the same containment the
 * node-cron import relies on, so `@hono/node-server` cannot leak into the
 * Workers bundle.
 *
 * ## The dangerous part: not turning API 404s into HTML
 *
 * An SPA needs a catch-all: the Studio's admin path is server-side state that
 * is deliberately never baked into the bundle, so the server cannot know which
 * paths are "real" Studio routes. But a naive catch-all also swallows
 * `/api/v1/nonexistent` and answers it with `index.html` and a 200, which turns
 * every client-side error path into a parse error and silently breaks the
 * `{ errors }` contract.
 *
 * Mounting order alone does not save us. Hono runs every matching handler in
 * registration order, and `app.route('/api/v1', api)` matches through the
 * sub-app's `use('*')` middlewares without finalizing a response when no route
 * inside matches — so control comes back out to this middleware. Hence the
 * explicit prefix list below, which is the real guard.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context, Env, Hono, MiddlewareHandler, Next } from 'hono';

/**
 * Top-level prefixes owned by the API. Anything under these must reach the
 * CMS's own `notFound` handler and answer in the `{ errors }` envelope.
 *
 * Derived from every top-level registration in `index.ts`: `/api/v1*` (which
 * covers `/api/v1/media`, `/api/v1/graphql` and the `/api/v1/realtime`
 * WebSocket path), `/health` (plus `/health/ready`), `/metrics`, `/scim/v2` and
 * `/test-auth`. `/api` and `/scim` are listed rather than their versioned forms
 * so a future `/api/v2` is covered on the day it is added instead of the day
 * someone notices.
 */
export const RESERVED_API_PREFIXES = [
  '/api',
  '/health',
  '/metrics',
  '/scim',
  '/test-auth',
] as const;

/**
 * Prefix match on a path segment boundary, so a Studio route may legitimately
 * be called `/apiary` or `/healthcheck-guide` without being mistaken for the
 * API.
 */
export function isReservedApiPath(pathname: string): boolean {
  return RESERVED_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Vite emits content-hashed filenames under `/assets/`, so a miss there is
 * always a bug — a stale shell asking for a chunk that no longer exists, or a
 * bad deploy. Answering those with `index.html` (which is what Cloudflare Pages
 * does) hands the browser HTML where it expected JavaScript and produces a
 * syntax error several steps away from the cause. This is a deliberate,
 * documented divergence from the Pages behaviour.
 */
export function isBuildAssetPath(pathname: string): boolean {
  return pathname === '/assets' || pathname.startsWith('/assets/');
}

export type StudioRoot =
  | { status: 'ready'; root: string; configured: boolean }
  | { status: 'missing'; root: string; configured: boolean }
  | { status: 'disabled'; root: string; configured: boolean };

/**
 * Explicit opt-out. The image ships the bundle, but an operator who serves the
 * Studio from Cloudflare Pages while running this CMS behind it has two copies
 * that can drift to different versions — and the one people reach is then a
 * matter of which hostname they typed. Turning it off is a real requirement,
 * not a hypothetical.
 */
function isDisabled(env: Record<string, string | undefined>): boolean {
  const raw = env.LUMIBASE_SERVE_STUDIO?.trim().toLowerCase();
  return raw === 'false' || raw === '0' || raw === 'no';
}

/**
 * Where the built Studio lives. `LUMIBASE_STUDIO_DIST` overrides; the default
 * matches what the Dockerfile copies in.
 *
 * "Configured but missing" is reported separately from "not configured" so the
 * caller can shout about a typo'd path instead of silently running API-only —
 * a silent degrade is exactly how the current gap went unnoticed.
 */
export function resolveStudioRoot(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): StudioRoot {
  const configuredPath = env.LUMIBASE_STUDIO_DIST?.trim();
  const configured = Boolean(configuredPath);
  const root = configuredPath ? resolve(cwd, configuredPath) : resolve(cwd, 'studio');

  if (isDisabled(env)) return { status: 'disabled', root, configured };

  // `index.html` rather than the directory: an empty or half-copied directory
  // is not a servable SPA, and finding out at mount time beats finding out on
  // the first request.
  const status = existsSync(join(root, 'index.html')) ? 'ready' : 'missing';
  return { status, root, configured };
}

/** One year, for filenames that are a function of their content. */
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Rebuild the response with one header replaced.
 *
 * Mutating `response.headers` in place does not survive: `serveStatic` builds
 * its response through `c.body()`, and Hono reconciles `c.res` on assignment,
 * so a late `.set()` is silently dropped — measured, not assumed. Setting the
 * header on the context *before* calling the handler would work but would also
 * leak a year-long `immutable` onto the 404 when the file turns out to be
 * missing, which is a far worse failure than a dropped header.
 */
function withHeader(response: Response, name: string, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Cache policy decided by what was actually served, not by which branch served
 * it.
 *
 * Branch-based logic gets this wrong, and did: `serveStatic` resolves `/` to the
 * root *directory*, appends `index.html` itself and returns it as a plain file
 * hit — so the shell never reached the "shell" branch and went out with no
 * `Cache-Control` at all. Keyed on the response instead, the directory-index
 * path and the explicit fallback path cannot disagree.
 */
function applyCachePolicy(response: Response, pathname: string): Response {
  if (isBuildAssetPath(pathname)) {
    return withHeader(response, 'Cache-Control', ASSET_CACHE_CONTROL);
  }
  // The shell names hashed assets, so it must never be the cached copy that
  // outlives them. `no-cache` permits a revalidated 304, it does not forbid
  // storage.
  if (response.headers.get('Content-Type')?.includes('text/html')) {
    return withHeader(response, 'Cache-Control', 'no-cache');
  }
  return response;
}

export interface MountStudioOptions {
  root: string;
}

/**
 * Build the middleware that serves the Studio. Exported separately from
 * `mountStudio` so tests can drive it without a full app.
 */
export function createStudioMiddleware<E extends Env = Env>({
  root,
}: MountStudioOptions): MiddlewareHandler<E> {
  // `serveStatic` resolves `join(root, c.req.path)` and rejects `..`, `//` and
  // backslashes before touching the filesystem, so traversal is handled
  // upstream rather than re-implemented here.
  const fileHandler = serveStatic({ root });
  const shellHandler = serveStatic({ root, path: 'index.html' });

  return async function studioMiddleware(c: Context<E>, next: Next) {
    // Let the API answer for itself, in its own envelope.
    if (isReservedApiPath(c.req.path)) return next();

    // A write to an unknown path is a client error, not a page view. Serving
    // the shell for it would answer `POST /whatever` with 200 and HTML.
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();

    const noop: Next = async () => {};

    const file = await fileHandler(c, noop);
    if (file) return applyCachePolicy(file, c.req.path);

    // Missing build asset: fall through to the JSON 404 rather than pretend.
    if (isBuildAssetPath(c.req.path)) return next();

    const shell = await shellHandler(c, noop);
    if (!shell) return next();
    return applyCachePolicy(shell, c.req.path);
  };
}

export interface MountStudioResult {
  mounted: boolean;
  root: string;
  reason?: 'not-configured' | 'configured-but-missing' | 'disabled';
}

/**
 * Attach the Studio to an existing app. Safe to call when the bundle is absent:
 * the CMS then runs API-only, which is the pre-existing behaviour.
 */
export function mountStudio<E extends Env>(
  app: Hono<E>,
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): MountStudioResult {
  const resolved = resolveStudioRoot(env, cwd);

  if (resolved.status === 'disabled') {
    return { mounted: false, root: resolved.root, reason: 'disabled' };
  }

  if (resolved.status === 'missing') {
    return {
      mounted: false,
      root: resolved.root,
      reason: resolved.configured ? 'configured-but-missing' : 'not-configured',
    };
  }

  app.use('/*', createStudioMiddleware<E>({ root: resolved.root }));
  return { mounted: true, root: resolved.root };
}
