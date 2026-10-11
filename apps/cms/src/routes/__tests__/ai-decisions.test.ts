import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { MemoryCacheProvider } from '@lumibase/runtime';
import type { AppEnv, AuthPrincipal } from '../../env';
import type { DecisionSiteSettings } from '../../services/decision-governance';
import { aiRouter, decisionRequestSchema } from '../ai';

/**
 * The governance inputs (#511) are the DB-backed parts: the capability grant,
 * the site's `aiDecisions` setting and the audit sink. Everything after them
 * (gates, quota ledger, provider, HTTP mapping) runs for real.
 */
const gov = vi.hoisted(() => ({
  grant: { allowed: true, capabilities: ['ai:decide'] as string[], controlPlaneAdmin: false } as {
    allowed: boolean;
    capabilities: string[];
    controlPlaneAdmin: boolean;
    code?: string;
  },
  settings: { enabled: true, allowedStateFields: null } as DecisionSiteSettings,
  audits: [] as Array<{ event: string; requestId?: string | null; metadata?: Record<string, unknown> }>,
}));

vi.mock('../../services/governed-capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/governed-capabilities')>()),
  resolveRequestCapabilities: vi.fn(async () => gov.grant),
}));

vi.mock('../../services/decision-governance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/decision-governance')>()),
  readDecisionSettings: vi.fn(async () => gov.settings),
}));

vi.mock('../../modules/audit/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/audit/logger')>()),
  AuditLogger: class {
    async write(entry: (typeof gov.audits)[number]) {
      gov.audits.push(entry);
    }
  },
}));

beforeEach(() => {
  gov.grant = { allowed: true, capabilities: ['ai:decide'], controlPlaneAdmin: false };
  gov.settings = { enabled: true, allowedStateFields: null };
  gov.audits = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const principal: AuthPrincipal = {
  userId: 'usr_editor',
  email: 'editor@example.com',
  roles: ['member'],
  raw: {},
};

function buildApp(cache = new MemoryCacheProvider()): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', principal);
    c.set('siteId', 'site_1');
    c.set('requestId', 'req_1');
    c.set('db', {} as AppEnv['Variables']['db']);
    c.set('runtime', { cache } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/ai', aiRouter);
  return app;
}

const validBody = {
  state: { title: 'Summer sale', body: 'Buy now!!!' },
  questions: {
    spam: {
      type: 'noul',
      instructions: 'Is this post spam?',
      criteria: { true: 'spam', false: 'legitimate' },
    },
  },
};

function post(body: unknown, env: Record<string, string> = {}, app = buildApp()) {
  return app.request(
    '/ai/decisions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

const typesafeEnv = { DECISION_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'ts-key' };

describe('decisionRequestSchema', () => {
  it('accepts noul, choice and score questions', () => {
    const result = decisionRequestSchema.safeParse({
      state: 'plain text state',
      questions: {
        spam: validBody.questions.spam,
        topic: { type: 'choice', instructions: 'Topic?', criteria: { promo: null, news: 'News' } },
        quality: { type: 'score', instructions: 'Quality?', criteria: ['poor', 'ok'] },
      },
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['no questions', { state: 'x', questions: {} }],
    ['bad question key', { state: 'x', questions: { 'has space': validBody.questions.spam } }],
    [
      'single-option choice',
      { state: 'x', questions: { q: { type: 'choice', instructions: 'i', criteria: { a: null } } } },
    ],
    [
      'one-level score',
      { state: 'x', questions: { q: { type: 'score', instructions: 'i', criteria: ['only'] } } },
    ],
    [
      'eleven-level score',
      {
        state: 'x',
        questions: { q: { type: 'score', instructions: 'i', criteria: Array.from({ length: 11 }, String) } },
      },
    ],
    ['unknown type', { state: 'x', questions: { q: { type: 'free', instructions: 'i', criteria: [] } } }],
  ])('rejects %s', (_label, body) => {
    expect(decisionRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('POST /ai/decisions', () => {
  it('returns 400 with VALIDATION errors for a malformed body', async () => {
    const res = await post({ state: 'x' }, typesafeEnv);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { errors: { code: string }[] };
    expect(json.errors[0]?.code).toBe('VALIDATION');
  });

  it('returns 503 DECISION_NOT_CONFIGURED when no provider is set', async () => {
    const res = await post(validBody);
    expect(res.status).toBe(503);
    const json = (await res.json()) as { errors: { code: string }[] };
    expect(json.errors[0]?.code).toBe('DECISION_NOT_CONFIGURED');
  });

  it('returns the typed answers from Jev', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: 'jev-1.13',
            answers: { spam: { type: 'noul', noul: 0.97 } },
            usage: { input_tokens: 42, output_tokens: 0 },
          }),
          { status: 200 },
        ),
      ),
    );

    const res = await post(validBody, typesafeEnv);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      data: {
        provider: 'typesafe',
        model: 'jev-1.13',
        calibrated: true,
        answers: { spam: { type: 'noul', noul: 0.97 } },
        usage: { inputTokens: 42, outputTokens: 0 },
      },
    });
  });

  it('hides the upstream auth failure behind a 502', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid key ts-key', { status: 401 })));

    const res = await post(validBody, typesafeEnv);

    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('DECISION_AUTH');
    expect(text).not.toContain('ts-key');
  });

  it('surfaces upstream validation failures as 422', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad body', { status: 422 })));

    const res = await post(validBody, typesafeEnv);
    expect(res.status).toBe(422);
  });

  it.each([{}, null, { type: 'noul', noul: '0' }, { type: 'noul', noul: 1.1 }])(
    'returns 502 for malformed upstream answers (%j)', async (answer) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: { spam: answer } }))));
      const res = await post(validBody, typesafeEnv);
      expect(res.status).toBe(502);
      const json = await res.json() as { data?: unknown; errors: { code: string }[] };
      expect(json.data).toBeUndefined();
      expect(json.errors[0]?.code).toBe('DECISION_PARSE_FAILED');
    },
  );
});

describe('POST /ai/decisions — budgets and deadlines (#509)', () => {
  function hangingFetch() {
    return vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    );
  }

  it('returns 413 for Vietnamese input over the token budget without calling the provider', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await post(
      { ...validBody, state: 'Bài viết tiếng Việt có dấu đầy đủ. '.repeat(400) },
      { ...typesafeEnv, DECISION_MAX_INPUT_TOKENS: '2000' },
    );

    expect(res.status).toBe(413);
    const json = (await res.json()) as { errors: { code: string; message: string }[] };
    expect(json.errors[0]?.code).toBe('DECISION_INPUT_TOO_LARGE');
    expect(json.errors[0]?.message).toContain('limit is 2000');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 413 for a large object state over the byte cap without calling the provider', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const state = { blocks: Array.from({ length: 3_000 }, (_, i) => ({ id: i, text: 'x'.repeat(50) })) };

    const res = await post({ ...validBody, state }, typesafeEnv);

    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 504 DECISION_TIMEOUT when the provider never answers within the deadline', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal('fetch', hangingFetch());

      const pending = post(validBody, { ...typesafeEnv, DECISION_TIMEOUT_MS: '2000', DECISION_MAX_RETRIES: '0' });
      await vi.runAllTimersAsync();
      const res = await pending;

      expect(res.status).toBe(504);
      const json = (await res.json()) as { errors: { code: string }[] };
      expect(json.errors[0]?.code).toBe('DECISION_TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns 503 DECISION_UNAVAILABLE when the provider is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await post(validBody, { ...typesafeEnv, DECISION_MAX_RETRIES: '0' });

    expect(res.status).toBe(503);
    const json = (await res.json()) as { errors: { code: string }[] };
    expect(json.errors[0]?.code).toBe('DECISION_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts the upstream call when the client request is cancelled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const pending = buildApp().request(
      '/ai/decisions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validBody),
        signal: controller.signal,
      },
      typesafeEnv,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    const res = await pending;

    expect(res.status).toBe(499);
    const upstreamSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /ai/decisions — governance (#511)', () => {
  const jevOk = () =>
    new Response(
      JSON.stringify({
        model: 'jev-1.13',
        answers: { spam: { type: 'noul', noul: 0.2 } },
        usage: { input_tokens: 40, output_tokens: 3 },
      }),
      { status: 200 },
    );

  function expectNoProviderCall(fetchMock: ReturnType<typeof vi.fn>) {
    expect(fetchMock).not.toHaveBeenCalled();
  }

  it.each([
    ['an unresolved (anonymous) principal', { allowed: false, capabilities: [], controlPlaneAdmin: false, code: 'PRINCIPAL_UNRESOLVED' }],
    ['a principal of another site', { allowed: false, capabilities: [], controlPlaneAdmin: false, code: 'PRINCIPAL_SITE_MISMATCH' }],
    ['a member without ai:decide', { allowed: true, capabilities: ['items:read', 'items:write'], controlPlaneAdmin: false }],
  ])('returns 403 for %s before validating or calling the provider', async (_label, grant) => {
    gov.grant = grant;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await post({ not: 'even valid' }, typesafeEnv);

    expect(res.status).toBe(403);
    const json = (await res.json()) as { errors: { code: string; message: string }[] };
    expect(json.errors[0]).toEqual({ code: 'FORBIDDEN', message: 'The ai:decide capability is required.' });
    expectNoProviderCall(fetchMock);
    expect(gov.audits).toHaveLength(1);
    expect(gov.audits[0]?.metadata).toMatchObject({ outcome: 'FORBIDDEN', status: 403 });
  });

  it('lets an admin grant through without an explicit ai:decide', async () => {
    gov.grant = { allowed: true, capabilities: ['admin'], controlPlaneAdmin: true };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jevOk()));

    const res = await post(validBody, typesafeEnv);

    expect(res.status).toBe(200);
  });

  it('returns 403 DECISION_DISABLED until the site opts in, without calling the provider', async () => {
    gov.settings = { enabled: false, allowedStateFields: null };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await post(validBody, typesafeEnv);

    expect(res.status).toBe(403);
    const json = (await res.json()) as { errors: { code: string }[] };
    expect(json.errors[0]?.code).toBe('DECISION_DISABLED');
    expectNoProviderCall(fetchMock);
  });

  it('acts as a kill switch: turning the setting off stops the next request', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jevOk());
    vi.stubGlobal('fetch', fetchMock);
    const app = buildApp();

    expect((await post(validBody, typesafeEnv, app)).status).toBe(200);
    gov.settings = { enabled: false, allowedStateFields: null };
    expect((await post(validBody, typesafeEnv, app)).status).toBe(403);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns 422 DECISION_FIELD_NOT_ALLOWED for state fields outside the allowlist', async () => {
    gov.settings = { enabled: true, allowedStateFields: ['title'] };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await post(validBody, typesafeEnv);

    expect(res.status).toBe(422);
    const json = (await res.json()) as { errors: { code: string; message: string }[] };
    expect(json.errors[0]?.code).toBe('DECISION_FIELD_NOT_ALLOWED');
    expect(json.errors[0]?.message).toContain('body');
    expectNoProviderCall(fetchMock);
  });

  it('returns 429 with Retry-After once the hourly quota is used, without calling the provider', async () => {
    gov.settings = { enabled: true, allowedStateFields: null, requestsPerHour: 2 };
    const fetchMock = vi.fn().mockImplementation(async () => jevOk());
    vi.stubGlobal('fetch', fetchMock);
    const app = buildApp();

    expect((await post(validBody, typesafeEnv, app)).status).toBe(200);
    expect((await post(validBody, typesafeEnv, app)).status).toBe(200);
    const res = await post(validBody, typesafeEnv, app);

    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const json = (await res.json()) as { errors: { code: string }[] };
    expect(json.errors[0]?.code).toBe('DECISION_QUOTA_EXCEEDED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never lets concurrent requests past the hourly quota', async () => {
    gov.settings = { enabled: true, allowedStateFields: null, requestsPerHour: 3 };
    const fetchMock = vi.fn().mockImplementation(async () => jevOk());
    vi.stubGlobal('fetch', fetchMock);
    const app = buildApp();

    const statuses = await Promise.all(Array.from({ length: 12 }, async () => (await post(validBody, typesafeEnv, app)).status));

    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(9);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns 503 DECISION_QUOTA_UNAVAILABLE when the counter backend is down (fail closed)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = new MemoryCacheProvider();
    vi.spyOn(cache, 'increment').mockRejectedValue(new Error('counter down'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await post(validBody, typesafeEnv, buildApp(cache));

    expect(res.status).toBe(503);
    const json = (await res.json()) as { errors: { code: string }[] };
    expect(json.errors[0]?.code).toBe('DECISION_QUOTA_UNAVAILABLE');
    expectNoProviderCall(fetchMock);
  });

  it('audits who, what and how much — never the content, email or IP', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jevOk()));

    const res = await post(validBody, typesafeEnv);
    expect(res.status).toBe(200);

    expect(gov.audits).toHaveLength(1);
    const entry = gov.audits[0]!;
    expect(entry.event).toBe('ai_decision');
    expect(entry.requestId).toBe('req_1');
    expect(entry.metadata).toMatchObject({
      outcome: 'OK',
      status: 200,
      principal: { type: 'user', id: 'usr_editor' },
      provider: 'typesafe',
      model: 'jev-1.13',
      questions: { noul: 1 },
      usage: { inputTokens: 40, outputTokens: 3 },
      attempts: 1,
      chargedTokens: 43,
    });
    expect(entry.metadata?.rubricVersion).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(typeof entry.metadata?.latencyMs).toBe('number');

    const serialized = JSON.stringify(entry);
    for (const secret of ['Summer sale', 'Buy now', 'Is this post spam', 'legitimate', 'editor@example.com', 'ts-key']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('audits a provider failure with the attempts it cost', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const res = await post(validBody, { ...typesafeEnv, DECISION_MAX_RETRIES: '0' });

    expect(res.status).toBe(503);
    expect(gov.audits[0]?.metadata).toMatchObject({ outcome: 'DECISION_UNAVAILABLE', status: 503, attempts: 1 });
    expect(gov.audits[0]?.metadata?.chargedTokens).toBeGreaterThan(0);
  });
});
