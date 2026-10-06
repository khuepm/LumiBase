import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, AuthPrincipal } from '../../env';
import { aiRouter, decisionRequestSchema } from '../ai';

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

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', principal);
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

function post(body: unknown, env: Record<string, string> = {}) {
  return buildApp().request(
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
    ['oversized state', { state: { blob: 'x'.repeat(200_001) }, questions: validBody.questions }],
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
});
