import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  createCdcFeedRouter,
  DispatcherUnavailableError,
  type CdcFeedRouteServices,
} from '../modules/cdc/change-feed/routes';
import {
  AckRegressionError,
  InvalidTransitionError,
  ReplayOutOfRetentionError,
  SubscriptionLimitExceededError,
  SubscriptionNameConflictError,
  SubscriptionNotFoundError,
  WebhookSecretRequiredError,
  type SubscriptionRecord,
} from '../modules/cdc/change-feed/subscription-service';
import { CursorExpiredError } from '../modules/cdc/change-feed/feed-reader';
import { encodeCdcCursor } from '@lumibase/shared';
import type { AppEnv } from '../env';

/**
 * Change Feed route handlers against injected fakes (task 5.4 — the
 * `cdc-routes.test.ts` pattern): a parent Hono emulates the upstream
 * middleware chain by setting `auth`/`siteId`, and every service is a fake,
 * so no Postgres is involved. Covers the error contract:
 * 400 / 403 / 404 / 409 / 410 / 501 and the happy paths.
 */

type ResponseBody = {
  errors?: Array<{ code?: string; fields?: string[]; earliestCursor?: string | null }>;
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

const CURSOR = encodeCdcCursor({ occurredAtMs: 1_000, eventId: 'evt1' });

function record(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id: 'sub1',
    siteId: 'site_A',
    name: 'my-sub',
    kind: 'pull',
    collections: [],
    operations: [],
    payloadMode: 'reference',
    cursor: null,
    status: 'active',
    webhookId: null,
    extensionName: null,
    consecutiveFailures: 0,
    lastDeliveredAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lag: { events: 0, behindMs: null },
    ...overrides,
  };
}

function makeApp(overrides: Partial<CdcFeedRouteServices> = {}, opts: { frontend?: boolean } = {}) {
  const services: CdcFeedRouteServices = {
    readFeed: async () => ({ events: [], nextCursor: null, hasMore: false }),
    subscriptions: {
      create: async () => record(),
      list: async () => [record()],
      get: async () => record(),
      patch: async () => record(),
      remove: async () => undefined,
      ack: async () => record({ cursor: CURSOR }),
      replay: async () => record({ cursor: CURSOR }),
      listDeliveries: async () => ({ data: [], total: 0 }),
    },
    authorizeFeedRead: async () => null,
    authorizeSiteAdmin: async () => null,
    dispatchNow: async () => {
      throw new DispatcherUnavailableError();
    },
    ...overrides,
  };

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', {
      userId: 'u1',
      roles: ['admin'],
      raw: opts.frontend ? { aud: 'frontend' } : {},
    } as never);
    c.set('siteId', 'site_A');
    await next();
  });
  app.route('/', createCdcFeedRouter(() => services));
  return app;
}

describe('cdc-feed routes — error contract', () => {
  it('GET /events: 400 on malformed cursor', async () => {
    const res = await makeApp().request('/events?cursor=%%%not-a-cursor');
    expect(res.status).toBe(400);
    const body = ((await res.json()) as ResponseBody);
    expect(body.errors?.[0]?.code).toBe('VALIDATION_ERROR');
  });

  it('GET /events: 410 CURSOR_EXPIRED carries earliestCursor', async () => {
    const app = makeApp({
      readFeed: async () => {
        throw new CursorExpiredError(CURSOR);
      },
    });
    const res = await app.request(`/events?cursor=${CURSOR}`);
    expect(res.status).toBe(410);
    const body = ((await res.json()) as ResponseBody);
    expect(body.errors?.[0]?.code).toBe('CURSOR_EXPIRED');
    expect(body.errors?.[0]?.earliestCursor).toBe(CURSOR);
  });

  it('GET /events: 403 when the feed-read guard denies', async () => {
    const app = makeApp({
      authorizeFeedRead: async (c) =>
        c.json({ errors: [{ code: 'FORBIDDEN', message: 'nope' }] }, 403),
    });
    const res = await app.request('/events');
    expect(res.status).toBe(403);
  });

  it('POST /subscriptions: 400 with field list on invalid body', async () => {
    const res = await makeApp().request('/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ kind: 'webhook' }), // thiếu name + webhook_id
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    const body = ((await res.json()) as ResponseBody);
    expect(body.errors?.[0]?.fields).toContain('name');
  });

  it('POST /subscriptions: 409 on duplicate name', async () => {
    const app = makeApp({
      subscriptions: {
        ...makeAppServices().subscriptions,
        create: async () => {
          throw new SubscriptionNameConflictError('my-sub');
        },
      },
    });
    const res = await app.request('/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ name: 'my-sub', kind: 'pull' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(409);
  });

  it('POST /subscriptions: 403 at the 50-per-site limit', async () => {
    const app = makeApp({
      subscriptions: {
        ...makeAppServices().subscriptions,
        create: async () => {
          throw new SubscriptionLimitExceededError();
        },
      },
    });
    const res = await app.request('/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', kind: 'pull' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(403);
  });

  it('POST /subscriptions: 400 when the webhook has no secret (Req 4.2)', async () => {
    const app = makeApp({
      subscriptions: {
        ...makeAppServices().subscriptions,
        create: async () => {
          throw new WebhookSecretRequiredError();
        },
      },
    });
    const res = await app.request('/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', kind: 'webhook', webhook_id: 'wh1' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect((((await res.json()) as ResponseBody)).errors?.[0]?.code).toBe('WEBHOOK_SECRET_REQUIRED');
  });

  it('GET /subscriptions/:id: 404 when missing', async () => {
    const app = makeApp({
      subscriptions: {
        ...makeAppServices().subscriptions,
        get: async () => {
          throw new SubscriptionNotFoundError('nope');
        },
      },
    });
    expect((await app.request('/subscriptions/nope')).status).toBe(404);
  });

  it('POST /subscriptions/:id/ack: 409 ACK_REGRESSION on rewind (Req 3.3)', async () => {
    const app = makeApp({
      subscriptions: {
        ...makeAppServices().subscriptions,
        ack: async () => {
          throw new AckRegressionError();
        },
      },
    });
    const res = await app.request('/subscriptions/sub1/ack', {
      method: 'POST',
      body: JSON.stringify({ cursor: CURSOR }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(409);
    expect((((await res.json()) as ResponseBody)).errors?.[0]?.code).toBe('ACK_REGRESSION');
  });

  it('PATCH /subscriptions/:id: 409 INVALID_TRANSITION for dead→active via admin', async () => {
    const app = makeApp({
      subscriptions: {
        ...makeAppServices().subscriptions,
        patch: async () => {
          throw new InvalidTransitionError('dead', 'active');
        },
      },
    });
    const res = await app.request('/subscriptions/sub1', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'active' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(409);
  });

  it('POST /subscriptions/:id/replay: 400 when out of retention (Req 6.2)', async () => {
    const app = makeApp({
      subscriptions: {
        ...makeAppServices().subscriptions,
        replay: async () => {
          throw new ReplayOutOfRetentionError();
        },
      },
    });
    const res = await app.request('/subscriptions/sub1/replay', {
      method: 'POST',
      body: JSON.stringify({ cursor: CURSOR }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('POST /subscriptions/:id/replay: 400 when both cursor and occurred_after given', async () => {
    const res = await makeApp().request('/subscriptions/sub1/replay', {
      method: 'POST',
      body: JSON.stringify({ cursor: CURSOR, occurred_after: new Date(0).toISOString() }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('POST /subscriptions/:id/dispatch: 501 until Phase D lands the dispatcher', async () => {
    const res = await makeApp().request('/subscriptions/sub1/dispatch', { method: 'POST' });
    expect(res.status).toBe(501);
  });
});

describe('cdc-feed routes — happy paths', () => {
  it('GET /events returns { data, meta.nextCursor, meta.hasMore }', async () => {
    const res = await makeApp().request('/events');
    expect(res.status).toBe(200);
    const body = ((await res.json()) as ResponseBody);
    expect(body).toEqual({ data: [], meta: { nextCursor: null, hasMore: false } });
  });

  it('GET /events?wait: long-polls until an event appears, then returns it', async () => {
    let calls = 0;
    const app = makeApp({
      // Empty for the first two reads, then one event arrives.
      readFeed: async () => {
        calls += 1;
        return calls >= 3
          ? { events: [{ id: 'evt_late' }] as never, nextCursor: 'C', hasMore: false }
          : { events: [], nextCursor: null, hasMore: false };
      },
      sleep: async () => {}, // instant — no real waiting in tests
    });
    const res = await app.request('/events?wait=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResponseBody;
    expect((body.data as unknown as unknown[]).length).toBe(1);
    expect(calls).toBe(3);
  });

  it('GET /events?wait: returns empty after the budget elapses', async () => {
    let calls = 0;
    const app = makeApp({
      readFeed: async () => {
        calls += 1;
        return { events: [], nextCursor: null, hasMore: false };
      },
      sleep: async () => {},
    });
    const res = await app.request('/events?wait=3');
    expect(res.status).toBe(200);
    expect(((await res.json()) as ResponseBody).data).toEqual([]);
    // initial read + one re-read per second of budget.
    expect(calls).toBe(4);
  });

  it('GET /events?wait: skips long-poll when the first read already has events', async () => {
    let calls = 0;
    const app = makeApp({
      readFeed: async () => {
        calls += 1;
        return { events: [{ id: 'e' }] as never, nextCursor: 'C', hasMore: true };
      },
      sleep: async () => {
        throw new Error('sleep must not be called when the first page is non-empty');
      },
    });
    const res = await app.request('/events?wait=10');
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('POST /subscriptions returns 201 with the record', async () => {
    const res = await makeApp().request('/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ name: 'my-sub', kind: 'pull' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(201);
    expect((((await res.json()) as ResponseBody)).data?.name).toBe('my-sub');
  });

  it('GET /subscriptions/:id/deliveries returns data + meta.total', async () => {
    const res = await makeApp().request('/subscriptions/sub1/deliveries');
    expect(res.status).toBe(200);
    expect(((await res.json()) as ResponseBody)).toEqual({ data: [], meta: { total: 0 } });
  });
});

function makeAppServices(): CdcFeedRouteServices {
  return {
    readFeed: async () => ({ events: [], nextCursor: null, hasMore: false }),
    subscriptions: {
      create: async () => record(),
      list: async () => [record()],
      get: async () => record(),
      patch: async () => record(),
      remove: async () => undefined,
      ack: async () => record(),
      replay: async () => record(),
      listDeliveries: async () => ({ data: [], total: 0 }),
    },
    authorizeFeedRead: async () => null,
    authorizeSiteAdmin: async () => null,
    dispatchNow: async () => ({ dispatched: true }),
  };
}
