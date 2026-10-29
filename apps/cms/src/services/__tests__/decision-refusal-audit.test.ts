import { MemoryCacheProvider, type CacheProvider } from '@lumibase/runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiDecisionRefusalsTotal } from '../../routes/metrics';
import {
  DECISION_REFUSAL_REASONS,
  writeDecisionAudit,
  type DecisionAuditContext,
  type DecisionAuditRecord,
} from '../decision-governance';
import {
  DECISION_REFUSAL_KEY_PREFIX,
  decisionRefusalWindowSeconds,
  isRefusalCheckpoint,
  recordDecisionRefusal,
  refusalDedupKey,
  type DecisionRefusalStore,
} from '../decision-refusal-audit';
import type { AuthenticatedPrincipalRef } from '../effective-capability-service';

/**
 * #564 / B147: authorization refusals of AI decisions are aggregated per
 * (site, subject, reason, window) instead of one audit row per request, and
 * every refusal is still counted in `lumibase_ai_decision_refusals_total`.
 */
const ctx = vi.hoisted(() => ({
  audits: [] as Array<{ event: string; ip?: string | null; metadata?: Record<string, unknown> }>,
}));

vi.mock('../../modules/audit/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/audit/logger')>()),
  AuditLogger: class {
    constructor(readonly opts: { siteId: string }) {}
    async write(entry: (typeof ctx.audits)[number]) {
      ctx.audits.push({ ...entry, metadata: { ...entry.metadata, siteId: this.opts.siteId } });
    }
  },
}));

const IP = '203.0.113.7';
const W = 300;
const T0 = 1_800_000_000_000; // a fixed instant, aligned below to a window start
const WINDOW_START = Math.floor(T0 / (W * 1000)) * W * 1000;

let cache: MemoryCacheProvider;
let now: number;

beforeEach(() => {
  ctx.audits = [];
  cache = new MemoryCacheProvider();
  now = WINDOW_START + 1_000;
  aiDecisionRefusalsTotal.reset();
});

function store(overrides: Partial<DecisionRefusalStore> = {}): DecisionRefusalStore {
  return { cache, clientIp: IP, hashSecret: 'test-secret', windowSeconds: W, now: () => now, ...overrides };
}

function context(
  overrides: { siteId?: string; principal?: AuthenticatedPrincipalRef | null; refusal?: DecisionRefusalStore | undefined } = {},
): DecisionAuditContext {
  return {
    db: {} as DecisionAuditContext['db'],
    siteId: overrides.siteId ?? 'site_1',
    requestId: 'req_1',
    principal: overrides.principal === undefined ? null : overrides.principal,
    refusal: 'refusal' in overrides ? overrides.refusal : store(),
  };
}

const refusal = (reason: DecisionAuditRecord['refusalReason'] = 'publishable_api_key'): DecisionAuditRecord => ({
  outcome: 'FORBIDDEN',
  status: 403,
  startedAt: Date.now(),
  refusalReason: reason,
});

async function refuse(times: number, audit = context(), reason?: DecisionAuditRecord['refusalReason']): Promise<void> {
  for (let i = 0; i < times; i++) await writeDecisionAudit(audit, refusal(reason));
}

async function metric(labels: Partial<Record<'reason' | 'principal' | 'audit', string>> = {}): Promise<number> {
  const { values } = await aiDecisionRefusalsTotal.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, val]) => (v.labels as Record<string, unknown>)[k] === val))
    .reduce((sum, v) => sum + v.value, 0);
}

const refusalOf = (i: number) => ctx.audits[i]?.metadata?.refusal as Record<string, unknown> | undefined;

describe('helpers', () => {
  it('checkpoints are 10, 100, 1000, …', () => {
    expect([1, 2, 9, 10, 11, 20, 99, 100, 1000, 10_000].filter(isRefusalCheckpoint)).toEqual([10, 100, 1000, 10_000]);
  });

  it('keys start with a non-pageview prefix and keep siteId in colon-segment 2', () => {
    expect(DECISION_REFUSAL_KEY_PREFIX.startsWith('pv')).toBe(false);
    const key = refusalDedupKey({ siteId: 'site_1', window: 7, kind: 'ip', subjectHash: 'a'.repeat(16), reason: 'other' });
    expect(key.split(':')[0]).toBe('dra');
    expect(key.split(':')[1]).toBe('site_1');
  });

  it('reads the window from env with a default of 300 and 0 allowed', () => {
    expect(decisionRefusalWindowSeconds({})).toBe(300);
    expect(decisionRefusalWindowSeconds({ DECISION_REFUSAL_AUDIT_WINDOW_SECONDS: '0' })).toBe(0);
    expect(decisionRefusalWindowSeconds({ DECISION_REFUSAL_AUDIT_WINDOW_SECONDS: '60' })).toBe(60);
    expect(decisionRefusalWindowSeconds({ DECISION_REFUSAL_AUDIT_WINDOW_SECONDS: 'nope' })).toBe(300);
  });

  it('the reason list used for keys matches the exported one', async () => {
    // An unknown reason is mapped to `other`; every known one is kept as-is.
    for (const reason of DECISION_REFUSAL_REASONS) {
      ctx.audits = [];
      await writeDecisionAudit(context({ refusal: undefined }), refusal(reason));
      expect(refusalOf(0)?.reason).toBe(reason);
    }
    ctx.audits = [];
    await writeDecisionAudit(context({ refusal: undefined }), refusal('made_up' as never));
    expect(refusalOf(0)?.reason).toBe('other');
  });
});

describe('R1 flood from one IP (no principal)', () => {
  it('25 refusals write 2 rows (first + the 10th), not 25; the metric counts all 25', async () => {
    await refuse(25);
    expect(ctx.audits).toHaveLength(2);
    expect(refusalOf(0)).toMatchObject({ count: 1, dedup: 'first', reason: 'publishable_api_key', windowSeconds: W });
    expect(refusalOf(0)?.windowStart).toBe(new Date(WINDOW_START).toISOString());
    expect(refusalOf(1)).toMatchObject({ count: 10, dedup: 'checkpoint' });
    expect(await metric()).toBe(25);
    expect(await metric({ audit: 'written' })).toBe(2);
    expect(await metric({ audit: 'suppressed' })).toBe(23);
    expect(await metric({ principal: 'anonymous', reason: 'publishable_api_key' })).toBe(25);
  });

  it('9 refusals write exactly 1 row', async () => {
    await refuse(9);
    expect(ctx.audits).toHaveLength(1);
  });

  it('the first row of the next window carries the exact count of the previous one', async () => {
    const increment = vi.spyOn(cache, 'increment');
    await refuse(25);
    now += W * 1000;
    await refuse(1);
    expect(ctx.audits).toHaveLength(3);
    expect(refusalOf(2)).toMatchObject({ count: 1, dedup: 'first', previousWindowCount: 25 });
    for (const [, , opts] of increment.mock.calls) expect(opts).toEqual({ ttl: 2 * W + 60 });
  });

  it('with no refusal in the next window nothing more is written; the last count is a lower bound', async () => {
    await refuse(15);
    now += W * 1000;
    expect(ctx.audits).toHaveLength(2);
    expect(refusalOf(1)?.count).toBe(10);
    expect(await metric()).toBe(15);
  });
});

describe('R2 isolation', () => {
  it('a different IP, reason or site gets its own first row', async () => {
    await refuse(5);
    await refuse(1, context({ refusal: store({ clientIp: '198.51.100.9' }) }));
    await refuse(1, context(), 'capability_missing');
    await refuse(1, context({ siteId: 'site_2' }));
    expect(ctx.audits.map((a) => (a.metadata?.refusal as { dedup: string }).dedup)).toEqual([
      'first',
      'first',
      'first',
      'first',
    ]);
    expect(ctx.audits.map((a) => a.metadata?.siteId)).toEqual(['site_1', 'site_1', 'site_1', 'site_2']);
  });

  it("a flood on site A does not suppress site B's first row, and every key is site-prefixed", async () => {
    const increment = vi.spyOn(cache, 'increment');
    await refuse(30, context({ siteId: 'site_a' }));
    await refuse(1, context({ siteId: 'site_b' }));
    const siteB = ctx.audits.filter((a) => a.metadata?.siteId === 'site_b');
    expect(siteB).toHaveLength(1);
    expect(siteB[0]?.metadata?.refusal).toMatchObject({ count: 1, dedup: 'first' });
    for (const [key] of increment.mock.calls) {
      expect(['site_a', 'site_b']).toContain(String(key).split(':')[1]);
    }
  });
});

describe('R3 authenticated refusals are deduped per principal', () => {
  const user: AuthenticatedPrincipalRef = { type: 'user', siteId: 'site_1', userId: 'usr_1' };

  it('the same user from two IPs is one subject', async () => {
    await refuse(1, context({ principal: user }));
    await refuse(1, context({ principal: user, refusal: store({ clientIp: '198.51.100.9' }) }));
    expect(ctx.audits).toHaveLength(1);
    expect(ctx.audits[0]?.metadata?.principal).toEqual({ type: 'user', id: 'usr_1' });
    expect(await metric({ principal: 'user' })).toBe(2);
  });

  it('two users are two subjects; a key and a user with the same id string are two subjects', async () => {
    await refuse(1, context({ principal: user }));
    await refuse(1, context({ principal: { type: 'user', siteId: 'site_1', userId: 'usr_2' } }));
    await refuse(1, context({ principal: { type: 'api_key', siteId: 'site_1', apiKeyId: 'usr_1' } }));
    expect(ctx.audits).toHaveLength(3);
    expect(ctx.audits[2]?.metadata?.principal).toEqual({ type: 'api_key', id: 'usr_1' });
  });
});

describe('R4 a broken or missing counter never drops evidence', () => {
  it('increment rejecting writes every refusal (unbounded)', async () => {
    vi.spyOn(cache, 'increment').mockRejectedValue(new Error('counter down'));
    await refuse(3);
    expect(ctx.audits).toHaveLength(3);
    expect(refusalOf(0)).toMatchObject({ dedup: 'unbounded', count: 1, windowStart: null });
    expect(await metric({ audit: 'unbounded' })).toBe(3);
  });

  it.each([undefined, Number.NaN, 0, -1, 1.5, '2'])('increment answering %s writes the row (B142)', async (value) => {
    vi.spyOn(cache, 'increment').mockResolvedValue(value as never);
    await refuse(2);
    expect(ctx.audits).toHaveLength(2);
    expect(refusalOf(1)?.dedup).toBe('unbounded');
  });

  it('no cache, no store, or a window of 0 writes every refusal', async () => {
    await refuse(2, context({ refusal: store({ cache: undefined }) }));
    await refuse(2, context({ refusal: undefined }));
    await refuse(2, context({ refusal: store({ windowSeconds: 0 }) }));
    expect(ctx.audits).toHaveLength(6);
    expect(ctx.audits.every((a) => (a.metadata?.refusal as { dedup: string }).dedup === 'unbounded')).toBe(true);
  });

  it('a failing previous-window read still writes the row, without the carry-over', async () => {
    const real = cache.increment.bind(cache);
    vi.spyOn(cache, 'increment').mockImplementation(async (key: string, by?: number, opts?: { ttl?: number }) => {
      if (by === 0) throw new Error('read failed');
      return real(key, by, opts);
    });
    await refuse(1);
    expect(ctx.audits).toHaveLength(1);
    expect(refusalOf(0)).toMatchObject({ dedup: 'first', count: 1 });
    expect(refusalOf(0)).not.toHaveProperty('previousWindowCount');
  });
});

describe('R5 privacy', () => {
  it('no key and no row contains the raw IP; rows carry a 16-hex hash and no ip column', async () => {
    const increment = vi.spyOn(cache, 'increment');
    await refuse(12);
    await refuse(1, context({ principal: { type: 'api_key', siteId: 'site_1', apiKeyId: 'key_pub' } }));
    for (const [key] of increment.mock.calls) expect(String(key)).not.toContain(IP);
    expect(JSON.stringify(ctx.audits)).not.toContain(IP);
    for (const audit of ctx.audits) {
      expect(audit.metadata?.clientIpHash).toMatch(/^[0-9a-f]{16}$/);
      expect(audit.ip ?? null).toBeNull();
    }
  });

  it("an unresolved IP ('unknown') is not hashed", async () => {
    await refuse(1, context({ refusal: store({ clientIp: 'unknown' }) }));
    expect(ctx.audits[0]?.metadata?.clientIpHash).toBeNull();
  });
});

describe('R6 other outcomes keep one row per call', () => {
  it.each(['OK', 'VALIDATION', 'DECISION_QUOTA_EXCEEDED', 'DECISION_DISABLED'] as const)(
    '%s writes one row per call and never touches a dra: key',
    async (outcome) => {
      const increment = vi.spyOn(cache, 'increment');
      for (let i = 0; i < 3; i++) {
        await writeDecisionAudit(context(), { outcome, status: outcome === 'OK' ? 200 : 403, startedAt: Date.now() });
      }
      expect(ctx.audits).toHaveLength(3);
      expect(ctx.audits.every((a) => a.metadata?.refusal === undefined)).toBe(true);
      expect(increment).not.toHaveBeenCalled();
      expect(await metric()).toBe(0);
    },
  );
});

describe('R7 never throws', () => {
  it('a failing row writer does not reject', async () => {
    const writer = vi.fn().mockRejectedValue(new Error('db down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordDecisionRefusal(context(), refusal(), writer)).resolves.toBeUndefined();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('a cache whose increment is missing entirely falls back to writing', async () => {
    const broken = {} as CacheProvider;
    await refuse(2, context({ refusal: store({ cache: broken }) }));
    expect(ctx.audits).toHaveLength(2);
  });
});
