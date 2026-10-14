import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { MemoryCacheProvider } from '@lumibase/runtime';
import type { AppEnv, AuthPrincipal } from '../../env';
import type { DecisionReviewRollout, DecisionSiteSettings } from '../../services/decision-governance';
import type { ReviewMetrics } from '../../services/review-metrics';
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

// The metrics loader reads the in-memory store, scoped by site exactly like
// the Drizzle source, so the route's site scoping is what is under test.
vi.mock('../../services/review-metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/review-metrics')>()),
  reviewMetricsSourceFor: () => ({
    async load(siteId: string) {
      const s = ctx.store as MemoryReviewStore;
      const sessions = s.sessions.filter((row) => row.siteId === siteId);
      const runIds = new Set(sessions.map((row) => row.runId));
      return {
        sessions,
        runs: s.runs.filter((row) => row.siteId === siteId),
        feedback: s.feedback.filter((row) => row.siteId === siteId && runIds.has(row.runId)),
      };
    },
  }),
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

/** The J09 pilot rollout: `posts` in assisted mode unless a test says otherwise. */
function pilot(overrides: Partial<DecisionReviewRollout> = {}): DecisionReviewRollout {
  return { enabled: true, pilotCollections: ['posts'], mode: 'assisted', ...overrides };
}

beforeEach(() => {
  ctx.grant = { allowed: true, capabilities: ['ai:decide'], controlPlaneAdmin: false };
  ctx.settings = { enabled: true, allowedStateFields: null, review: pilot() };
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
    ctx.settings = { enabled: false, allowedStateFields: null, review: pilot() };
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
    ctx.settings = { enabled: true, allowedStateFields: null, requestsPerHour: 0, review: pilot() };
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

describe('pilot rollout (J09)', () => {
  const reviewBody = { profile: 'spam-check', collection: 'posts', itemId: 'itm_1' };

  it.each([
    ['the pilot is off', { review: pilot({ enabled: false }) }],
    ['the collection is not in the pilot', { review: pilot({ pilotCollections: ['pages'] }) }],
    ['the pilot is in baseline mode', { review: pilot({ mode: 'baseline' }) }],
    ['the review setting is absent', { review: undefined }],
  ])('POST /ai/reviews returns 403 DECISION_DISABLED when %s, before content or the provider', async (_label, patch) => {
    const app = buildApp();
    await seedProfile(app);
    ctx.settings = { enabled: true, allowedStateFields: null, ...patch };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const read = vi.spyOn(fake, 'readItem');

    const res = await call(app, 'POST', '/ai/reviews', reviewBody);

    expect(res.status).toBe(403);
    expect(((await res.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe('DECISION_DISABLED');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(store.runs).toHaveLength(0);
    expect(ctx.audits.at(-1)?.metadata).toMatchObject({ outcome: 'DECISION_DISABLED', status: 403 });
  });

  it('reports the rollout mode per collection, and off for a malformed or absent setting', async () => {
    const app = buildApp();
    const mode = async (collection: string) =>
      ((await (await call(app, 'GET', `/ai/reviews/rollout?collection=${collection}`)).json()) as {
        data: { mode: string };
      }).data.mode;

    expect(await mode('posts')).toBe('assisted');
    expect(await mode('pages')).toBe('off');
    ctx.settings = { enabled: false, allowedStateFields: null, review: pilot({ mode: 'baseline' }) };
    expect(await mode('posts')).toBe('baseline');
    // Assisted sends content to the provider, so it also needs the site opt-in.
    ctx.settings = { enabled: false, allowedStateFields: null, review: pilot() };
    expect(await mode('posts')).toBe('off');
    expect((await call(app, 'GET', '/ai/reviews/rollout')).status).toBe(400);
  });

  it('turning the pilot off blocks new feedback but keeps the run and its feedback readable', async () => {
    const app = buildApp();
    await seedProfile(app);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jevOk()));
    const created = await call(app, 'POST', '/ai/reviews', reviewBody);
    const runId = ((await created.json()) as { data: { id: string } }).data.id;
    await call(app, 'POST', `/ai/reviews/${runId}/feedback`, { entries: [{ questionKey: 'spam', verdict: 'reject' }] });
    expect(store.feedback).toHaveLength(1);

    ctx.settings = { enabled: true, allowedStateFields: null, review: pilot({ enabled: false }) };
    const blocked = await call(app, 'POST', `/ai/reviews/${runId}/feedback`, {
      entries: [{ questionKey: 'spam', verdict: 'accept' }],
    });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe('DECISION_DISABLED');

    expect((await call(app, 'GET', `/ai/reviews/${runId}`)).status).toBe(200);
    expect(((await (await call(app, 'GET', '/ai/reviews?collection=posts&itemId=itm_1')).json()) as { data: unknown[] }).data)
      .toHaveLength(1);
    expect(store.runs).toHaveLength(1);
    expect(store.feedback).toHaveLength(1);
  });
});

describe('POST /ai/reviews/sessions (J09)', () => {
  async function assistedRun(app: Hono<AppEnv>) {
    await seedProfile(app);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jevOk()));
    const res = await call(app, 'POST', '/ai/reviews', { profile: 'spam-check', collection: 'posts', itemId: 'itm_1' });
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  it('records an assisted session with the viewed suggestions, scoped to the site and caller', async () => {
    const app = buildApp();
    const runId = await assistedRun(app);

    const res = await call(app, 'POST', '/ai/reviews/sessions', {
      collection: 'posts',
      itemId: 'itm_1',
      mode: 'assisted',
      runId,
      viewedQuestions: ['spam'],
      durationMs: 42_000,
      locale: 'vi',
    });

    expect(res.status).toBe(201);
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]).toMatchObject({
      siteId: 'site_1',
      principalType: 'user',
      principalId: 'usr_editor',
      mode: 'assisted',
      runId,
      viewedQuestions: ['spam'],
      durationMs: 42_000,
      locale: 'vi',
    });
  });

  it('records a baseline session without a run while the site has not opted in to decisions', async () => {
    ctx.settings = { enabled: false, allowedStateFields: null, review: pilot({ mode: 'baseline' }) };
    const res = await call(buildApp(), 'POST', '/ai/reviews/sessions', {
      collection: 'posts',
      itemId: 'itm_1',
      mode: 'baseline',
      durationMs: 90_000,
    });
    expect(res.status).toBe(201);
    expect(store.sessions[0]).toMatchObject({ mode: 'baseline', runId: null, viewedQuestions: [] });
  });

  it.each([
    ['an unresolved principal', { allowed: false, capabilities: [], controlPlaneAdmin: false, code: 'PRINCIPAL_UNRESOLVED' }],
    ['a principal of another site', { allowed: false, capabilities: [], controlPlaneAdmin: false, code: 'PRINCIPAL_SITE_MISMATCH' }],
    ['a member without ai:decide', { allowed: true, capabilities: ['items:read'], controlPlaneAdmin: false }],
  ])('returns 403 for %s and stores nothing', async (_label, grant) => {
    ctx.grant = grant;
    const res = await call(buildApp(), 'POST', '/ai/reviews/sessions', {
      collection: 'posts',
      mode: 'assisted',
      durationMs: 1_000,
    });
    expect(res.status).toBe(403);
    expect(store.sessions).toHaveLength(0);
  });

  it('returns 403 DECISION_DISABLED outside the pilot and 409 on a mode mismatch', async () => {
    const app = buildApp();
    const offPilot = await call(app, 'POST', '/ai/reviews/sessions', { collection: 'pages', mode: 'assisted', durationMs: 1 });
    expect(offPilot.status).toBe(403);
    expect(((await offPilot.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe('DECISION_DISABLED');

    const mismatch = await call(app, 'POST', '/ai/reviews/sessions', { collection: 'posts', mode: 'baseline', durationMs: 1 });
    expect(mismatch.status).toBe(409);
    expect(((await mismatch.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe('REVIEW_SESSION_MODE_MISMATCH');
    expect(store.sessions).toHaveLength(0);
  });

  it('refuses a run of another site, another caller, another item or an unanswered question with 422', async () => {
    const app = buildApp();
    const runId = await assistedRun(app);
    const post = (patch: Record<string, unknown>) =>
      call(app, 'POST', '/ai/reviews/sessions', {
        collection: 'posts',
        itemId: 'itm_1',
        mode: 'assisted',
        runId,
        viewedQuestions: ['spam'],
        durationMs: 1_000,
        ...patch,
      });

    expect((await post({ viewedQuestions: ['tone'] })).status).toBe(422);
    expect((await post({ itemId: 'itm_2' })).status).toBe(422);

    store.runs[0]!.principalId = 'usr_other';
    expect((await post({})).status).toBe(422);
    store.runs[0]!.principalId = 'usr_editor';

    store.runs[0]!.siteId = 'site_other';
    const foreign = await post({});
    expect(foreign.status).toBe(422);
    expect(((await foreign.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe('REVIEW_SESSION_RUN_INVALID');
    expect(store.sessions).toHaveLength(0);
  });

  it('returns 400 for a baseline session that names a run, or an unknown field', async () => {
    ctx.settings = { enabled: true, allowedStateFields: null, review: pilot({ mode: 'baseline' }) };
    const app = buildApp();
    expect(
      (await call(app, 'POST', '/ai/reviews/sessions', { collection: 'posts', mode: 'baseline', runId: 'r1', durationMs: 1 }))
        .status,
    ).toBe(400);
    expect(
      (await call(app, 'POST', '/ai/reviews/sessions', { collection: 'posts', mode: 'baseline', durationMs: 1, body: 'x' }))
        .status,
    ).toBe(400);
  });
});

describe('GET /ai/reviews/metrics (J09)', () => {
  it('is admin only', async () => {
    const res = await call(buildApp(), 'GET', '/ai/reviews/metrics');
    expect(res.status).toBe(403);
  });

  it('aggregates only this site, over viewed suggestions, and flags the small sample', async () => {
    const app = buildApp();
    await seedProfile(app);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jevOk()));
    const res = await call(app, 'POST', '/ai/reviews', { profile: 'spam-check', collection: 'posts', itemId: 'itm_1' });
    const runId = ((await res.json()) as { data: { id: string } }).data.id;
    await call(app, 'POST', `/ai/reviews/${runId}/feedback`, { entries: [{ questionKey: 'spam', verdict: 'accept' }] });
    await call(app, 'POST', '/ai/reviews/sessions', {
      collection: 'posts', itemId: 'itm_1', mode: 'assisted', runId, viewedQuestions: ['spam'], durationMs: 30_000,
    });
    // Another site's session must not be counted.
    store.sessions.push({ ...store.sessions[0]!, id: 'other', siteId: 'site_other', durationMs: 1 });

    ctx.grant = { allowed: true, capabilities: ['admin'], controlPlaneAdmin: true };
    const metrics = await call(app, 'GET', '/ai/reviews/metrics?from=2025-12-01T00:00:00Z&to=2026-06-01T00:00:00Z');

    expect(metrics.status).toBe(200);
    const { data } = (await metrics.json()) as { data: ReviewMetrics };
    expect(data.sampleCounts).toMatchObject({ assistedSessions: 1, baselineSessions: 0, viewedSuggestions: 1 });
    expect(data.suggestions.accept).toMatchObject({ k: 1, n: 1 });
    expect(data.timePerItem.assisted.p50Ms).toBe(30_000);
    expect(data.insufficientSample).toBe(true);
    expect(data.criteria.every((c) => c.status === 'insufficient_sample')).toBe(true);
  });

  it('rejects an invalid or oversized window', async () => {
    ctx.grant = { allowed: true, capabilities: ['admin'], controlPlaneAdmin: true };
    const app = buildApp();
    expect((await call(app, 'GET', '/ai/reviews/metrics?from=nope')).status).toBe(400);
    expect((await call(app, 'GET', '/ai/reviews/metrics?from=2026-02-01&to=2026-01-01')).status).toBe(400);
    expect((await call(app, 'GET', '/ai/reviews/metrics?from=2020-01-01&to=2026-01-01')).status).toBe(400);
  });
});
