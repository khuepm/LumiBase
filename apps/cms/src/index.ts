import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './env';
import { withAuth } from './middleware/auth';
import { withDb } from './middleware/db';
import { withLogger } from './middleware/logger';
import { withRls } from './middleware/rls';
import { withRuntime } from './middleware/runtime';
import { withTenant } from './middleware/tenant';
import { activityRouter } from './routes/activity';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { collectionsRouter } from './routes/collections';
import { deliverRouter } from './routes/deliver';
import { extensionsRouter } from './routes/extensions';
import { filesRouter } from './routes/files';
import { flowsRouter } from './routes/flows';
import { itemsRouter } from './routes/items';
import { permissionsRouter } from './routes/permissions';
import { policiesRouter } from './routes/policies';
import { presetsRouter } from './routes/presets';
import { realtimeRouter } from './routes/realtime';
import { relationsRouter } from './routes/relations';
import { rolesRouter } from './routes/roles';
import { healthRouter } from './routes/health';
import { mediaRouter } from './routes/media';
import { metricsRouter, withMetrics } from './routes/metrics';
import { searchRouter } from './routes/search';
import { settingsRouter } from './routes/settings';
import { teamsRouter } from './routes/teams';
import { translationsRouter } from './routes/translations';
import { tmRouter } from './routes/translation-memory';
import { typegenRouter } from './routes/typegen';
import { usersRouter } from './routes/users';
import { utilsRouter } from './routes/utils';
import { webhooksRouter } from './routes/webhooks';

const app = new Hono<AppEnv>();

// Global middleware. Order matters: logger first so it captures everything;
// CORS before auth so preflight requests succeed. Runtime must be available
// before tenant resolution (which may use the cache).
app.use('*', withLogger());
app.use('*', withMetrics());
app.use('*', withRuntime());
app.use(
  '*',
  cors({
    origin: (origin) => origin ?? '*',
    credentials: true,
    allowHeaders: ['Authorization', 'Content-Type', 'X-Lumi-Site', 'X-Request-Id'],
    exposeHeaders: ['X-Request-Id'],
  }),
);

// Public utility endpoints (no tenant, no auth).
app.route('/api/v1/utils', utilsRouter);
// Prometheus metrics endpoint (public, no auth).
app.route('/metrics', metricsRouter);
// Comprehensive health check — tests DB, cache, search, storage, queue connectivity.
app.route('/health', healthRouter);

// Authenticated + tenant-scoped surface.
const api = new Hono<AppEnv>();
api.use('*', withTenant(), withAuth(), withDb(), withRls());
api.route('/auth', authRouter);
api.route('/collections', collectionsRouter);
api.route('/relations', relationsRouter);
api.route('/items', itemsRouter);
api.route('/typegen', typegenRouter);
api.route('/roles', rolesRouter);
api.route('/policies', policiesRouter);
api.route('/permissions', permissionsRouter);
api.route('/search', searchRouter);
api.route('/media', mediaRouter);
// Future routers: presets, translations, ...
api.route('/presets', presetsRouter);
api.route('/translations', translationsRouter);
api.route('/settings', settingsRouter);
api.route('/users', usersRouter);
api.route('/teams', teamsRouter);
api.route('/files', filesRouter);
api.route('/webhooks', webhooksRouter);
api.route('/activity', activityRouter);
api.route('/realtime', realtimeRouter);
api.route('/extensions', extensionsRouter);
api.route('/admin', adminRouter);
api.route('/tm', tmRouter);
api.route('/flows', flowsRouter);

app.route('/api/v1', api);

// Delivery (public) routes — tenancy is encoded in the URL.
app.use('/api/v1/deliver/*', withDb());
app.route('/api/v1/deliver', deliverRouter);

app.notFound((c) =>
  c.json({ errors: [{ code: 'NOT_FOUND', message: 'Route not found.' }] }, 404),
);
app.onError((err, c) => {
  const requestId = c.get('requestId');
  console.error('[lumibase-cms] unhandled error', { requestId, err });
  return c.json(
    { errors: [{ code: 'INTERNAL', message: 'Internal Server Error', requestId }] },
    500,
  );
});

export default app;
