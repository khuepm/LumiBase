import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './env';
import { resolveCorsOrigin } from './config/cors';
import { adminPathGuard } from './middleware/admin-path-guard';
import { withAuditContext } from './middleware/audit-context';
import { withJsonBodyLimit } from './middleware/body-limit';
import { withAuth } from './middleware/auth';
import { withDb } from './middleware/db';
import { withLogger } from './middleware/logger';
import { withRateLimit } from './middleware/rate-limit';
import { withRls } from './middleware/rls';
import { withRuntime } from './middleware/runtime';
import { requireSetupComplete } from './middleware/setup-required';
import { withSiteMembership } from './middleware/site-membership';
import { withStudioAccess } from './middleware/studio-access';
import { withControlPlaneAccessGuard } from './middleware/control-plane-access-guard';
import { withFileUploadPolicy } from './middleware/file-upload-policy';
import { withSecurityHeaders } from './middleware/security-headers';
import { withTenant } from './middleware/tenant';
import { withTracing } from './middleware/tracing';
import { activityRouter } from './routes/activity';
import { accessRouter } from './routes/access';
import { adminRouter } from './routes/admin';
import { configRouter } from './routes/config';
import { authRouter, meRouter } from './routes/auth';
import { adminSecurityRouter } from './routes/admin-security';
import { adminAuthIssuersRouter } from './routes/admin-auth-issuers';
import { adminEncryptionRouter } from './routes/admin-encryption';
import { editorialRouter } from './routes/editorial';
import { adminErasureRouter } from './routes/admin-erasure';
import { adminFieldAccessRouter } from './routes/admin-field-access';
import { adminSarRouter } from './routes/admin-sar';
import { apiKeysRouter } from './routes/api-keys';
import { collectionsRouter } from './routes/collections';
import { automatedDecisionsRouter } from './routes/automated-decisions';
import { consentRouter } from './routes/consent';
import { dataExportRouter } from './routes/data-export';
import { restrictionRouter } from './routes/restriction';
import { retentionRouter } from './routes/retention';
import { emailPublicRouter } from './routes/email-public';
import { deliverRouter } from './routes/deliver';
import { deploymentsRouter, deploymentsWebhookRouter } from './routes/deployments';
import { extensionsRouter } from './routes/extensions';
import { filesRouter } from './routes/files';
import { flowsRouter } from './routes/flows';
import { itemsRouter } from './routes/items';
import { handleGraphQL } from './graphql';
import { permissionsRouter } from './routes/permissions';
import { policiesRouter } from './routes/policies';
import { presetsRouter } from './routes/presets';
import { pushRouter } from './routes/push';
import { realtimeRouter } from './routes/realtime';
import { relationsRouter } from './routes/relations';
import { releasesRouter } from './routes/releases';
import { rolesRouter } from './routes/roles';
import { healthRouter } from './routes/health';
import { insightsRouter } from './routes/insights';
import { mediaRouter } from './routes/media';
import { transformPresetsRouter } from './routes/transform-presets';
import { uploadsRouter } from './routes/uploads';
import { marketplaceRouter } from './routes/marketplace';
import { materializeRouter } from './routes/materialize';
import { metricsRouter, withMetrics } from './routes/metrics';
import { searchRouter } from './routes/search';
import { scimRouter } from './routes/scim';
import { scimAdminRouter } from './routes/scim-admin';
import { settingsRouter } from './routes/settings';
import { domainsRouter } from './routes/domains';
import { siteRouter } from './routes/site';
import { systemRouter } from './routes/system';
import { shareAdminRouter, sharePublicRouter } from './routes/shares';
import { teamsRouter } from './routes/teams';
import { translationsRouter } from './routes/translations';
import { tmRouter } from './routes/translation-memory';
import { typegenRouter } from './routes/typegen';
import { usersRouter } from './routes/users';
import { utilsRouter } from './routes/utils';
import { webhooksRouter } from './routes/webhooks';
import { testAuthRouter } from './routes/test-auth';
import { aiRouter } from './routes/ai';
import { agentRouter } from './routes/agent';
import { intentsRouter } from './routes/intents';
import { mcpRouter } from './routes/mcp';
import { emailRouter } from './modules/email/routes';
import { setupRouter } from './modules/setup/routes';
import { recoveryRouter } from './modules/recovery/routes';
import { auditRouter } from './modules/audit/routes';
import { cdcRouter } from './modules/cdc';
import { cdcFeedRouter } from './modules/cdc/change-feed/routes';
import { lumibaseFirebaseSyncRouter } from './modules/lumibase-firebase-sync';
import { pageviewsRouter, pageviewsPublicRouter } from './modules/pageviews/routes';
import {
  gitRouter,
  gitPublicRouter,
} from './modules/git-integration/routes';
import { formatSafeError } from '@lumibase/shared/utils';

const app = new Hono<AppEnv>();

// Global middleware. Order matters: logger first so it captures everything;
// CORS before auth so preflight requests succeed. Runtime must be available
// before tenant resolution (which may use the cache).
app.use('*', withLogger());
app.use('*', withTracing());
app.use('*', withSecurityHeaders());
app.use('*', withMetrics());
app.use('*', withRuntime());
app.use(
  '*',
  cors({
    origin: (origin, c) => resolveCorsOrigin(origin, c.env),
    credentials: true,
    allowHeaders: ['Authorization', 'Content-Type', 'X-Lumi-Site', 'X-Lumi-Client', 'X-Request-Id', 'X-Lumi-Share-Password', 'X-LumiBase-Refresh'],
    exposeHeaders: ['X-Request-Id'],
  }),
);

// Audit-context middleware (admin-setup-wizard task 11.2; Req 15.1,
// 15.2; design §6.2). Slots in between `withLogger` (which sets
// `requestId`) and `adminPathGuard`, matching design §6.2's ordering:
// it resolves and stashes `ip` + `userAgent` onto the context so the
// guard, every route below, and every `AuditLogger.write` caller read
// the same audit dimensions uniformly. Placed after the
// `withRuntime`/`cors` block (which §6.2 doesn't enumerate) and just
// before the guard so the three audit dimensions are present for the
// entire downstream chain.
// App-level JSON body-size cap (high-load-cache-readiness Req 6.2).
// Defense-in-depth for deployments without the Caddy body limit; only
// guards JSON POST/PUT/PATCH via Content-Length, so it's a cheap no-op
// for reads and file uploads (which have their own policy).
app.use('*', withJsonBodyLimit());

app.use('*', withAuditContext());

// Admin Path Guard (admin-setup-wizard Req 5.1, 5.2, 5.4, 5.6, 5.7;
// design §6.2 + §7.2).
//
// Mounted *after* the global request-id/runtime stack so the guard
// can resolve a per-request DB via `c.get('runtime')`, and *before*
// any route mount so a probing bot hitting `/admin`, `/studio`, etc.
// gets the indistinguishable 404 envelope without ever touching a
// route handler. The guard internally bypasses `/api/*`, `/health`,
// `/metrics`, `/scim/*`, `/setup`, `/.well-known/*` (so the wizard
// surface, ops endpoints, and SCIM provisioning keep working) and
// fails open while `system_state.state !== 'initialized'` so a fresh
// instance can still reach the Setup Wizard at `/setup`.
//
// The `audit-context` middleware (task 11.2) now slots in just above
// this guard (see `app.use('*', withAuditContext())` directly above),
// so `ip` / `userAgent` / `requestId` are all populated before the
// guard and every downstream handler run — matching design §6.2.
app.use('*', adminPathGuard());

// Public utility endpoints (no tenant, no auth).
app.route('/api/v1/utils', utilsRouter);
app.route('/api/v1/system', systemRouter);
// Prometheus metrics endpoint (public, no auth).
app.route('/metrics', metricsRouter);
// Comprehensive health check — tests DB, cache, search, storage, queue connectivity.
app.route('/health', healthRouter);
// Serves interactive auth testing page
app.route('/test-auth', testAuthRouter);

// Setup wizard surface (`/api/v1/setup/*`). Public — does not pass through
// `withTenant`/`withAuth` because no user exists during first-time setup.
// `withRuntime` already ran globally so the per-request `withDb()` inside
// the router resolves the connection through the runtime's DatabaseProvider.
app.route('/api/v1/setup', setupRouter);

// Public recovery surface (admin-setup-wizard task 10.7; Req 14.4, 14.5,
// 14.8; design §4.7, §4.8). PUBLIC / pre-auth on purpose: the operator
// is locked out and CANNOT authenticate, so `/admin/security/recover`
// and `/admin/security/forgot-path` must NOT pass through `withAuth` or
// the `admin` role gate. The router applies only `withDb()` internally
// (like `setupRouter`).
//
// Mounted at `/api/v1/admin/security` *before* `app.route('/api/v1', api)`
// below — where the AUTHENTICATED `adminSecurityRouter` lives. Hono
// flattens sub-apps and matches by METHOD + exact leaf path, and the
// recovery router only registers `/recover` + `/forgot-path`. Those leaf
// paths are DISJOINT from the authenticated `/unlock-user` + `/unblock-ip`,
// so this public mount can NOT shadow them: a request to `/unlock-user`
// never matches a handler here and falls through to the authenticated
// `api` mount, still gated by `withAuth` + the admin check. Same
// coexistence mechanism the public `setupRouter` already relies on. See
// the header doc in `modules/recovery/routes.ts` for the full rationale.
app.route('/api/v1/admin/security', recoveryRouter);

// SCIM 2.0 provisioning. Auth happens inside the router using SCIM_TOKEN.
// Needs withDb() so it can write to the users/teams tables.
app.use('/scim/v2/*', withDb());
app.route('/scim/v2', scimRouter);

// Inbound deployment status webhook. PUBLIC / pre-auth on purpose: the
// provider (Vercel/Netlify) authenticates via request signature, not a bearer
// token. Needs `withTenant` (X-Lumi-Site → siteId) + `withDb` to update the
// `deployments` row; `withRuntime` already ran globally for the KeyProvider.
app.use('/api/v1/deployments/webhook/*', withTenant(), withDb());
app.route('/api/v1/deployments/webhook', deploymentsWebhookRouter);

// Git integration public surface — OAuth callback + signature-verified webhook
// receiver. PUBLIC on purpose: providers and OAuth redirects cannot carry a
// session. The router applies only `withDb()` internally (like `setupRouter`).
// Mounted BEFORE the authenticated `api` so its leaf paths
// (`/oauth/:provider/callback`, `/webhook/:provider/:siteId/:integrationId`)
// win; all other `/integrations/git/*` paths fall through to the authenticated
// `gitRouter` below.
app.route('/api/v1/integrations/git', gitPublicRouter);

// Authenticated + tenant-scoped surface.
const api = new Hono<AppEnv>();
api.use('*', withTenant(), withDb(), withAuth(), withSiteMembership(), withRateLimit(), requireSetupComplete(), withStudioAccess(), withControlPlaneAccessGuard(), withFileUploadPolicy(), withRls());
api.route('/auth', authRouter);
// `/me/*` — current-user endpoints kept outside `/auth` to honour the
// URL contract from admin-setup-wizard design §7.3 (`GET /api/v1/me/admin-path`).
// Mounted on the authenticated `api` Hono so `withAuth` already enforces
// that the caller has a valid session before the handler runs.
api.route('/me', meRouter);
// `/me/consents` — self-service consent management (GDPR Art. 7, PDPD).
// Separate router from `meRouter`; mounted under the same authenticated `api`
// chain so the caller can only read/write their own consent.
api.route('/me/consents', consentRouter);
// `/me/data-export` — self-service "download my data" (GDPR Art. 15/20).
api.route('/me/data-export', dataExportRouter);
// `/me/restriction` — self-service restriction of processing (GDPR Art. 18).
api.route('/me/restriction', restrictionRouter);
// `/me/automated-decisions` — transparency over agent processing (GDPR Art. 22).
api.route('/me/automated-decisions', automatedDecisionsRouter);
// `/retention` — admin general data-retention pruning (site-admin only).
api.route('/retention', retentionRouter);
api.route('/collections', collectionsRouter);
api.route('/relations', relationsRouter);
api.route('/items', itemsRouter);
api.route('/releases', releasesRouter);
api.route('/editorial', editorialRouter);
// GraphQL surface (Yoga). Mounted inside the authenticated `api` sub-app so
// it inherits the full tenant → db → auth → RLS chain; `all` covers POST
// (operations) and GET (GraphiQL / introspection in non-prod).
api.all('/graphql', (c) => handleGraphQL(c));
api.route('/typegen', typegenRouter);
api.route('/roles', rolesRouter);
api.route('/policies', policiesRouter);
api.route('/permissions', permissionsRouter);
api.route('/access', accessRouter);
api.route('/config', configRouter);
api.route('/api-keys', apiKeysRouter);
api.route('/search', searchRouter);
api.route('/media', mediaRouter);
api.route('/transform-presets', transformPresetsRouter);
// Upload policy config (effective allowlist/size for the picker; admin edits).
api.route('/uploads', uploadsRouter);
// Future routers: presets, translations, ...
api.route('/presets', presetsRouter);
api.route('/translations', translationsRouter);
api.route('/settings', settingsRouter);
api.route('/site', siteRouter);
api.route('/domains', domainsRouter);
api.route('/shares', shareAdminRouter);
api.route('/users', usersRouter);
api.route('/teams', teamsRouter);
api.route('/files', filesRouter);
api.route('/webhooks', webhooksRouter);
api.route('/deployments', deploymentsRouter);
api.route('/email', emailRouter);
api.route('/activity', activityRouter);
api.route('/realtime', realtimeRouter);
api.route('/push', pushRouter);
api.route('/extensions', extensionsRouter);
api.route('/pageviews', pageviewsRouter);
api.route('/admin', adminRouter);
// Admin Security surface (admin-setup-wizard task 6.4; Req 7.6, 7.7,
// 8.7, 8.8, 8.9; design §4.5, §4.6). Mounted *under* `withAuth` so the
// admin-role gate inside the router can rely on `c.get('auth').roles`
// being populated. Sibling to `/admin` rather than nested so future
// recovery routes (task 10.7) can mount alongside without reshuffling.
api.route('/admin/security', adminSecurityRouter);
// Admin Encryption surface (regulated-content-readiness task 3.4; Req 3.5).
// Sibling to `/admin/security`, also under `withAuth` with an in-router
// admin-role gate. Handles key-rotation metadata + key listing.
api.route('/admin/encryption', adminEncryptionRouter);
// Admin Erasure surface (regulated-content-readiness task 9.4; Req 11).
api.route('/admin/erasure', adminErasureRouter);
// Field Access Log query (regulated-content-readiness task 5.3; Req 6.3).
api.route('/admin/field-access-log', adminFieldAccessRouter);
// Subject Access Request export (regulated-content-readiness task 10.3; Req 13).
api.route('/admin/sar', adminSarRouter);
// Trusted external JWT issuers (external-jwt-auth §5). Admin-only CRUD.
api.route('/admin/auth/issuers', adminAuthIssuersRouter);
// Audit-log QUERY + EXPORT surface (admin-setup-wizard task 12.3; Req
// 15.4, 15.6; design §4.9, §4.10, §10.3, §10.4). SIBLING mount alongside
// `adminSecurityRouter` above, both under `withAuth`. The admin-role gate
// is enforced INSIDE `auditRouter` via its own `requireAdmin(c)` check
// (mirroring `adminSecurityRouter`), returning 403 FORBIDDEN when
// `c.get('auth').roles` lacks `'admin'`.
//
// Safe + non-shadowing: Hono flattens `app.route(...)` sub-apps and
// matches by METHOD + exact leaf path, and this router's leaf paths
// (`/audit-log`, `/audit-log/export`) are DISJOINT from
// adminSecurityRouter's (`/unlock-user`, `/unblock-ip`). So
// `/api/v1/admin/security/audit-log` resolves to `auditRouter` while
// `/unlock-user` still resolves to `adminSecurityRouter`, both behind
// `withAuth`. Same disjoint-leaf-path coexistence the recovery router
// relies on.
api.route('/admin/security', auditRouter);
api.route('/tm', tmRouter);
api.route('/flows', flowsRouter);
api.route('/marketplace', marketplaceRouter);
api.route('/materialize', materializeRouter);
api.route('/dashboards', insightsRouter);
api.route('/scim-tokens', scimAdminRouter);
api.route('/ai', aiRouter);
api.route('/agent/intents', intentsRouter);
api.route('/agent', agentRouter);
// MCP server (content-os task 4; Req 4.1). Same authenticated chain as the
// Agent API — the MCP adapter passes the token's roles to the harness, so
// both surfaces share one decision codepath (Property 14).
api.route('/mcp', mcpRouter);

// ClickHouse CDC control-plane surface (`/api/v1/cdc/*`) — clickhouse-cdc
// task 12.2; Req 1.1; design "CDC API Routes" §7. Mounted on the
// AUTHENTICATED `api` Hono (NOT the public top-level `app`) so the upstream
// `withTenant` + `withAuth` + `withDb` + `withRls` chain runs before any CDC
// handler: a missing principal is already a 401, and `siteId` / `db` are
// populated before the router's own admin-role + site-context gate runs (see
// the SECURITY note in `modules/cdc/routes.ts`). Because `api` is mounted at
// `/api/v1` below, mounting `cdcRouter` at `/cdc` yields the intended
// `/api/v1/cdc/*` prefix — matching how every sibling module above is wired.
// Change Feed (spec cdc-extension-integration) shares the `/cdc` prefix but
// carries its own guards (capability for reads, site-admin for management).
// It MUST be mounted BEFORE `cdcRouter`: the control-plane router registers a
// blanket `use('*')` admin gate, and Hono composes matched handlers in
// registration order — feed handlers respond first, everything else falls
// through to the control-plane chain.
api.route('/cdc', cdcFeedRouter);
api.route('/cdc', cdcRouter);

// LumiBase Firebase Sync — outbound content mirroring to Firestore/RTDB.
// Same auth posture as CDC: upstream tenant/auth/db/rls + the router's own
// site-scoped admin gate. Yields `/api/v1/firebase-sync/*`.
api.route('/firebase-sync', lumibaseFirebaseSyncRouter);

// Git integration (GitHub / GitLab) authenticated surface — `/api/v1/integrations/git/*`.
// Same posture as CDC: upstream tenant/auth/db/rls + the router's own
// `requireSiteAdmin()` gate. The public OAuth-callback + webhook routes are
// mounted above on the top-level `app` and win for their disjoint leaf paths.
api.route('/integrations/git', gitRouter);

// Share links are public. The opaque token resolves the site and share role.
app.use('/api/v1/shares/*', withDb());
app.route('/api/v1/shares', sharePublicRouter);

// Email unsubscribe is public (CAN-SPAM one-click). The signed token resolves
// the site, so no session/tenant header is required. Registered before the
// authenticated `api` mount so `/email/unsubscribe` wins; all other `/email/*`
// paths fall through to the authenticated `emailRouter`.
app.use('/api/v1/email/unsubscribe', withDb());
app.route('/api/v1/email', emailPublicRouter);

app.route('/api/v1', api);

// Delivery (public) routes — tenancy is encoded in the URL.
app.use('/api/v1/deliver/*', withDb());
app.route('/api/v1/deliver', deliverRouter);

// Public pageview beacon — tenancy in the URL, unauthenticated. `withRuntime`
// ran globally; add `withDb` + the general rate limiter (keyed by IP since no
// principal exists) so a single client can't flood the ingest endpoint.
app.use('/api/v1/pageviews/*', withDb(), withRateLimit());
app.route('/api/v1/pageviews', pageviewsPublicRouter);

app.notFound((c) =>
  c.json({ errors: [{ code: 'NOT_FOUND', message: 'Route not found.' }] }, 404),
);
app.onError((err, c) => {
  const requestId = c.get('requestId');
  console.error('[lumibase-cms] unhandled error', { requestId, err: formatSafeError(err) });
  return c.json(
    { errors: [{ code: 'INTERNAL', message: 'Internal Server Error', requestId }] },
    500,
  );
});

export default app;

// Durable Object exports are only relevant for the Cloudflare Workers build.
// Wrangler resolves `SiteRoom` via class_name in wrangler.toml during `wrangler deploy`.
// Do NOT import site-room.ts here — it imports `cloudflare:workers` which crashes
// the Node.js / Docker build (serve.ts → dist/serve.js).
// See: apps/cms/src/realtime/site-room.ts
