import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { MemoryCacheProvider } from '@lumibase/runtime';
import type { AppEnv, AuthPrincipal } from '../../env';
import type { DecisionSiteSettings } from '../../services/decision-governance';
import type { ReviewContentAccess } from '../../services/review-service';
import { MemoryReviewStore } from '../../__tests__/helpers/memory-review-store';
import { aiReviewRouter } from '../ai-review';

/**
 * Draft review routes (#512). The DB-backed inputs are faked — capability
 * grant, `aiDecisions` setting, audit sink, review store and the caller's
 * content reader — while the governed decision path (gates, quota, provider
 * via a stubbed `fetch`, HTTP mapping) runs for real.
 */
const ctx = vi.hoisted(() => ({
  grant: { allowed: true, capabilities: ['ai:decide'] as string[], controlPlaneAdmin: false } as {
    allowed: boolean;
    capabilities: string[];
    controlPlaneAdmin: boolean;
    code?: string;
  },
  settings: { enabled: true, allowedStateFields: null } as DecisionSiteSettings,
  audits: [] as Array<{ event: string; metadata?: Record<string, unknown> }>,
  store: null as unknown,
  content: null as unknown,
}));

vi.mock('../../services/governed-capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/governed-capabilities')>()),
  resolveRequestCapabilities: vi.fn(async () => ctx.grant),
}));

vi.mock('../../services/decision-governance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/decision-governance')>()),
  readDecisionSettings: vi.fn(async () => ctx.settings),
}));

vi.mock('../../modules/audit/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/audit/logger')>()),
  AuditLogger: class {
    async write(entry: (typeof ctx.audits)[number]) {
      ctx.audits.push(entry);
    }
  },
}));

vi.mock('../../services/review-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/review-store')>()),
  reviewStoreFor: () => ctx.store,
}));

vi.mock('../../services/review-content-access', () => ({
  reviewContentAccessForRequest: () => ctx.content,
}));

interface Content extends ReviewContentAccess {
  item: Record<string, unknown>;
  writable: Set<string>;
}

function content(): Content {
  const c: Content = {
    item: { title: 'Summer sale', body: 'Buy now!!!' },
    writable: new Set(['title', 'body']),
    async readItem(_collection, itemId, fields) {
      if (itemId !== 'itm_1') {
        const { ReviewServiceError } = await import('../../services/review-service');
        throw new ReviewServiceError('REVIEW_ITEM_NOT_FOUND', 'Item not found.');
      }
      const values: Record<string, unknown> = {};
      for (const field of fields) if (c.item[field] !== undefined) values[field] = c.item[field];
      return { values, omittedFields: [] };
    },
    async deniedSnapshotFields(_collection, keys) {
      return keys.filter((key) => !c.writable.has(key));
    },
    async latestRevisionId() {
      return 'rev_1';
    },
  };
  return c;
}

let store: MemoryReviewStore;
let fake: Content;

beforeEach(() => {
  ctx.grant = { allowed: true, capabilities: ['ai:decide'], controlPlaneAdmin: false };
  ctx.settings = { enabled: true, allowedStateFields: null };
  ctx.audits = [];
  store = new MemoryReviewStore();
  fake = content();
  ctx.store = store;
  ctx.content = fake;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const principal: AuthPrincipal = { userId: 'usr_editor', email: 'editor@example.com', roles: ['member'], raw: {} };

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', principal);
    c.set('siteId', 'site_1');
    c.set('requestId', 'req_1');
    c.set('db', {} as AppEnv['Variables']['db']);
    c.set('runtime', { cache: new MemoryCacheProvider() } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/ai', aiReviewRouter);
  return app;
}

const env = { DECISION_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'ts-key' };

function call(app: Hono<AppEnv>, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(
    path,
    {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}

const profileBody = {
  key: 'spam-check',
  collection: 'posts',
  fields: ['title', 'body'],
  questions: {
    spam: { type: 'noul', instructions: 'Is this post spam?', criteria: { true: 'spam', false: 'legitimate' } },
  },
};

const jevOk = () =>
  new Response(
    JSON.stringify({
      model: 'jev-1.13',
      answers: { spam: { type: 'noul', noul: 0.8 } },
      usage: { input_tokens: 40, output_tokens: 3 },
    }),
    { status: 200 },
  );

async function seedProfile(app: Hono<AppEnv>) {
  const saved = ctx.grant;
  ctx.grant = { allowed: true, capabilities: ['admin'], controlPlaneAdmin: true };
  const res = await call(app, 'POST', '/ai/review-profiles', profileBody);
  ctx.grant = saved;
  expect(res.status).toBe(201);
}

describe('review profiles', () => {
  it('lets an admin create a profile and publish a new version', async () => {
    ctx.grant = { allowed: true, capabilities: ['admin'], controlPlaneAdmin: true };
    const app = buildApp();

    const created = await call(app, 'POST', '/ai/review-profiles', profileBody);
    expect(created.status).toBe(201);
    const versioned = await call(app, 'POST', '/ai/review-profiles/spam-check/versions', {
      ...profileBody,
      key: undefined,
      fields: ['title'],
    });
    expect(versioned.status).toBe(201);
    expect(((await versioned.json()) as { data: { version: number } }).data.version).toBe(2);

    const v1 = await call(app, 'GET', '/ai/review-profiles/spam-check?version=1');
    expect(((await v1.json()) as { data: { status: string } }).data.status).toBe('archived');
  });

  it('returns 403 to a non-admin profile write, even with ai:decide', async () => {
    const app = buildApp();
    expect((await call(app, 'POST', '/ai/review-profiles', profileBody)).status).toBe(403);
    expect((await call(app, 'POST', '/ai/review-profiles/spam-check/versions', profileBody)).status).toBe(403);
    expect(store.profiles).toHaveLength(0);
  });

  it('lets an ai:decide caller read profiles and 404s an unknown key', async () => {
    const app = buildApp();
    await seedProfile(app);
    const list = await call(app, 'GET', '/ai/review-profiles?collection=posts');
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);
    const missing = await call(app, 'GET', '/ai/review-profiles/nope');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe('REVIEW_PROFILE_NOT_FOUND');
  });

  it('returns 400 for an invalid profile body', async () => {
    ctx.grant = { allowed: true, capabilities: ['admin'], controlPlaneAdmin: true };
    const res = await call(buildApp(), 'POST', '/ai/review-profiles', { key: 'x', fields: [] });
    expect(res.status).toBe(400);
  });
});

describe('POST /ai/reviews', () => {
  it.each([
    ['an unresolved (anonymous) principal', { allowed: false, capabilities: [], controlPlaneAdmin: false, code: 'PRINCIPAL_UNRESOLVED' }],
    ['a principal of another site', { allowed: false, capabilities: [], controlPlaneAdmin: false, code: 'PRINCIPAL_SITE_MISMATCH' }],
    ['a member without ai:decide', { allowed: true, capabilities: ['items:read', 'items:write'], controlPlaneAdmin: false }],
  ])('returns 403 for %s before reading content or calling the provider', async (_label, grant) => {
    const app = buildApp();
    await seedProfile(app);
    ctx.grant = grant;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const read = vi.spyOn(fake, 'readItem');

    const res = await call(app, 'POST', '/ai/reviews', { profile: 'spam-check', collection: 'posts', itemId: 'itm_1' });

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(store.runs).toHaveLength(0);
    expect(ctx.audits.at(-1)?.metadata).toMatchObject({ outcome: 'FORBIDDEN', status: 403 });
    expect((await call(app, 'GET', '/ai/review-profiles')).status).toBe(403);
  });

  it('reviews an item and records provenance', async () => {
    const app = buildApp();
    await seedProfile(app);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jevOk()));

    const res = await call(app, 'POST', '/ai/reviews', { profile: 'spam-check', collection: 'posts', itemId: 'itm_1' });

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      status: 'success',
      provider: 'typesafe',
      model: 'jev-1.13',
      calibrated: true,
      profileVersion: 1,
      revisionId: 'rev_1',
      answers: { spam: { type: 'noul', noul: 0.8 } },
      stale: false,
    });
    expect(ctx.audits.at(-1)).toMatchObject({ event: 'ai_decision', metadata: { outcome: 'OK' } });
  });

  it.each([
    ['a field outside the profile', { title: 'x', status: 'published' }],
    ['a field the caller may not write', { title: 'x', body: 'y' }],
  ])('returns 422 for a snapshot with %s, before the provider', async (_label, snapshot) => {
    const app = buildApp();
    await seedProfile(app);
    fake.writable.delete('body');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await call(app, 'POST', '/ai/reviews', { profile: 'spam-check', collection: 'posts', snapshot });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe('REVIEW_FIELD_NOT_ALLOWED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 403 DECISION_DISABLED while the site has not opted in', async () => {
    const app = buildApp();
    await seedProfile(app);
    ctx.settings = { enabled: false, allowedStateFields: null };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await call(app, 'POST', '/ai/reviews', { profile: 'spam-check', collection: 'posts', itemId: 'itm_1' });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe('DECISION_DISABLED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 429 with Retry-After once the site quota is used', async () => {
    const app = buildApp();
    await seedProfile(app);
    ctx.settings = { enabled: true, allowedStateFields: null, requestsPerHour: 0 };
    vi.stubGlobal('fetch', vi.fn());

    const res = await call(app, 'POST', '/ai/reviews', { profile: 'spam-check', collection: 'posts', itemId: 'itm_1' });

    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('a retry with the same Idempotency-Key makes one provider call and returns one run', async () => {
    const app = buildApp();
    await seedProfile(app);
    const fetchMock = vi.fn().mockImplementation(async () => jevOk());
    vi.stubGlobal('fetch', fetchMock);
    const body = { profile: 'spam-check', collection: 'posts', itemId: 'itm_1' };
    const headers = { 'idempotency-key': 'client-retry-0001' };

    const first = await call(app, 'POST', '/ai/reviews', body, headers);
    const second = await call(app, 'POST', '/ai/reviews', body, headers);

    expect([first.status, second.status]).toEqual([201, 200]);
    const [a, b] = (await Promise.all([first.json(), second.json()])) as Array<{ data: { id: string } }>;
    expect(b!.data.id).toBe(a!.data.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.runs).toHaveLength(1);
  });
});

describe('runs and feedback', () => {
  async function reviewedApp() {
    const app = buildApp();
    await seedProfile(app);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jevOk()));
    const res = await call(app, 'POST', '/ai/reviews', { profile: 'spam-check', collection: 'posts', itemId: 'itm_1' });
    const { data } = (await res.json()) as { data: { id: string } };
    return { app, runId: data.id };
  }

  it('reports a run stale after the item changes and refuses a silent accept with 409', async () => {
    const { app, runId } = await reviewedApp();
    fake.item.body = 'Edited after review';

    const run = await call(app, 'GET', `/ai/reviews/${runId}`);
    expect(((await run.json()) as { data: unknown }).data).toMatchObject({ stale: true, staleReason: 'content_changed' });

    const accept = await call(app, 'POST', `/ai/reviews/${runId}/feedback`, {
      entries: [{ questionKey: 'spam', verdict: 'accept' }],
    });
    expect(accept.status).toBe(409);
    expect(((await accept.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe('REVIEW_STALE');
    expect(store.feedback).toHaveLength(0);

    const acknowledged = await call(app, 'POST', `/ai/reviews/${runId}/feedback`, {
      entries: [{ questionKey: 'spam', verdict: 'accept' }],
      acknowledgeStale: true,
    });
    expect(acknowledged.status).toBe(201);
  });

  it('a retried feedback submission stores one row', async () => {
    const { app, runId } = await reviewedApp();
    const body = { entries: [{ questionKey: 'spam', verdict: 'edit', editedValue: false }] };

    const first = await call(app, 'POST', `/ai/reviews/${runId}/feedback`, body);
    const second = await call(app, 'POST', `/ai/reviews/${runId}/feedback`, body);

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(store.feedback).toHaveLength(1);
  });

  it('returns 400 for an edit without editedValue', async () => {
    const { app, runId } = await reviewedApp();
    const res = await call(app, 'POST', `/ai/reviews/${runId}/feedback`, { entries: [{ questionKey: 'spam', verdict: 'edit' }] });
    expect(res.status).toBe(400);
  });

  it('lists runs for an item and 404s an item the caller cannot read', async () => {
    const { app } = await reviewedApp();
    const list = await call(app, 'GET', '/ai/reviews?collection=posts&itemId=itm_1');
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);
    expect((await call(app, 'GET', '/ai/reviews?collection=posts&itemId=itm_hidden')).status).toBe(404);
    expect((await call(app, 'GET', '/ai/reviews?collection=posts')).status).toBe(400);
  });

  it('404s a run id of another site', async () => {
    const { app, runId } = await reviewedApp();
    store.runs[0]!.siteId = 'site_other';
    expect((await call(app, 'GET', `/ai/reviews/${runId}`)).status).toBe(404);
  });
});
