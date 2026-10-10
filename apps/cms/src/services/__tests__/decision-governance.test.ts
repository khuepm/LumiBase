import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheProvider, type CacheProvider } from '@lumibase/runtime';
import {
  authorizeDecision,
  decisionQuotaFromEnv,
  decisionRubricVersion,
  DecisionGovernanceError,
  DecisionGovernanceService,
  DEFAULT_DECISION_QUOTA,
  disallowedStateFields,
  effectiveDecisionQuota,
  estimateDecisionOutputTokens,
  parseDecisionSettings,
  type DecisionQuota,
  type DecisionSiteSettings,
} from '../decision-governance';
import {
  DEFAULT_DECISION_LIMITS,
  DecisionProviderError,
  measureDecisionInput,
  type ConfiguredDecisionProvider,
  type DecisionCallOptions,
  type DecisionRequest,
  type DecisionResponse,
} from '../decision-provider';
import { capabilitiesFromPermissionBundle } from '../effective-capability-service';
import type { PermissionBundle } from '../permission-service';

const request: DecisionRequest = {
  state: { title: 'Summer sale', body: 'Buy now!!!' },
  questions: {
    spam: { type: 'noul', instructions: 'Is this post spam?', criteria: { true: 'spam', false: 'legitimate' } },
  },
};

const answer = (usage: DecisionResponse['usage']): DecisionResponse => ({
  provider: 'typesafe',
  model: 'jev-1.13',
  calibrated: true,
  answers: { spam: { type: 'noul', noul: 0.2 } },
  usage,
});

const enabled: DecisionSiteSettings = { enabled: true, allowedStateFields: null };
const inputTokens = measureDecisionInput(request).estimatedTokens;
const perAttempt = inputTokens + estimateDecisionOutputTokens(request);

function configured(
  decide: (req: DecisionRequest, options?: DecisionCallOptions) => Promise<DecisionResponse>,
  maxRetries = 2,
): ConfiguredDecisionProvider {
  return {
    name: 'typesafe',
    model: 'jev-latest',
    limits: { ...DEFAULT_DECISION_LIMITS, maxRetries },
    provider: { decide: vi.fn(decide) },
  };
}

function service(
  provider: ConfiguredDecisionProvider | null,
  options: { cache?: CacheProvider; settings?: DecisionSiteSettings; quota?: Partial<DecisionQuota> } = {},
) {
  const cache = options.cache ?? new MemoryCacheProvider();
  return {
    cache,
    svc: new DecisionGovernanceService({
      configured: provider,
      settings: options.settings ?? enabled,
      quota: { ...DEFAULT_DECISION_QUOTA, ...options.quota },
      cache,
      siteId: 'site_1',
      now: () => Date.UTC(2026, 9, 10, 8, 30),
    }),
  };
}

/** Atomic like INCRBY, but yields before answering so concurrent callers interleave. */
function yieldingCounter(): CacheProvider {
  const values = new Map<string, number>();
  const cache = new MemoryCacheProvider();
  cache.increment = async (key: string, by = 1) => {
    const next = (values.get(key) ?? 0) + by;
    values.set(key, next);
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
    return next;
  };
  cache.get = async <T>(key: string) => (values.get(key) ?? null) as T | null;
  return cache;
}

const tokensKey = 'dq:site_1:tok:' + Math.floor(Date.UTC(2026, 9, 10, 8, 30) / 86_400_000);
const requestsKey = 'dq:site_1:req:' + Math.floor(Date.UTC(2026, 9, 10, 8, 30) / 3_600_000);

async function counter(cache: CacheProvider, key: string): Promise<number> {
  return Number((await cache.get<number | string>(key)) ?? 0);
}

describe('site settings', () => {
  it('defaults to disabled and reads malformed values as disabled', () => {
    expect(parseDecisionSettings({})).toEqual({ enabled: false, allowedStateFields: null });
    expect(parseDecisionSettings({ enabled: 'yes' }).enabled).toBe(false);
    expect(parseDecisionSettings({ enabled: true, requestsPerHour: -1 }).enabled).toBe(false);
    expect(parseDecisionSettings(null).enabled).toBe(false);
  });

  it('keeps the opt-in, allowlist and tighter limits', () => {
    expect(
      parseDecisionSettings({ enabled: true, allowedStateFields: ['title'], requestsPerHour: 10, budgetPerDay: 500 }),
    ).toEqual({ enabled: true, allowedStateFields: ['title'], requestsPerHour: 10, budgetPerDay: 500 });
  });

  it('lets a site tighten but never raise the platform ceiling', () => {
    const quota = effectiveDecisionQuota(DEFAULT_DECISION_QUOTA, {
      enabled: true,
      allowedStateFields: null,
      requestsPerHour: 10,
      maxConcurrent: 1_000,
    });
    expect(quota).toEqual({ requestsPerHour: 10, maxConcurrent: 4, budgetPerDay: 2_000_000 });
  });

  it('reads platform ceilings from the environment', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      decisionQuotaFromEnv({
        DECISION_SITE_REQUESTS_PER_HOUR: '50',
        DECISION_SITE_MAX_CONCURRENT: '0',
        DECISION_SITE_TOKENS_PER_DAY: '9000',
      }),
    ).toEqual({ requestsPerHour: 50, maxConcurrent: 4, budgetPerDay: 9000 });
  });

  it('checks top-level state fields against the allowlist', () => {
    expect(disallowedStateFields({ title: 'x' }, null)).toBeNull();
    expect(disallowedStateFields({ title: 'x' }, ['title'])).toBeNull();
    expect(disallowedStateFields({ title: 'x', email: 'a@b' }, ['title'])).toEqual(['email']);
    expect(disallowedStateFields('plain text', ['title'])).toEqual([]);
  });
});

describe('authorizeDecision', () => {
  it.each([
    [{ allowed: false, capabilities: ['ai:decide'] }],
    [{ allowed: true, capabilities: [] }],
    [{ allowed: true, capabilities: ['items:write', 'schema:read'] }],
  ])('denies %j', (grant) => {
    expect(() => authorizeDecision(grant)).toThrow(DecisionGovernanceError);
  });

  it.each([[['ai:decide']], [['admin']], [['*']]])('allows %j', (capabilities) => {
    expect(() => authorizeDecision({ allowed: true, capabilities })).not.toThrow();
  });
});

describe('ai:decide capability mapping', () => {
  const bundle = (collection: string, action: string): PermissionBundle => ({
    admin: false,
    appAccess: true,
    tfaRequired: false,
    roles: [],
    policies: [],
    byKey: {
      [`${collection}::${action}`]: { collection, action, rule: null, fields: ['*'] } as never,
    },
  });

  it('grants ai:decide from create on the reserved collection, and nothing else', () => {
    expect(capabilitiesFromPermissionBundle(bundle('lumibase_ai_decisions', 'create'))).toEqual(['ai:decide']);
  });

  it('does not grant it from other actions or ordinary collections', () => {
    expect(capabilitiesFromPermissionBundle(bundle('lumibase_ai_decisions', 'read'))).toEqual([]);
    expect(capabilitiesFromPermissionBundle(bundle('posts', 'create'))).not.toContain('ai:decide');
  });
});

describe('DecisionGovernanceService gates', () => {
  it('reports DECISION_NOT_CONFIGURED without touching counters', async () => {
    const { svc, cache } = service(null);
    const result = await svc.decide(request);
    expect(result.ok).toBe(false);
    expect(!result.ok && (result.error as DecisionGovernanceError).code).toBe('DECISION_NOT_CONFIGURED');
    expect(await counter(cache, requestsKey)).toBe(0);
  });

  it.each([
    ['disabled site', { enabled: false, allowedStateFields: null }, 'DECISION_DISABLED'],
    ['field outside the allowlist', { enabled: true, allowedStateFields: ['title'] }, 'DECISION_FIELD_NOT_ALLOWED'],
  ] satisfies Array<[string, DecisionSiteSettings, string]>)('rejects a %s before reserving or calling the provider', async (_label, settings, code) => {
    const provider = configured(async () => answer({ inputTokens: 1, outputTokens: 1 }));
    const { svc, cache } = service(provider, { settings });
    const result = await svc.decide(request);
    expect(!result.ok && (result.error as DecisionGovernanceError).code).toBe(code);
    expect(provider.provider.decide).not.toHaveBeenCalled();
    expect(await counter(cache, requestsKey)).toBe(0);
  });

  it('rejects input over the budget before reserving', async () => {
    const provider = configured(async () => answer({ inputTokens: 1, outputTokens: 1 }));
    provider.limits = { ...provider.limits, maxInputTokens: 5 };
    const { svc, cache } = service(provider);
    const result = await svc.decide(request);
    expect(!result.ok && (result.error as DecisionProviderError).code).toBe('DECISION_INPUT_TOO_LARGE');
    expect(provider.provider.decide).not.toHaveBeenCalled();
    expect(await counter(cache, tokensKey)).toBe(0);
  });

  it('rejects when the worst-case reservation exceeds the daily budget', async () => {
    const provider = configured(async () => answer({ inputTokens: 1, outputTokens: 1 }), 2);
    const { svc, cache } = service(provider, { quota: { budgetPerDay: perAttempt * 3 - 1 } });
    const result = await svc.decide(request);
    expect(!result.ok && (result.error as DecisionGovernanceError).code).toBe('DECISION_QUOTA_EXCEEDED');
    expect(provider.provider.decide).not.toHaveBeenCalled();
    expect(await counter(cache, tokensKey)).toBe(0);
    expect(await counter(cache, requestsKey)).toBe(0);
  });
});

describe('DecisionGovernanceService accounting', () => {
  it('charges reported usage and refunds the rest of the reservation', async () => {
    const provider = configured(async (_req, options) => {
      options?.onAttempt?.();
      return answer({ inputTokens: 40, outputTokens: 3 });
    });
    const { svc, cache } = service(provider);
    const result = await svc.decide(request);
    expect(result.ok).toBe(true);
    expect(result.accounting).toMatchObject({ attempts: 1, reservedTokens: perAttempt * 3, chargedTokens: 43 });
    expect(await counter(cache, tokensKey)).toBe(43);
    expect(await counter(cache, requestsKey)).toBe(1);
  });

  it('charges unknown usage at the estimate, never as free', async () => {
    const provider = configured(async (_req, options) => {
      options?.onAttempt?.();
      return answer({ inputTokens: null, outputTokens: 3 });
    });
    const { svc, cache } = service(provider);
    const result = await svc.decide(request);
    expect(result.accounting.chargedTokens).toBe(inputTokens + 3);
    expect(await counter(cache, tokensKey)).toBe(inputTokens + 3);
  });

  it('charges every retried attempt before a success', async () => {
    const provider = configured(async (_req, options) => {
      options?.onAttempt?.();
      options?.onAttempt?.();
      return answer({ inputTokens: 40, outputTokens: 3 });
    });
    const { svc } = service(provider);
    const result = await svc.decide(request);
    expect(result.accounting).toMatchObject({ attempts: 2, chargedTokens: perAttempt + 43 });
  });

  it('charges timed-out attempts and keeps the request counted', async () => {
    const provider = configured(async (_req, options) => {
      options?.onAttempt?.();
      options?.onAttempt?.();
      options?.onAttempt?.();
      throw new DecisionProviderError('DECISION_TIMEOUT', 'timed out');
    });
    const { svc, cache } = service(provider);
    const result = await svc.decide(request);
    expect(result.ok).toBe(false);
    expect(result.accounting.chargedTokens).toBe(perAttempt * 3);
    expect(await counter(cache, tokensKey)).toBe(perAttempt * 3);
    expect(await counter(cache, requestsKey)).toBe(1);
  });

  it('releases everything when the provider failed before sending anything', async () => {
    const provider = configured(async () => {
      throw new DecisionProviderError('DECISION_CANCELLED', 'cancelled');
    });
    const { svc, cache } = service(provider);
    const result = await svc.decide(request);
    expect(result.accounting.chargedTokens).toBe(0);
    expect(await counter(cache, tokensKey)).toBe(0);
    expect(await counter(cache, requestsKey)).toBe(0);
  });

  it('fails closed when the counter backend is down', async () => {
    const provider = configured(async () => answer({ inputTokens: 1, outputTokens: 1 }));
    const cache = new MemoryCacheProvider();
    cache.increment = async () => {
      throw new Error('down');
    };
    const { svc } = service(provider, { cache });
    const result = await svc.decide(request);
    expect(!result.ok && (result.error as DecisionGovernanceError).code).toBe('DECISION_QUOTA_UNAVAILABLE');
    expect(provider.provider.decide).not.toHaveBeenCalled();
  });
});

describe('DecisionGovernanceService concurrency', () => {
  it('admits at most maxConcurrent in-flight decisions and frees slots after', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const provider = configured(async (_req, options) => {
      options?.onAttempt?.();
      await gate;
      return answer({ inputTokens: 1, outputTokens: 1 });
    });
    const { svc } = service(provider, { quota: { maxConcurrent: 2 } });

    const pending = Array.from({ length: 6 }, () => svc.decide(request));
    await vi.waitFor(() => expect(provider.provider.decide).toHaveBeenCalledTimes(2));
    finish();
    const results = await Promise.all(pending);

    expect(results.filter((r) => r.ok)).toHaveLength(2);
    const limited = results.filter((r) => !r.ok && (r.error as DecisionGovernanceError).code === 'DECISION_CONCURRENCY_LIMITED');
    expect(limited).toHaveLength(4);
    expect((await svc.decide(request)).ok).toBe(true);
  });

  it('does not overshoot the request quota or the budget under interleaved increments', async () => {
    const provider = configured(async (_req, options) => {
      options?.onAttempt?.();
      return answer({ inputTokens: null, outputTokens: null });
    }, 0);
    const cache = yieldingCounter();
    const { svc } = service(provider, {
      cache,
      quota: { requestsPerHour: 1_000, maxConcurrent: 1_000, budgetPerDay: perAttempt * 7 },
    });

    const results = await Promise.all(Array.from({ length: 25 }, () => svc.decide(request)));

    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(7);
    expect(results.filter((r) => r.ok).length).toBeGreaterThan(0);
    expect(await counter(cache, tokensKey)).toBeLessThanOrEqual(perAttempt * 7);
    expect(provider.provider.decide).toHaveBeenCalledTimes(results.filter((r) => r.ok).length);
  });
});

describe('audit helpers', () => {
  it('fingerprints the rubric without exposing it', async () => {
    const version = await decisionRubricVersion(request);
    expect(version).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(await decisionRubricVersion({ ...request, state: 'different state' })).toBe(version);
    expect(
      await decisionRubricVersion({
        ...request,
        questions: { spam: { ...request.questions.spam!, instructions: 'Changed?' } as never },
      }),
    ).not.toBe(version);
  });
});
