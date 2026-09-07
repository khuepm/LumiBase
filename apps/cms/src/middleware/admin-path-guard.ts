/**
 * Admin Path Guard middleware (admin-setup-wizard Req 5.1, 5.2, 5.6, 5.7;
 * design §6.2 + §7.2).
 *
 * Once the instance is `'initialized'`, the Studio is only reachable at
 * the operator-chosen `system_state.admin_path`. Every other path that
 * looks like a Studio entry point — the bait set in
 * `Default_Admin_Paths` (`/admin`, `/studio`, `/login`, …) and any
 * other random path that is *not* under `/api/*` — must answer with a
 * generic 404 that is byte- and timing-indistinguishable from the
 * "actual" Studio's 404 surface, so a probing bot cannot confirm the
 * Studio exists at *any* URL on this host.
 *
 * Decisions taken here, with rationale:
 *
 *   1. **State is read once per request and cached** (process-wide,
 *      with a short TTL). A row read from `system_state` is enough,
 *      and the row only flips once per instance lifetime (uninitialized
 *      → initialized). The cache TTL keeps the hot path off the DB
 *      under load, and a "burst" of cache misses still degrades to one
 *      query per worker rather than per-request. The TTL is intentionally
 *      short (5 s) so an operator who manually rolls the admin path via
 *      a recovery flow doesn't have to restart the process.
 *
 *   2. **Bypass for `state='uninitialized'`**: the wizard at `/setup`
 *      MUST be reachable on a fresh instance. Without this bypass the
 *      first-run user can never get past 404 (Req 5.4).
 *
 *   3. **Bypass for `/api/*` requests**: API routes do their own auth
 *      and tenant resolution (`withAuth`, `withTenant`). Wrapping them
 *      with the Studio-scope guard would 404 every legitimate API call
 *      from the Studio shell, since the Studio frontend lives at the
 *      admin path but its `fetch()` calls go to `/api/v1/*`. The guard
 *      is *only* about HTML/asset entry points.
 *
 *   4. **Constant-time compare via `pathEqualsConstantTime`** (task
 *      4.1, design §7.1). A naive `===` would leak the longest matching
 *      prefix through CPU branch-prediction timing, which is exactly
 *      the attack the custom admin path is meant to defend against
 *      (Req 5.7).
 *
 *   5. **Indistinguishable 404** (Req 5.1, design §7.2): on mismatch
 *      we run a `SELECT 1` no-op against the same connection used for
 *      the legit path so the latency profile matches; we set the
 *      response status to 404 with envelope `{ errors: [{ code:
 *      'NOT_FOUND' }] }`; we constrain headers to `Content-Type` +
 *      `Content-Length` so no `cache-control`, `vary`, `x-powered-by`,
 *      or other discriminator can accidentally betray which leaf served
 *      the response.
 *
 *   6. **Sub-path detection via prefix + boundary check**: a request to
 *      `/lumi-7f3a9c/assets/main.js` is in scope (admin path is
 *      `/lumi-7f3a9c`); a request to `/lumi-7f3a9cx` is *not* (it's a
 *      different path that just happens to share a prefix). We split
 *      on the trailing `/` instead of using `startsWith` to avoid the
 *      latter footgun.
 *
 *   7. **Studio-scope detection**: a path is Studio-scoped when it is
 *      *not* an API/health/setup/scim route AND it either matches a
 *      `Default_Admin_Path` exactly, sits under one (e.g.
 *      `/admin/users`), OR matches/sits under the configured admin
 *      path. We check the configured path branch first so a legitimate
 *      user request never spends time on the bait list.
 *
 * The middleware itself is intentionally lean — heavy lifting (state
 * lookup, DB no-op) is delegated to small helpers so unit tests can
 * isolate the routing decisions from the DB plumbing.
 */

import type { MiddlewareHandler } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema, systemState } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../env';
import { pathEqualsConstantTime } from '../modules/setup/path-compare';

// ── constants ───────────────────────────────────────────────────────────

/**
 * Paths that bot scanners try first, mirrored from Req 4 (Glossary →
 * Default_Admin_Paths). These are the explicit "bait" set: any of them
 * that don't match the configured admin path must look like a hard
 * 404.
 *
 * `/setup` and `/api` are also in the upstream list but we don't put
 * them here — `/setup` is allowed-through while uninitialized (Req
 * 5.4) and `/api/*` always bypasses (Req 5: API auth/check is its own
 * surface). Including them here would either break the wizard or
 * waste a DB no-op on every API request.
 */
const DEFAULT_ADMIN_PATH_BAIT: ReadonlySet<string> = new Set([
  '/admin',
  '/administrator',
  '/studio',
  '/wp-admin',
  '/login',
  '/dashboard',
  '/cms',
]);

/**
 * Path prefixes that are *never* Studio-scope and must always pass
 * through to their own routers. The trailing `/` distinguishes
 * `/api/v1/users` (bypass) from a hypothetical `/apicompat` (which is
 * not on this list anyway, but the principle generalises).
 *
 * `/health`, `/metrics`, `/scim`, `/setup` are bypass too:
 *   - `/health`, `/metrics`: ops surfaces, must remain probeable;
 *   - `/scim/v2`: SCIM provisioning has its own auth;
 *   - `/setup`: wizard surface — but `/api/v1/setup` is the JSON one,
 *     so the bare `/setup` prefix only matters if/when the Studio
 *     `/setup` HTML page is hosted by the CMS too. In the current
 *     layout the wizard lives at `apps/studio` so the bare `/setup`
 *     path never reaches the CMS in a real deployment, but we keep it
 *     bypassed defensively so a future "CMS serves Studio" deployment
 *     doesn't 404 the wizard.
 */
const NEVER_STUDIO_SCOPE_PREFIXES: ReadonlyArray<string> = [
  '/api/',
  '/health',
  '/metrics',
  '/scim/',
  '/setup',
  '/test-auth',
  '/.well-known/',
  // Studio build output, for the Docker deployment where the CMS serves the
  // SPA itself (`serve-studio.ts`). `apps/studio/dist` emits exactly three
  // entries at its root — `assets/`, `index.html`, `sw.js` — and Vite builds
  // with `base: '/'`, so the shell references `/assets/…` absolutely no matter
  // which path served it. Without these two the browser fetches the bundle and
  // gets the canonical 404, i.e. a Studio that renders nothing.
  //
  // What this concedes: someone holding a valid content-hashed filename can
  // confirm a Studio is hosted on this origin. They cannot learn *where* the
  // login is — the admin path is server-side state and the build refuses to
  // embed it (`assertNoAdminPathEnv`) — and `/`, `/admin`, `/studio` still
  // return the canonical 404, so the Hide-Login guarantee of Req 5.1/5.6 is
  // unchanged. Filenames are only discoverable from `index.html`, which is
  // served at `/setup` (already bypassed above) or under the admin path.
  //
  // The alternative, kept on the shelf: build the Studio with `base: './'` and
  // serve it only under the admin path, where `/<adminPath>/assets/…` already
  // passes this guard and nothing here needs to change. That concedes nothing
  // but moves the risk into the Studio build and the Pages deployment.
  '/assets/',
  '/sw.js',
];

// ── module-level state cache ────────────────────────────────────────────

/**
 * Cached read of the `system_state` singleton. The TTL is intentionally
 * short — once the row flips to `'initialized'` it stays initialized
 * for the lifetime of the deployment in normal operation, but during
 * recovery flows the operator may rotate the admin path and we want
 * those changes to land in ≤ TTL seconds without a process restart.
 */
interface CachedState {
  readonly state: 'uninitialized' | 'initializing' | 'initialized';
  readonly adminPath: string | null;
  readonly cachedAt: number;
}

const STATE_CACHE_TTL_MS = 5_000;

let cachedState: CachedState | null = null;
let inflightRead: Promise<CachedState> | null = null;

/**
 * Reset the cache between tests. Not exported via the package barrel
 * because production code has no business reaching for this — only
 * the test suite imports it.
 */
export function __resetAdminPathGuardCacheForTests(): void {
  cachedState = null;
  inflightRead = null;
}

async function readState(db: Database): Promise<CachedState> {
  const now = Date.now();
  if (cachedState && now - cachedState.cachedAt < STATE_CACHE_TTL_MS) {
    return cachedState;
  }
  // Coalesce concurrent cache misses to a single DB read — under a
  // burst, every other request awaits the in-flight promise rather
  // than firing its own SELECT.
  if (inflightRead) return inflightRead;
  inflightRead = (async () => {
    const rows = await db
      .select({
        state: systemState.state,
        adminPath: systemState.adminPath,
      })
      .from(systemState)
      .where(eq(systemState.id, 'singleton'))
      .limit(1);
    const row = rows[0];
    const fresh: CachedState = {
      state: row?.state ?? 'uninitialized',
      adminPath: row?.adminPath ?? null,
      cachedAt: Date.now(),
    };
    cachedState = fresh;
    inflightRead = null;
    return fresh;
  })();
  try {
    return await inflightRead;
  } catch (err) {
    // On read failure, fail closed: pretend uninitialized so the wizard
    // remains reachable. The setup router itself does its own state
    // check inside the transaction (Req 1.5/1.7), so this fail-open
    // for `/setup` does not let a partial setup state through.
    inflightRead = null;
    throw err;
  }
}

// ── path classification ────────────────────────────────────────────────

/**
 * Returns `true` when `path` is in the Studio scope (HTML/asset entry
 * points), i.e. it is *not* an API/ops route, AND either:
 *   - matches a default bait path (exact or sub-path), OR
 *   - matches the configured admin path (exact or sub-path), OR
 *   - is some other unknown path on the host (still must 404 per
 *     Req 5.6).
 *
 * In practice every non-API path falls into one of the three buckets
 * above, so this collapses to: "everything that's not API/ops and not
 * the wizard surface is Studio scope".
 */
export function isStudioScopePath(path: string): boolean {
  for (const prefix of NEVER_STUDIO_SCOPE_PREFIXES) {
    if (prefix.endsWith('/')) {
      if (path === prefix.slice(0, -1) || path.startsWith(prefix)) return false;
    } else if (path === prefix || path.startsWith(prefix + '/')) {
      return false;
    }
  }
  return true;
}

/**
 * Match `path` against `adminPath` treating an exact match or a
 * sub-path (`adminPath` followed by `/...`) as "in the admin path
 * scope". `/lumi-7f3a9c/assets/main.js` matches `/lumi-7f3a9c`,
 * `/lumi-7f3a9cx` does not.
 *
 * The exact comparison and the prefix comparison both go through
 * `pathEqualsConstantTime` (task 4.1) so we don't accidentally leak
 * the secret prefix via JS engine `startsWith` timing.
 */
export function pathMatchesAdminScope(path: string, adminPath: string): boolean {
  if (typeof adminPath !== 'string' || adminPath.length === 0) return false;
  // Exact admin path → match.
  if (pathEqualsConstantTime(path, adminPath)) return true;
  // Admin path + `/...` (sub-path).
  if (path.length <= adminPath.length) return false;
  const sep = path.charAt(adminPath.length);
  if (sep !== '/') return false;
  // Compare the first `adminPath.length` chars of `path` against
  // `adminPath` itself in constant time.
  const prefix = path.substring(0, adminPath.length);
  return pathEqualsConstantTime(prefix, adminPath);
}

// ── 404 response shape ─────────────────────────────────────────────────

/**
 * Canonical 404 body. Held as a constant so every mismatch returns the
 * exact same bytes — different bytes would let an attacker classify
 * responses by length even before opening them.
 */
const NOT_FOUND_BODY = JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] });
const NOT_FOUND_BYTE_LENGTH = new TextEncoder().encode(NOT_FOUND_BODY).byteLength;

/**
 * Build the indistinguishable-404 Response. We construct a fresh
 * Response object rather than calling `c.json()` so we can pin exactly
 * two headers — `Content-Type` and `Content-Length` — without anything
 * Hono might otherwise add (no `vary`, no `x-powered-by`, no compression
 * hints). The byte length is precomputed so the value matches the body
 * exactly.
 */
function buildIndistinguishable404(): Response {
  return new Response(NOT_FOUND_BODY, {
    status: 404,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(NOT_FOUND_BYTE_LENGTH),
    },
  });
}

// ── DB no-op for latency parity ────────────────────────────────────────

/**
 * Run a `SELECT 1` against the same DB the matched-path branch would
 * use. The result is discarded; the only purpose is to keep the
 * mismatched-branch latency profile aligned with the matched branch
 * (Req 5.1 / design §7.2). Errors are swallowed — a broken DB at this
 * point would be visible elsewhere, and a 500 here would itself leak
 * "this is the special path" timing/shape information.
 */
async function selectOneNoop(db: Database): Promise<void> {
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    // Intentional: see comment above.
  }
}

// ── middleware ─────────────────────────────────────────────────────────

/**
 * Build the middleware. The factory keeps the surface symmetric with
 * the rest of `apps/cms/src/middleware/*` (`withDb()`, `withAuth()`,
 * etc.) and gives tests a stable handle.
 */
export function adminPathGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = c.req.path;

    // Fast bypass for non-Studio scope. This covers /api/* and the
    // ops surfaces. Doing this before the DB read keeps API latency
    // off the cache hot path entirely.
    if (!isStudioScopePath(path)) {
      return next();
    }

    // Locate the per-request DB client. Every entry-point in
    // `apps/cms/src/index.ts` runs `withRuntime` globally, but the
    // per-request `withDb()` only attaches at routes that need it. To
    // keep this guard self-contained and runnable *before* `withDb()`
    // in the chain (design §6.2), we fish out the connection via the
    // runtime when `c.get('db')` is unset.
    const db = resolveDb(c);
    if (!db) {
      // No DB available means we can't tell if state is initialized. Fail
      // CLOSED: emit the canonical 404 so a misconfigured (or degraded)
      // deployment cannot leak the existence of the Studio path. On a real
      // deployment `withRuntime` is global, so this branch effectively only
      // fires in misconfigured tests — and there 404 is still correct.
      return buildIndistinguishable404();
    }

    let state: CachedState;
    try {
      state = await readState(db);
    } catch {
      // Fail CLOSED on read failure: run the latency no-op to preserve the
      // timing profile, then emit the canonical 404. A DB hiccup must not
      // downgrade the guard into leaking that this path is special.
      await selectOneNoop(db);
      return buildIndistinguishable404();
    }

    // Bypass while the wizard is reachable (Req 5.4).
    if (state.state !== 'initialized') {
      return next();
    }

    // Initialized but no admin path persisted (theoretical — the setup
    // transaction sets both atomically). Treat as "everything 404" to
    // be safe.
    if (!state.adminPath) {
      await selectOneNoop(db);
      return buildIndistinguishable404();
    }

    if (pathMatchesAdminScope(path, state.adminPath)) {
      // Tag the response so observability can distinguish Studio HTML
      // requests from API responses (Req 5.2). The actual HTML/asset
      // serving happens further down the chain.
      c.set('responseType', 'STUDIO_HTML');
      return next();
    }

    // Mismatch — run the no-op and emit the canonical 404.
    await selectOneNoop(db);
    return buildIndistinguishable404();
  };
}

/**
 * Resolve the request-scoped Database. Prefer `c.get('db')` when an
 * earlier middleware has already attached it; fall back to the runtime
 * adapter so the guard works even when mounted before `withDb()` (the
 * design intends the guard to sit early in the chain — design §6.2).
 *
 * Returns `null` when no source is available; the caller treats this
 * as "fail open and continue".
 */
function resolveDb(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
): Database | null {
  const existing = c.get('db');
  if (existing) return existing;
  const runtime = c.get('runtime');
  if (!runtime) return null;
  // The runtime exposes a `postgres.Sql` connection; wrap it in
  // Drizzle on the spot so the guard works even when `withDb()` has
  // not yet run.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlConn = runtime.database.getConnection() as any;
  return drizzle(sqlConn, { schema }) as unknown as Database;
}
