/**
 * Change Feed HTTP surface (design §9) — mounted at `/api/v1/cdc` on the
 * authenticated `api` Hono, BEFORE the ClickHouse control-plane router
 * (whose `use('*')` admin guard would otherwise swallow feed reads).
 *
 * Guard model (Req 2.3, 7.3 + ADR-011):
 * - every route rejects frontend-audience tokens — the feed is a
 *   control-plane/integration surface, never an end-user one;
 * - `GET /events` + `POST /subscriptions/:id/ack` need the `cdc:subscribe`
 *   capability (role-carried, same convention as `getUserCapabilities`;
 *   `admin`/`*` satisfies implicitly, mirroring `checkCapabilities`);
 * - subscription management (CRUD, replay, dispatch, deliveries) requires
 *   site-admin, resolved through PermissionService like the deployments
 *   router.
 *
 * Services are injectable per request (`CdcFeedServicesFactory`) so route
 * tests run against fakes with no Postgres — the `cdc-routes.test.ts`
 * pattern.
 */

import { Hono, type Context } from 'hono';
import {
  CdcAckSchema,
  CdcFeedQuerySchema,
  CdcFeedSettingsSchema,
  CdcReplaySchema,
  CdcSubscriptionCreateSchema,
  CdcSubscriptionPatchSchema,
  decodeCdcCursor,
  type CdcOperation,
} from '@lumibase/contracts/schemas';
import { and, eq } from 'drizzle-orm';
import { settings } from '@lumibase/database';
import type { AppEnv } from '../../../env';
import { isFrontendAudience } from '../../../services/auth/token-audience';
import { PermissionService } from '../../../services/permission-service';
import { AuditLogger } from '../../audit/logger';
import {
  CursorExpiredError,
  DrizzleCdcEventStore,
  FeedReader,
  type FeedPage,
} from './feed-reader';
import {
  CdcDispatcher,
  createWebhookEnvelopeSender,
  DrizzleDeliveryLog,
  DrizzleSubscriptionDispatchStore,
} from './dispatcher';
import {
  AckRegressionError,
  InvalidTransitionError,
  ReplayOutOfRetentionError,
  SubscriptionLimitExceededError,
  SubscriptionNameConflictError,
  SubscriptionNotFoundError,
  SubscriptionService,
  WebhookSecretRequiredError,
  type SubscriptionRecord,
} from './subscription-service';

export interface CdcFeedRouteServices {
  readFeed: (
    cursor: string | null,
    filters: { collections?: string[]; operations?: string[] },
    limit: number,
  ) => Promise<FeedPage>;
  subscriptions: Pick<
    SubscriptionService,
    'create' | 'list' | 'get' | 'patch' | 'remove' | 'ack' | 'replay' | 'listDeliveries'
  >;
  /** null → guard passes; a Response → returned as-is (403/401). */
  authorizeFeedRead: (c: Context<AppEnv>) => Promise<Response | null>;
  authorizeSiteAdmin: (c: Context<AppEnv>) => Promise<Response | null>;
  /** On-demand dispatch (Req 4.7) — the no-queue fallback path. */
  dispatchNow: (subscriptionId: string) => Promise<{ dispatched: boolean }>;
  /** Injectable delay for long-poll (tests override to run instantly). */
  sleep?: (ms: number) => Promise<void>;
}

/** Poll cadence while a long-poll request waits for the first event. */
export const LONG_POLL_INTERVAL_MS = 1_000;

export type CdcFeedServicesFactory = (
  c: Context<AppEnv>,
) => Partial<CdcFeedRouteServices>;

function errors(c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 409 | 410 | 501, code: string, message: string, extra?: Record<string, unknown>) {
  return c.json({ errors: [{ code, message, ...(extra ?? {}) }] }, status);
}

/** ADR-011: the feed is studio/API-key realm only. */
function rejectFrontendRealm(c: Context<AppEnv>): Response | null {
  const auth = c.get('auth');
  if (isFrontendAudience((auth?.raw as Record<string, unknown> | undefined)?.aud)) {
    return errors(c, 403, 'FORBIDDEN', 'The change feed is not available to frontend-realm tokens.');
  }
  return null;
}

async function resolveRetentionDays(c: Context<AppEnv>): Promise<number> {
  const [row] = await c
    .get('db')
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.siteId, c.get('siteId')), eq(settings.key, 'cdc_feed')))
    .limit(1);
  const parsed = CdcFeedSettingsSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data.retentionDays : 7;
}

export const defaultCdcFeedServicesFactory = (
  c: Context<AppEnv>,
): CdcFeedRouteServices => {
  // Everything DB-touching is resolved lazily inside the closures so building
  // the default services never runs a query — tests that inject fakes must
  // work with no `db` on the context (the control-plane router's convention).
  let resolved: { reader: FeedReader; subscriptions: SubscriptionService } | null = null;
  const init = async () => {
    if (resolved) return resolved;
    const db = c.get('db');
    const siteId = c.get('siteId');
    const runtime = c.get('runtime');
    const retentionDays = await resolveRetentionDays(c);
    const store = new DrizzleCdcEventStore(db);
    const reader = new FeedReader({ store, siteId, retentionDays });
    const subscriptions = new SubscriptionService({
      db,
      siteId,
      eventStore: store,
      cache: runtime?.cache,
      retentionDays,
      audit: async (event, metadata) => {
        await new AuditLogger({ db, siteId }).write({
          event,
          actorEmail: null,
          ip: c.req.header('cf-connecting-ip') ?? null,
          userAgent: c.req.header('user-agent') ?? null,
          requestId: null,
          metadata,
        });
      },
    });
    resolved = { reader, subscriptions };
    return resolved;
  };

  const authorizeSiteAdmin = async (ctx: Context<AppEnv>): Promise<Response | null> => {
    const realm = rejectFrontendRealm(ctx);
    if (realm) return realm;
    const auth = ctx.get('auth');
    if (!auth) return errors(ctx, 401, 'UNAUTHORIZED', 'Authentication required.');
    const svc = new PermissionService({
      db: ctx.get('db'),
      cache: ctx.get('runtime')?.cache,
      ctx: {
        siteId: ctx.get('siteId'),
        userId: auth.userId ?? null,
        roleId: auth.roleId ?? null,
        apiKey: (auth.apiKey as Record<string, unknown> | null) ?? null,
        headers: {},
        ip: null,
      },
    });
    const bundle = await svc.bundle();
    if (!bundle.admin) {
      return errors(ctx, 403, 'FORBIDDEN', 'Site admin access required.');
    }
    return null;
  };

  const authorizeFeedRead = async (ctx: Context<AppEnv>): Promise<Response | null> => {
    const realm = rejectFrontendRealm(ctx);
    if (realm) return realm;
    const auth = ctx.get('auth');
    if (!auth) return errors(ctx, 401, 'UNAUTHORIZED', 'Authentication required.');
    const roles: string[] = Array.isArray(auth.roles) ? auth.roles : [];
    if (roles.includes('admin') || roles.includes('*') || roles.includes('cdc:subscribe')) {
      return null;
    }
    // Fall back to the compiled RBAC bundle so API keys attached to an
    // admin role/policy pass without carrying a literal role string.
    const adminDenied = await authorizeSiteAdmin(ctx);
    if (adminDenied === null) return null;
    return errors(ctx, 403, 'FORBIDDEN', 'Requires the cdc:subscribe capability.');
  };

  const subscriptions: CdcFeedRouteServices['subscriptions'] = {
    create: async (input) => (await init()).subscriptions.create(input),
    list: async () => (await init()).subscriptions.list(),
    get: async (id) => (await init()).subscriptions.get(id),
    patch: async (id, input) => (await init()).subscriptions.patch(id, input),
    remove: async (id) => (await init()).subscriptions.remove(id),
    ack: async (id, cursor) => (await init()).subscriptions.ack(id, cursor),
    replay: async (id, target, actor) => (await init()).subscriptions.replay(id, target, actor),
    listDeliveries: async (id, opts) => (await init()).subscriptions.listDeliveries(id, opts),
  };

  return {
    readFeed: async (cursor, filters, limit) =>
      (await init()).reader.read(
        cursor ? decodeCdcCursor(cursor) : null,
        {
          collections: filters.collections,
          operations: filters.operations as CdcOperation[] | undefined,
        },
        limit,
      ),
    subscriptions,
    authorizeFeedRead,
    authorizeSiteAdmin,
    dispatchNow: async (subscriptionId) => {
      const db = c.get('db');
      const siteId = c.get('siteId');
      const dispatcher = new CdcDispatcher({
        eventStore: new DrizzleCdcEventStore(db),
        subscriptions: new DrizzleSubscriptionDispatchStore(db),
        deliveryLog: new DrizzleDeliveryLog(db),
        senders: { webhook: createWebhookEnvelopeSender(db) },
        cache: c.get('runtime')?.cache,
      });
      return { dispatched: await dispatcher.dispatchSubscriptionById(siteId, subscriptionId) };
    },
  };
};

/** Kept for tests/overrides that model a runtime without dispatch capability. */
export class DispatcherUnavailableError extends Error {
  constructor() {
    super('On-demand dispatch is not available yet');
    this.name = 'DispatcherUnavailableError';
  }
}

function mapServiceError(c: Context<AppEnv>, err: unknown): Response | null {
  if (err instanceof SubscriptionNotFoundError) return errors(c, 404, 'NOT_FOUND', err.message);
  if (err instanceof SubscriptionNameConflictError) return errors(c, 409, 'NAME_CONFLICT', err.message);
  if (err instanceof SubscriptionLimitExceededError) return errors(c, 403, 'LIMIT_EXCEEDED', err.message);
  if (err instanceof WebhookSecretRequiredError) return errors(c, 400, 'WEBHOOK_SECRET_REQUIRED', err.message);
  if (err instanceof AckRegressionError) return errors(c, 409, 'ACK_REGRESSION', err.message);
  if (err instanceof InvalidTransitionError) return errors(c, 409, 'INVALID_TRANSITION', err.message);
  if (err instanceof ReplayOutOfRetentionError) return errors(c, 400, 'REPLAY_OUT_OF_RETENTION', err.message);
  if (err instanceof DispatcherUnavailableError) return errors(c, 501, 'NOT_IMPLEMENTED', err.message);
  if (err instanceof CursorExpiredError) {
    return errors(c, 410, 'CURSOR_EXPIRED', err.message, { earliestCursor: err.earliestCursor });
  }
  return null;
}

export function createCdcFeedRouter(servicesFactory?: CdcFeedServicesFactory): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  const services = (c: Context<AppEnv>): CdcFeedRouteServices => {
    const defaults = defaultCdcFeedServicesFactory(c);
    const overrides = servicesFactory ? servicesFactory(c) : {};
    return { ...defaults, ...overrides };
  };

  // ── Feed read (capability guard) ─────────────────────────────────────
  router.get('/events', async (c) => {
    const svc = services(c);
    const denied = await svc.authorizeFeedRead(c);
    if (denied) return denied;
    const parsed = CdcFeedQuerySchema.safeParse({
      cursor: c.req.query('cursor'),
      collections: c.req.query('collections'),
      operations: c.req.query('operations'),
      limit: c.req.query('limit'),
      wait: c.req.query('wait'),
    });
    if (!parsed.success) {
      return errors(c, 400, 'VALIDATION_ERROR', 'Invalid feed query.', {
        fields: parsed.error.issues.map((i) => i.path.join('.')),
      });
    }
    try {
      const filters = { collections: parsed.data.collections, operations: parsed.data.operations };
      const readOnce = () => svc.readFeed(parsed.data.cursor ?? null, filters, parsed.data.limit);
      const sleep = svc.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

      let page = await readOnce();
      // Long-poll (Req: reduce empty polls): hold the request and re-read until
      // an event appears or the budget elapses. Only kicks in on an empty first
      // page so a caller that is already behind returns its backlog at once.
      if (parsed.data.wait > 0 && page.events.length === 0) {
        const deadline = parsed.data.wait * 1000;
        for (let waited = 0; waited < deadline && page.events.length === 0; waited += LONG_POLL_INTERVAL_MS) {
          await sleep(Math.min(LONG_POLL_INTERVAL_MS, deadline - waited));
          page = await readOnce();
        }
      }
      return c.json({
        data: page.events,
        meta: { nextCursor: page.nextCursor, hasMore: page.hasMore },
      });
    } catch (err) {
      const mapped = mapServiceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // ── Subscription management (site admin) ─────────────────────────────
  const admin = async (c: Context<AppEnv>) => {
    const svc = services(c);
    const denied = await svc.authorizeSiteAdmin(c);
    return { svc, denied };
  };

  router.get('/subscriptions', async (c) => {
    const { svc, denied } = await admin(c);
    if (denied) return denied;
    return c.json({ data: await svc.subscriptions.list() });
  });

  router.post('/subscriptions', async (c) => {
    const { svc, denied } = await admin(c);
    if (denied) return denied;
    const parsed = CdcSubscriptionCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return errors(c, 400, 'VALIDATION_ERROR', 'Invalid subscription.', {
        fields: parsed.error.issues.map((i) => i.path.join('.')),
      });
    }
    try {
      const record: SubscriptionRecord = await svc.subscriptions.create(parsed.data);
      return c.json({ data: record }, 201);
    } catch (err) {
      const mapped = mapServiceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  router.get('/subscriptions/:id', async (c) => {
    const { svc, denied } = await admin(c);
    if (denied) return denied;
    try {
      return c.json({ data: await svc.subscriptions.get(c.req.param('id')) });
    } catch (err) {
      const mapped = mapServiceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  router.patch('/subscriptions/:id', async (c) => {
    const { svc, denied } = await admin(c);
    if (denied) return denied;
    const parsed = CdcSubscriptionPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return errors(c, 400, 'VALIDATION_ERROR', 'Invalid patch.', {
        fields: parsed.error.issues.map((i) => i.path.join('.')),
      });
    }
    try {
      return c.json({ data: await svc.subscriptions.patch(c.req.param('id'), parsed.data) });
    } catch (err) {
      const mapped = mapServiceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  router.delete('/subscriptions/:id', async (c) => {
    const { svc, denied } = await admin(c);
    if (denied) return denied;
    try {
      await svc.subscriptions.remove(c.req.param('id'));
      return c.json({ data: { ok: true } });
    } catch (err) {
      const mapped = mapServiceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // ── Checkpoint commit (capability guard — pull consumers) ────────────
  router.post('/subscriptions/:id/ack', async (c) => {
    const svc = services(c);
    const denied = await svc.authorizeFeedRead(c);
    if (denied) return denied;
    const parsed = CdcAckSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return errors(c, 400, 'VALIDATION_ERROR', 'Invalid ack cursor.', {
        fields: parsed.error.issues.map((i) => i.path.join('.')),
      });
    }
    try {
      return c.json({ data: await svc.subscriptions.ack(c.req.param('id'), parsed.data.cursor) });
    } catch (err) {
      const mapped = mapServiceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  router.post('/subscriptions/:id/replay', async (c) => {
    const { svc, denied } = await admin(c);
    if (denied) return denied;
    const parsed = CdcReplaySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return errors(c, 400, 'VALIDATION_ERROR', 'Provide exactly one of cursor or occurred_after.');
    }
    const auth = c.get('auth');
    try {
      return c.json({
        data: await svc.subscriptions.replay(
          c.req.param('id'),
          { cursor: parsed.data.cursor, occurredAfter: parsed.data.occurred_after },
          auth?.apiKeyId
            ? { type: 'api_key', id: auth.apiKeyId }
            : { type: 'user', id: auth?.userId ?? null },
        ),
      });
    } catch (err) {
      const mapped = mapServiceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  router.post('/subscriptions/:id/dispatch', async (c) => {
    const { svc, denied } = await admin(c);
    if (denied) return denied;
    try {
      return c.json({ data: await svc.dispatchNow(c.req.param('id')) }, 202);
    } catch (err) {
      const mapped = mapServiceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  router.get('/subscriptions/:id/deliveries', async (c) => {
    const { svc, denied } = await admin(c);
    if (denied) return denied;
    try {
      const page = await svc.subscriptions.listDeliveries(c.req.param('id'), {
        limit: Number(c.req.query('limit') ?? 50),
        page: Number(c.req.query('page') ?? 1),
      });
      return c.json({ data: page.data, meta: { total: page.total } });
    } catch (err) {
      const mapped = mapServiceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  return router;
}

/** Production instance mounted by `apps/cms/src/index.ts`. */
export const cdcFeedRouter = createCdcFeedRouter();
