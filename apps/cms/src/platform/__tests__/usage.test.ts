import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { USAGE_KINDS, type UsageEmitter, type UsageEvent } from '@lumibase/contracts/platform';
import type { Database } from '@lumibase/database';
import type { RuntimeContext } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { withUsage } from '../../middleware/usage';
import { createLLMProvider, type LLMProvider } from '../../services/llm-provider';
import { defaultUsageEmitter } from '../defaults';
import { platform, registerPlatformSeams, resetPlatformSeamsForTests } from '../registry';
import { backgroundUsageSource, recordUsage, runWithUsageScope, usageEnabled } from '../usage';

/** Any property access throws: proves a code path never touches the database. */
function throwingDb(): Database {
  return new Proxy({}, {
    get: (_t, key) => {
      throw new Error(`database touched: ${String(key)}`);
    },
  }) as Database;
}

/** A cache that already knows every site's organization, so attribution needs no database. */
function runtimeWithOrg(organizationId: string): RuntimeContext {
  return {
    cache: {
      getEntry: async () => ({ state: 'hit', value: organizationId }),
      get: async () => null,
      set: async () => undefined,
      setNegative: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as RuntimeContext;
}

class RecordingEmitter implements UsageEmitter<RuntimeContext> {
  events: UsageEvent[] = [];
  flushes = 0;
  emit(event: UsageEvent): void {
    this.events.push(event);
  }
  async flush(): Promise<void> {
    this.flushes += 1;
  }
}

function buildApp(options: { runtime?: RuntimeContext; db?: Database; siteId?: string | null } = {}) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('runtime', options.runtime ?? runtimeWithOrg('org_1'));
    c.set('requestId', 'req_1');
    await next();
  });
  app.use('*', withUsage());
  app.use('/api/v1/*', async (c, next) => {
    if (options.siteId !== null) c.set('siteId', options.siteId ?? 'site_1');
    c.set('db', options.db ?? throwingDb());
    await next();
  });
  app.get('/api/v1/items/posts', (c) => c.json({ data: [] }));
  app.post('/api/v1/mail', (c) => {
    recordUsage({ kind: USAGE_KINDS.emailSent, quantity: 3, unit: 'count' });
    return c.json({ data: { ok: true } });
  });
  app.get('/api/v1/deliver/items/:site_id/posts', (c) => c.json({ data: [] }));
  app.get('/health', (c) => c.json({ data: { ok: true } }));
  return app;
}

/** Drains run detached (fire-and-forget on Node): let them settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  resetPlatformSeamsForTests();
  vi.restoreAllMocks();
});

describe('usage emitter seam — nothing registered', () => {
  it('uses the no-op default', async () => {
    expect(usageEnabled()).toBe(false);
    expect(platform().usage).toBe(defaultUsageEmitter);
    expect(defaultUsageEmitter.emit({} as UsageEvent)).toBeUndefined();
    await expect(defaultUsageEmitter.flush({ runtime: {} as RuntimeContext, requestId: null })).resolves.toBeUndefined();
  });

  it('touches neither the database nor the cache, and the response is unchanged', async () => {
    const cache = { getEntry: vi.fn(), get: vi.fn(), set: vi.fn(), setNegative: vi.fn(), delete: vi.fn() };
    const app = buildApp({ runtime: { cache } as unknown as RuntimeContext, db: throwingDb() });
    const res = await app.request('/api/v1/mail', { method: 'POST' });
    await settle();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    for (const fn of Object.values(cache)) expect(fn).not.toHaveBeenCalled();
  });

  it('drops recordUsage outside and inside a scope', async () => {
    recordUsage({ kind: 'x', quantity: 1, unit: 'count' });
    const source = backgroundUsageSource({ runtime: runtimeWithOrg('org_1'), db: throwingDb(), siteId: 's' });
    await expect(runWithUsageScope(source, async () => {
      recordUsage({ kind: 'x', quantity: 1, unit: 'count' });
      return 7;
    })).resolves.toBe(7);
  });
});

describe('usage emitter seam — registered', () => {
  it('receives exactly one request event per request, each with its own uuidv7 id', async () => {
    const emitter = new RecordingEmitter();
    registerPlatformSeams({ usage: emitter });
    const app = buildApp();
    for (let i = 0; i < 5; i++) expect((await app.request('/api/v1/items/posts')).status).toBe(200);
    await settle();

    expect(emitter.events).toHaveLength(5);
    expect(emitter.flushes).toBe(5);
    expect(new Set(emitter.events.map((e) => e.id)).size).toBe(5);
    for (const event of emitter.events) {
      expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(event).toMatchObject({
        kind: USAGE_KINDS.apiRequest,
        tenant: { siteId: 'site_1', organizationId: 'org_1' },
        quantity: 1,
        unit: 'count',
        attributes: { surface: 'rest', method: 'GET', status: '2xx', principal: 'anonymous' },
      });
      expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
    }
  });

  it('reports delivery requests with the site taken from the path', async () => {
    const emitter = new RecordingEmitter();
    registerPlatformSeams({ usage: emitter });
    await buildApp({ siteId: null }).request('/api/v1/deliver/items/site_9/posts');
    await settle();
    expect(emitter.events).toHaveLength(1);
    expect(emitter.events[0]).toMatchObject({
      kind: USAGE_KINDS.deliveryRequest,
      tenant: { siteId: 'site_9', organizationId: 'org_1' },
      attributes: { surface: 'delivery' },
    });
  });

  it('attributes service events recorded during the request to the request site', async () => {
    const emitter = new RecordingEmitter();
    registerPlatformSeams({ usage: emitter });
    await buildApp().request('/api/v1/mail', { method: 'POST' });
    await settle();
    expect(emitter.events.map((e) => e.kind).sort()).toEqual([USAGE_KINDS.apiRequest, USAGE_KINDS.emailSent].sort());
    const mail = emitter.events.find((e) => e.kind === USAGE_KINDS.emailSent)!;
    expect(mail).toMatchObject({ quantity: 3, tenant: { siteId: 'site_1', organizationId: 'org_1' } });
    expect(emitter.flushes).toBe(1);
  });

  it('emits nothing for requests that name no site and no organization', async () => {
    const emitter = new RecordingEmitter();
    registerPlatformSeams({ usage: emitter });
    await buildApp().request('/health');
    await buildApp().request('/api/v1/items/posts', { method: 'OPTIONS' });
    await settle();
    expect(emitter.events).toEqual([]);
  });

  it('never lets a failing emitter affect the response', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    registerPlatformSeams({
      usage: {
        emit: () => { throw new Error('emit broke'); },
        flush: () => Promise.reject(new Error('flush broke')),
      },
    });
    const res = await buildApp().request('/api/v1/items/posts');
    await settle();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(errors).toHaveBeenCalled();
  });

  it('does not hold the response for a slow flush', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    registerPlatformSeams({ usage: { emit: () => undefined, flush: () => gate } });
    const res = await Promise.race([
      buildApp().request('/api/v1/items/posts'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);
    release();
    expect(res).not.toBe('timeout');
  });

  it('background scope: attributes through the site → organization cache and drains before returning', async () => {
    const emitter = new RecordingEmitter();
    registerPlatformSeams({ usage: emitter });
    const source = backgroundUsageSource({ runtime: runtimeWithOrg('org_7'), db: throwingDb(), siteId: 'site_7' });
    await runWithUsageScope(source, async () => {
      recordUsage({ kind: USAGE_KINDS.agentRun, quantity: 1, unit: 'count' });
      recordUsage({ kind: USAGE_KINDS.seatChange, quantity: -1, unit: 'count', siteId: null, organizationId: 'org_x' });
      recordUsage({ kind: 'ignored.zero', quantity: 0, unit: 'count' });
    });
    expect(emitter.flushes).toBe(1);
    expect(emitter.events.map((e) => [e.kind, e.tenant])).toEqual([
      [USAGE_KINDS.agentRun, { siteId: 'site_7', organizationId: 'org_7' }],
      [USAGE_KINDS.seatChange, { siteId: null, organizationId: 'org_x' }],
    ]);
  });

  it('background scope drains even when the job throws', async () => {
    const emitter = new RecordingEmitter();
    registerPlatformSeams({ usage: emitter });
    const source = backgroundUsageSource({ runtime: runtimeWithOrg('org_7'), db: throwingDb(), siteId: 'site_7' });
    await expect(runWithUsageScope(source, async () => {
      recordUsage({ kind: USAGE_KINDS.agentRun, quantity: 1, unit: 'count' });
      throw new Error('job failed');
    })).rejects.toThrow('job failed');
    expect(emitter.events).toHaveLength(1);
  });

  it('reports model tokens per direction from providers that return usage', async () => {
    const emitter = new RecordingEmitter();
    registerPlatformSeams({ usage: emitter });
    const provider = createLLMProvider({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'test', LLM_MODEL: 'gpt-4.1-nano' });
    // Swap the upstream call: the wrapper is what is under test.
    const inner = provider as LLMProvider;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const source = backgroundUsageSource({ runtime: runtimeWithOrg('org_1'), db: throwingDb(), siteId: 'site_1' });
    await runWithUsageScope(source, () => inner.chat([{ role: 'user', content: 'hello' }]));
    expect(emitter.events.map((e) => [e.kind, e.quantity, e.unit, e.attributes])).toEqual([
      [USAGE_KINDS.aiTokens, 12, 'tokens', { provider: 'openai', model: 'gpt-4.1-nano', direction: 'input' }],
      [USAGE_KINDS.aiTokens, 5, 'tokens', { provider: 'openai', model: 'gpt-4.1-nano', direction: 'output' }],
    ]);
  });
});
