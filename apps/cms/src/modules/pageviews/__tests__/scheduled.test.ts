import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { CloudflareCacheProvider, type RuntimeContext } from '@lumibase/runtime';
import type { Database } from '@lumibase/database';
import { CounterStore, handleCounterRequest, type CounterSql } from '../../../pageviews/counter-store';
import { DecisionGovernanceError, DecisionQuotaLedger } from '../../../services/decision-governance';
import { runScheduledPageviewFlush } from '../scheduled';

/**
 * #511: the 5-minute pageview flush drains each site's PageviewCounter DO with
 * `prefix=pv`. The same DO holds the decision quota (`dq:`) and the API rate
 * limiter (`rl:`), so the flush must roll up `pv:`/`pvu:` and leave the quota
 * untouched — otherwise every tick would hand each site a fresh decision
 * budget. Everything below the flush is real: CloudflareCacheProvider, one
 * CounterStore on SQLite per DO name, and DecisionQuotaLedger. Only the
 * rollup sink and the site list are faked.
 *
 * Negative check: setting `PAGEVIEW_DRAIN_PREFIX` to `''` in
 * packages/runtime/src/adapters/cloudflare/cache.ts makes the quota
 * assertion below fail (the drain empties `dq:` too).
 */
const addToDaily = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('../rollup', () => ({ addToDaily }));

/** Adapts Node's SQLite to the `ctx.storage.sql.exec` cursor surface. */
function sqlite(db = new DatabaseSync(':memory:')): CounterSql {
  return {
    exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...(bindings as SQLInputValue[])) as T[];
      return { one: () => rows[0] as T, toArray: () => rows };
    },
  };
}

const NOW = Date.UTC(2026, 9, 12, 8, 30);
const DAY = '2026-10-12';
const quota = { requestsPerHour: 1, maxConcurrent: 4, budgetPerDay: 1_000_000 };

function cloudflareCache() {
  const stores = new Map<string, CounterStore>();
  const storeFor = (name: string) => {
    let store = stores.get(name);
    if (!store) {
      store = new CounterStore(sqlite(), () => NOW);
      stores.set(name, store);
    }
    return store;
  };
  const fetches: Array<{ doName: string; url: string }> = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: (input: string, init?: RequestInit) => {
        fetches.push({ doName: String(id), url: input });
        return handleCounterRequest(storeFor(String(id)), new Request(input, init));
      },
    }),
  };
  const kv = { get: async () => null, put: async () => undefined, delete: async () => undefined };
  return { cache: new CloudflareCacheProvider(kv as never, namespace), fetches };
}

function fakeDb(siteIds: string[]): Database {
  return {
    execute: async () => ({ rowCount: 0 }),
    select: () => ({ from: async () => siteIds.map((id) => ({ id })) }),
  } as unknown as Database;
}

async function quotaCode(ledger: DecisionQuotaLedger): Promise<string> {
  try {
    await ledger.reserve(10);
    return 'OK';
  } catch (error) {
    return (error as DecisionGovernanceError).code;
  }
}

describe('scheduled pageview flush vs decision quota (#511)', () => {
  it('rolls up pv/pvu, keeps the decision quota, isolates sites and drains once per site', async () => {
    const { cache, fetches } = cloudflareCache();

    for (let i = 0; i < 3; i += 1) await cache.increment(`pv:site_1:${DAY}:/a`, 1);
    await cache.addUnique(`pvu:site_1:${DAY}:/a`, 'v1');
    await cache.addUnique(`pvu:site_1:${DAY}:/a`, 'v2');
    await cache.increment('rl:site_1:user:u1', 1, { ttl: 60 });

    const site1 = new DecisionQuotaLedger(cache, 'site_1', quota, 60_000, () => NOW);
    const site2 = new DecisionQuotaLedger(cache, 'site_2', quota, 60_000, () => NOW);
    expect(await quotaCode(site1)).toBe('OK');
    expect(await quotaCode(site1)).toBe('DECISION_QUOTA_EXCEEDED');

    fetches.length = 0;
    const silent = { log: () => {}, error: () => {} };
    const result = await runScheduledPageviewFlush(fakeDb(['site_1', 'site_2']), { cache } as unknown as RuntimeContext, silent);

    expect(result.countersDrained).toBe(2);
    expect(addToDaily).toHaveBeenCalledWith(expect.anything(), 'site_1', DAY, '/a', 3, 0);
    expect(addToDaily).toHaveBeenCalledWith(expect.anything(), 'site_1', DAY, '/a', 0, 2);
    expect(addToDaily).toHaveBeenCalledTimes(2);

    // Exactly one drain subrequest per site (read before the quota checks add fetches).
    const drains = fetches.filter(({ url }) => url.includes('/drain'));
    const drainCount = fetches.length;

    // The drain did not hand site_1 a fresh hourly quota…
    expect(await quotaCode(site1)).toBe('DECISION_QUOTA_EXCEEDED');
    // …and site_1's exhausted quota never affected site_2.
    expect(await quotaCode(site2)).toBe('OK');
    expect(await quotaCode(site2)).toBe('DECISION_QUOTA_EXCEEDED');

    // The rate-limit window survives too (it expires by TTL, not by drain).
    expect(await cache.increment('rl:site_1:user:u1', 0, { ttl: 60 })).toBe(1);

    expect(drainCount).toBe(2);
    expect(drains.map(({ doName }) => doName).sort()).toEqual(['site_1', 'site_2']);
    expect(drains.every(({ url }) => new URL(url).searchParams.get('prefix') === 'pv')).toBe(true);
  });
});
