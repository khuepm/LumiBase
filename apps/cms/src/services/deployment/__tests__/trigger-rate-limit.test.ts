import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@lumibase/database';
import type { KeyProvider, RateLimiterProvider } from '@lumibase/runtime';
import { MemoryRateLimiter } from '@lumibase/runtime';
import { DeploymentError, DeploymentService } from '../deployment-service';
import { registerProvider, type DeploymentProvider } from '../providers';
import { encryptToken } from '../token-vault';
import {
  DEFAULT_DEPLOY_TRIGGER_RATE_LIMIT,
  deployTriggerKey,
  type DeployTriggerRateLimit,
} from '../trigger-rate-limit';

/**
 * Hard per-target deploy-trigger rate limit (deployment-integrations task 6.2).
 *
 * **Validates: Requirements 9.5**
 */

const PROVIDER_KEY = 'stub-rate-limit';

/** Always-succeeding adapter so the only thing under test is the brake. */
const stubProvider: DeploymentProvider = {
  key: PROVIDER_KEY,
  verifyToken: async () => ({ ok: true }),
  trigger: async () => ({ providerDeploymentId: 'pd_1', status: 'queued' as const }),
  getStatus: async () => ({ providerDeploymentId: 'pd_1', status: 'ready' as const }),
  getLogs: async () => '',
  verifyWebhook: async () => false,
  parseWebhook: () => null,
};
registerProvider(stubProvider);

/** Deterministic 32-byte KEK — real AES-GCM, no crypto mocking. */
const RAW_KEY = Buffer.alloc(32, 7).toString('base64');
const keys: KeyProvider = {
  getActiveKey: async () => ({ keyId: 'v0', key: RAW_KEY }),
  getKey: async () => RAW_KEY,
} as unknown as KeyProvider;

const TEST_LIMIT: DeployTriggerRateLimit = {
  burstMax: 2,
  burstWindowSeconds: 60,
  sustainedMax: 3,
  sustainedWindowSeconds: 3600,
};

async function targetRow(siteId: string, targetId: string) {
  const enc = await encryptToken(keys, 'provider-token', siteId);
  return {
    id: targetId,
    siteId,
    provider: PROVIDER_KEY,
    name: 'site',
    projectId: 'prj_1',
    tokenCiphertext: enc.ciphertext,
    tokenKeyId: enc.keyId,
    defaultBranch: 'main',
    productionUrl: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Minimal db: every select resolves the given target row; inserts captured. */
function makeDb(target: Record<string, unknown>) {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    select() {
      const b: Record<string, unknown> = {
        from: () => b,
        where: () => b,
        orderBy: () => b,
        limit: () => Promise.resolve([target]),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve([target]).then(res, rej),
      };
      return b;
    },
    insert() {
      return {
        values(v: Record<string, unknown>) {
          inserted.push(v);
          return { returning: () => Promise.resolve([{ id: `dep_${inserted.length}`, ...v }]) };
        },
      };
    },
  };
  return { db: db as unknown as Database, inserted };
}

/** Deployment inserts only — the audit logger writes through the same fake db. */
function deployRows(inserted: Record<string, unknown>[]): Record<string, unknown>[] {
  return inserted.filter((v) => 'triggerSource' in v);
}

let limiter: RateLimiterProvider;

beforeEach(() => {
  // Fresh budget store per test; one instance shared by every service below so
  // the limit is genuinely distributed-equivalent across callers.
  limiter = new MemoryRateLimiter(new Map());
});

async function serviceFor(siteId: string, targetId: string) {
  const { db, inserted } = makeDb(await targetRow(siteId, targetId));
  const service = new DeploymentService({
    db,
    siteId,
    keys,
    rateLimiter: limiter,
    triggerRateLimit: TEST_LIMIT,
  });
  return { service, inserted };
}

describe('deploy trigger rate limit (Req 9.5)', () => {
  it('allows triggers up to the burst budget', async () => {
    const { service, inserted } = await serviceFor('s1', 'tgt_1');
    for (let i = 0; i < TEST_LIMIT.burstMax; i += 1) {
      const row = await service.trigger('tgt_1', { source: 'manual' });
      expect(row.status).toBe('queued');
    }
    expect(deployRows(inserted)).toHaveLength(TEST_LIMIT.burstMax);
  });

  it('rejects with RATE_LIMITED past the budget and creates no deployment row', async () => {
    const { service, inserted } = await serviceFor('s1', 'tgt_1');
    for (let i = 0; i < TEST_LIMIT.burstMax; i += 1) {
      await service.trigger('tgt_1', { source: 'manual' });
    }

    const err = await service.trigger('tgt_1', { source: 'manual' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeploymentError);
    expect((err as DeploymentError).code).toBe('RATE_LIMITED');
    expect((err as DeploymentError).retryAfterSeconds).toBeGreaterThan(0);
    // A rejected trigger must not leave a row behind.
    expect(deployRows(inserted)).toHaveLength(TEST_LIMIT.burstMax);
  });

  it('applies to agent and flow triggers too', async () => {
    const { service } = await serviceFor('s1', 'tgt_1');
    await service.trigger('tgt_1', { source: 'agent' });
    await service.trigger('tgt_1', { source: 'auto' });
    await expect(service.trigger('tgt_1', { source: 'agent' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('keeps budgets isolated between two targets of the same site', async () => {
    const one = await serviceFor('s1', 'tgt_1');
    for (let i = 0; i < TEST_LIMIT.burstMax; i += 1) {
      await one.service.trigger('tgt_1', { source: 'manual' });
    }
    await expect(one.service.trigger('tgt_1', { source: 'manual' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });

    // Second target still has its own full budget.
    const two = await serviceFor('s1', 'tgt_2');
    const row = await two.service.trigger('tgt_2', { source: 'manual' });
    expect(row.status).toBe('queued');
  });

  it('keeps budgets isolated between two sites using the same target id', async () => {
    const a = await serviceFor('s1', 'tgt_1');
    for (let i = 0; i < TEST_LIMIT.burstMax; i += 1) {
      await a.service.trigger('tgt_1', { source: 'manual' });
    }
    await expect(a.service.trigger('tgt_1', { source: 'manual' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });

    // Site B is untouched — no cross-tenant budget bleed.
    const b = await serviceFor('s2', 'tgt_1');
    const row = await b.service.trigger('tgt_1', { source: 'manual' });
    expect(row.status).toBe('queued');
    expect(deployRows(b.inserted)).toHaveLength(1);
  });

  it('caps sustained abuse after the burst window rolls over', async () => {
    // Advance past each burst window so only the hourly tier can bite.
    let now = Date.now();
    limiter = new MemoryRateLimiter(new Map(), () => now);
    const { service } = await serviceFor('s1', 'tgt_1');

    for (let i = 0; i < TEST_LIMIT.sustainedMax; i += 1) {
      await service.trigger('tgt_1', { source: 'manual' });
      now += (TEST_LIMIT.burstWindowSeconds + 1) * 1000;
    }
    await expect(service.trigger('tgt_1', { source: 'manual' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('fails open when the limiter is unavailable', async () => {
    limiter = {
      consume: async () => {
        throw new Error('limiter down');
      },
    } as unknown as RateLimiterProvider;
    const { service } = await serviceFor('s1', 'tgt_1');
    // Far past any budget — a limiter outage must not block deploys.
    for (let i = 0; i < TEST_LIMIT.sustainedMax + 3; i += 1) {
      await service.trigger('tgt_1', { source: 'manual' });
    }
  });

  it('scopes budget keys by site and target', () => {
    expect(deployTriggerKey('burst', 's1', 'tgt_1')).toBe('rl:deploy:burst:s1:tgt_1');
    expect(deployTriggerKey('hour', 's1', 'tgt_1')).not.toBe(deployTriggerKey('hour', 's2', 'tgt_1'));
    expect(DEFAULT_DEPLOY_TRIGGER_RATE_LIMIT.burstMax).toBeGreaterThan(0);
  });
});
