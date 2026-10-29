import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { MemoryCacheProvider } from '@lumibase/runtime';
import type { AppEnv, AuthPrincipal } from '../../env';
import {
  FRONTEND_SESSION_DECISION_MESSAGE,
  PUBLISHABLE_KEY_DECISION_MESSAGE,
  type DecisionReviewRollout,
  type DecisionSiteSettings,
} from '../../services/decision-governance';
import {
  EffectiveCapabilityService,
  type EffectiveCapabilityResolution,
} from '../../services/effective-capability-service';
import type { ReviewContentAccess } from '../../services/review-service';
import { MemoryReviewStore } from '../../__tests__/helpers/memory-review-store';
import { aiRouter } from '../ai';
import { aiReviewRouter } from '../ai-review';

/**
 * #562 / B144: publishable API keys and `frontend`-audience sessions never
 * reach the paid decision provider, even when a role or policy grants
 * `ai:decide` (or admin access).
 *
 * Unlike `ai-decisions.test.ts`, `resolveRequestCapabilities` is NOT mocked:
 * only the DB read underneath it (`EffectiveCapabilityService.resolve`) is,
 * and it always answers with a grant of class `standard`. So the refusal in
 * cases a–c can only come from the auth principal the middleware set, through
 * the real resolver into `authorizeDecision`. Case e flips that around: the
 * DB-derived class alone refuses.
 */
const ctx = vi.hoisted(() => ({
  settings: { enabled: true, allowedStateFields: null } as DecisionSiteSettings,
  audits: [] as Array<{ event: string; metadata?: Record<string, unknown> }>,
  store: null as unknown,
  content: null as unknown,
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

const pilot: DecisionReviewRollout = { enabled: true, pilotCollections: ['posts'], mode: 'assisted' };

function content(): ReviewContentAccess {
  const item: Record<string, unknown> = { title: 'Summer sale', body: 'Buy now!!!' };
  return {
    async readItem(_collection, _itemId, fields) {
      const values: Record<string, unknown> = {};
      for (const field of fields) if (item[field] !== undefined) values[field] = item[field];
      return { values, omittedFields: [] };
    },
    async deniedSnapshotFields() {
      return [];
    },
    async latestRevisionId() {
      return 'rev_1';
    },
  };
}

// Principals exactly as `withAuth` sets them (middleware/auth.ts).
const publishableKey: AuthPrincipal = {
  type: 'api_key',
  apiKeyId: 'key_pub',
  apiKey: { id: 'key_pub', prefix: 'lbk_pub_abcd1234' },
  roles: [],
  raw: { apiKey: { id: 'key_pub', prefix: 'lbk_pub_abcd1234' } },
};
const frontendSession: AuthPrincipal = {
  userId: 'usr_sub',
  isFrontendUser: true,
  roles: ['role_x'],
  raw: { aud: 'frontend', siteId: 'site_1' },
};
const secretKey: AuthPrincipal = {
  type: 'api_key',
  apiKeyId: 'key_sec',
  apiKey: { id: 'key_sec', prefix: 'lbk_abcdefgh1234' },
  roles: [],
  raw: { apiKey: { id: 'key_sec', prefix: 'lbk_abcdefgh1234' } },
};
const studioUser: AuthPrincipal = {
  userId: 'usr_ed',
  isFrontendUser: false,
  roles: ['role_ed'],
  raw: { aud: 'studio' },
};
/** A key whose middleware snapshot has no prefix: only the DB row can classify it. */
const bareKey: AuthPrincipal = { type: 'api_key', apiKeyId: 'key_bare', roles: [], raw: {} };

/** What the DB-backed resolver answers for every principal in a test. */
let resolved: { capabilities: string[]; controlPlaneAdmin: boolean; callerClass: 'standard' | 'publishable_api_key' };

let cache: MemoryCacheProvider;
let auth: AuthPrincipal;
let clientIp: string;

beforeEach(() => {
  ctx.settings = { enabled: true, allowedStateFields: null, review: pilot };
  ctx.audits = [];
  ctx.store = new MemoryReviewStore();
  ctx.content = content();
  cache = new MemoryCacheProvider();
  clientIp = '203.0.113.7';
  resolved = { capabilities: ['ai:decide'], controlPlaneAdmin: false, callerClass: 'standard' };
  vi.spyOn(EffectiveCapabilityService.prototype, 'resolve').mockImplementation(
    async (principal) =>
      ({
        allowed: true,
        principal,
        capabilities: resolved.capabilities,
        controlPlaneAdmin: resolved.controlPlaneAdmin,
        callerClass: resolved.callerClass,
        bundle: { admin: false, appAccess: true, tfaRequired: false, byKey: {}, roles: [], policies: [] },
        permissionContext: {
          userId: null,
          siteId: 'site_1',
          roleId: null,
          user: null,
          apiKey: null,
          ip: null,
          headers: {},
          now: new Date(),
        },
      }) as EffectiveCapabilityResolution,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    c.set('siteId', 'site_1');
    c.set('requestId', 'req_1');
    c.set('ip', clientIp);
    c.set('db', {} as AppEnv['Variables']['db']);
    c.set('runtime', { cache } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/ai', aiRouter);
  app.route('/ai', aiReviewRouter);
  return app;
}

const env = { DECISION_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'ts-key' };

function call(app: Hono<AppEnv>, method: string, path: string, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}

const decisionBody = {
  state: { title: 'Summer sale', body: 'Buy now!!!' },
  questions: {
    spam: { type: 'noul', instructions: 'Is this post spam?', criteria: { true: 'spam', false: 'legitimate' } },
  },
};
const reviewBody = { profile: 'spam-check', collection: 'posts', itemId: 'itm_1' };
const profileBody = {
  key: 'spam-check',
  collection: 'posts',
  fields: ['title', 'body'],
  questions: decisionBody.questions,
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

/** Seeds the review profile as a Studio admin, then restores the test's grant. */
async function seedProfile(app: Hono<AppEnv>): Promise<void> {
  const savedAuth = auth;
  const savedGrant = resolved;
  auth = studioUser;
  resolved = { capabilities: ['admin'], controlPlaneAdmin: true, callerClass: 'standard' };
  const res = await call(app, 'POST', '/ai/review-profiles', profileBody);
  expect(res.status).toBe(201);
  auth = savedAuth;
  resolved = savedGrant;
  ctx.audits = [];
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { errors: Array<{ code: string; message: string }> }).errors[0]!;
}

/**
 * No quota was reserved (`dq:`), and the refusal was counted once in its
 * per-window dedup key (`dra:`, #564). Before #564 the refusal touched no
 * counter at all; counting it is what bounds the audit rows.
 */
function expectNoQuotaOneRefusalCounter(increment: { mock: { calls: unknown[][] } }): void {
  const keys = increment.mock.calls.map(([key]) => String(key));
  expect(keys.some((key) => key.startsWith('dq:'))).toBe(false);
  expect(keys.every((key) => key.startsWith('dra:site_1:'))).toBe(true);
  // One increment of this window's key (+1) and one read of the previous window's (+0).
  expect(increment.mock.calls.filter(([, by]) => by === 1)).toHaveLength(1);
}

const refusedCallers = [
  ['a publishable API key', publishableKey, PUBLISHABLE_KEY_DECISION_MESSAGE],
  ['a frontend session', frontendSession, FRONTEND_SESSION_DECISION_MESSAGE],
] as const;
const grants = [
  ['ai:decide', ['ai:decide'], false],
  ['admin', ['admin'], true],
] as const;

describe.each(refusedCallers)('%s', (_label, principal, message) => {
  describe.each(grants)('holding %s', (_grant, capabilities, controlPlaneAdmin) => {
    beforeEach(() => {
      auth = principal;
      resolved = { capabilities: [...capabilities], controlPlaneAdmin, callerClass: 'standard' };
    });

    it('a. POST /ai/decisions → 403 FORBIDDEN, no provider call, no quota, one audit event', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jevOk());
      vi.stubGlobal('fetch', fetchMock);
      const increment = vi.spyOn(cache, 'increment');
      const res = await call(buildApp(), 'POST', '/ai/decisions', decisionBody);
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toEqual({ code: 'FORBIDDEN', message });
      expect(fetchMock).not.toHaveBeenCalled();
      expectNoQuotaOneRefusalCounter(increment);
      expect(ctx.audits).toHaveLength(1);
      expect(ctx.audits[0]).toMatchObject({ event: 'ai_decision', metadata: { outcome: 'FORBIDDEN', status: 403 } });
    });

    it('b. refuses before the body is read (malformed body → 403, not 400)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const res = await call(buildApp(), 'POST', '/ai/decisions', { state: 'x' });
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe('FORBIDDEN');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('c. POST /ai/reviews → 403, no content read, no provider, no quota; profile reads add no audit', async () => {
      const app = buildApp();
      await seedProfile(app);
      const fetchMock = vi.fn().mockResolvedValue(jevOk());
      vi.stubGlobal('fetch', fetchMock);
      const increment = vi.spyOn(cache, 'increment');
      const read = vi.spyOn(ctx.content as ReviewContentAccess, 'readItem');

      const res = await call(app, 'POST', '/ai/reviews', reviewBody);
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toEqual({ code: 'FORBIDDEN', message });
      expect(fetchMock).not.toHaveBeenCalled();
      expectNoQuotaOneRefusalCounter(increment);
      expect(read).not.toHaveBeenCalled();
      expect((ctx.store as MemoryReviewStore).runs).toHaveLength(0);
      expect(ctx.audits).toHaveLength(1);
      expect(ctx.audits[0]?.metadata).toMatchObject({ outcome: 'FORBIDDEN', status: 403 });

      // Every other `ai:decide` route refuses too, and writes no audit (same as today).
      ctx.audits = [];
      const profiles = await call(app, 'GET', '/ai/review-profiles');
      expect(profiles.status).toBe(403);
      expect((await errorOf(profiles)).code).toBe('FORBIDDEN');
      expect((await call(app, 'GET', '/ai/reviews?collection=posts&itemId=itm_1')).status).toBe(403);
      expect(ctx.audits).toHaveLength(0);
    });
  });
});

describe.each([
  ['a secret API key', secretKey],
  ['a Studio user', studioUser],
] as const)('d. %s with the grant still decides', (_label, principal) => {
  beforeEach(() => {
    auth = principal;
  });

  it('POST /ai/decisions → 200, one provider call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jevOk());
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(buildApp(), 'POST', '/ai/decisions', decisionBody);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('POST /ai/reviews → 201, one provider call', async () => {
    const app = buildApp();
    await seedProfile(app);
    const fetchMock = vi.fn().mockResolvedValue(jevOk());
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(app, 'POST', '/ai/reviews', reviewBody);
    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('e. the DB-derived class alone refuses', () => {
  it('a key whose stored prefix is publishable is refused although the middleware snapshot has no prefix', async () => {
    auth = bareKey;
    resolved = { capabilities: ['ai:decide'], controlPlaneAdmin: false, callerClass: 'publishable_api_key' };
    const fetchMock = vi.fn().mockResolvedValue(jevOk());
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(buildApp(), 'POST', '/ai/decisions', decisionBody);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toEqual({ code: 'FORBIDDEN', message: PUBLISHABLE_KEY_DECISION_MESSAGE });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('f–i. refused requests are audited in aggregate (#564, B147)', () => {
  const HEX16 = /^[0-9a-f]{16}$/;

  it('f. 20 publishable-key POST /ai/decisions → 20 × 403 but 2 audit rows (count 1 and 10), no raw IP', async () => {
    auth = publishableKey;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jevOk()));
    const app = buildApp();
    for (let i = 0; i < 20; i++) {
      expect((await call(app, 'POST', '/ai/decisions', decisionBody)).status).toBe(403);
    }
    expect(ctx.audits).toHaveLength(2);
    expect(ctx.audits.map((a) => (a.metadata?.refusal as { count: number }).count)).toEqual([1, 10]);
    for (const audit of ctx.audits) {
      expect(audit.metadata).toMatchObject({
        outcome: 'FORBIDDEN',
        principal: { type: 'api_key', id: 'key_pub' },
        refusal: { reason: 'publishable_api_key' },
      });
      expect(audit.metadata?.clientIpHash).toMatch(HEX16);
    }
    expect(JSON.stringify(ctx.audits)).not.toContain('203.0.113.7');
  });

  it('g. 12 frontend-session POST /ai/reviews → 2 audit rows with reason frontend_session', async () => {
    auth = frontendSession;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jevOk()));
    const app = buildApp();
    await seedProfile(app);
    for (let i = 0; i < 12; i++) expect((await call(app, 'POST', '/ai/reviews', reviewBody)).status).toBe(403);
    expect(ctx.audits).toHaveLength(2);
    expect(ctx.audits.map((a) => (a.metadata?.refusal as { reason: string }).reason)).toEqual([
      'frontend_session',
      'frontend_session',
    ]);
  });

  it('h. after a flood, a granted secret key still decides and writes exactly one OK row', async () => {
    auth = publishableKey;
    const fetchMock = vi.fn().mockResolvedValue(jevOk());
    vi.stubGlobal('fetch', fetchMock);
    const app = buildApp();
    for (let i = 0; i < 15; i++) await call(app, 'POST', '/ai/decisions', decisionBody);
    ctx.audits = [];
    auth = secretKey;
    const res = await call(app, 'POST', '/ai/decisions', decisionBody);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.audits).toHaveLength(1);
    expect(ctx.audits[0]?.metadata).toMatchObject({ outcome: 'OK', status: 200 });
    expect(ctx.audits[0]?.metadata?.refusal).toBeUndefined();
  });

  it('i. a key rotating its IP on every request is still bounded (keyed by principal)', async () => {
    auth = publishableKey;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jevOk()));
    const app = buildApp();
    for (let i = 0; i < 20; i++) {
      clientIp = `198.51.100.${i + 1}`;
      await call(app, 'POST', '/ai/decisions', decisionBody);
    }
    expect(ctx.audits).toHaveLength(2);
  });
});
