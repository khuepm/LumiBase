import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createDb, deploymentTargets, deployments, sites, type Database } from '@lumibase/database';
import { EnvKeyProvider } from '@lumibase/runtime';
import { DeploymentService } from '../deployment-service';
import { sweepPending } from '../status-poller';
import { registerProvider, type DeploymentProvider, type DeploymentRef } from '../providers';
import { encryptToken } from '../token-vault';

/**
 * DB-backed status-poller idempotency (deployment-integrations task 9.3;
 * Req 3.4, 9.4, 7.3). Closes the gap left by the pure-logic tests: the
 * conditional UPDATE in `DeploymentService.applyRef`
 * (`inArray(status, ['queued','building'])`) can only be proven against a real
 * Postgres, because it is the database — not the TypeScript — that decides
 * whether the row is still eligible to flip.
 *
 * Skips (does not fail) when DATABASE_URL is unset or unreachable, matching
 * the convention of the other `*.db.integration.test.ts` files.
 *
 * **Validates: Requirements 3.4, 7.3, 9.4**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE_A = 'site_deploy_poll_a';
const SITE_B = 'site_deploy_poll_b';
const PROVIDER_KEY = 'it-fake-provider';
const KEK = Buffer.alloc(32, 5).toString('base64');
const keys = new EnvKeyProvider(new Map([['v0', KEK]]), 'v0');

/**
 * Scripted provider answers keyed by providerDeploymentId. A queue: each call
 * consumes one entry, the last entry repeats. `throws` forces a failure.
 */
type Reply = { ref: DeploymentRef } | { throws: string };

const replies = new Map<string, Reply[]>();
const statusCalls: string[] = [];

function script(providerDeploymentId: string, ...queue: Reply[]): void {
  replies.set(providerDeploymentId, queue);
}

const fakeProvider: DeploymentProvider = {
  key: PROVIDER_KEY,
  verifyToken: async () => ({ ok: true }),
  trigger: async () => {
    throw new Error('not used in this test');
  },
  getStatus: async (_token, _target, providerDeploymentId) => {
    statusCalls.push(providerDeploymentId);
    const queue = replies.get(providerDeploymentId);
    if (!queue || queue.length === 0) throw new Error(`no scripted reply for ${providerDeploymentId}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    if ('throws' in reply) throw new Error(reply.throws);
    return reply.ref;
  },
  getLogs: async () => 'fake build log',
  verifyWebhook: async () => true,
  parseWebhook: () => null,
};

registerProvider(fakeProvider);

/** Deterministic terminal timestamps so "written exactly once" is assertable. */
const READY_AT = new Date('2026-01-01T00:00:00.000Z');
const OTHER_AT = new Date('2026-02-02T00:00:00.000Z');

const readyRef = (id: string): DeploymentRef => ({
  providerDeploymentId: id,
  status: 'ready',
  url: 'https://example.test/ready',
  completedAt: READY_AT,
});

/** A later, *differing* provider answer — must never overwrite a terminal row. */
const errorRef = (id: string): DeploymentRef => ({
  providerDeploymentId: id,
  status: 'error',
  errorMessage: 'build failed later',
  completedAt: OTHER_AT,
});

describe('Deployment status poller — DB idempotency', () => {
  let db: Database;
  let canConnect = false;
  let targetA = '';
  let targetB = '';

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping deployment poller DB test: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping deployment poller DB test: database not reachable.');
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    for (const site of [SITE_A, SITE_B]) {
      await db.delete(sites).where(eq(sites.id, site)).catch(() => undefined);
    }
  });

  beforeEach(async () => {
    if (!canConnect) return;
    replies.clear();
    statusCalls.length = 0;
    for (const site of [SITE_A, SITE_B]) {
      await db.delete(sites).where(eq(sites.id, site));
    }
    await db.insert(sites).values([
      { id: SITE_A, name: 'Deploy poll A' },
      { id: SITE_B, name: 'Deploy poll B' },
    ]);
    targetA = await seedTarget(SITE_A);
    targetB = await seedTarget(SITE_B);
  });

  async function seedTarget(siteId: string): Promise<string> {
    const enc = await encryptToken(keys, 'provider-token', siteId);
    const [row] = await db
      .insert(deploymentTargets)
      .values({
        siteId,
        provider: PROVIDER_KEY,
        name: 'target',
        projectId: 'prj_it',
        tokenCiphertext: enc.ciphertext,
        tokenKeyId: enc.keyId,
        defaultBranch: 'main',
      })
      .returning({ id: deploymentTargets.id });
    return row!.id;
  }

  async function seedDeployment(
    siteId: string,
    targetId: string,
    providerDeploymentId: string,
    status: 'queued' | 'building' = 'building',
  ): Promise<string> {
    const [row] = await db
      .insert(deployments)
      .values({
        siteId,
        targetId,
        provider: PROVIDER_KEY,
        providerDeploymentId,
        status,
        triggerSource: 'manual',
      })
      .returning({ id: deployments.id });
    return row!.id;
  }

  const rowById = async (id: string) =>
    (await db.select().from(deployments).where(eq(deployments.id, id)))[0]!;

  const service = (siteId: string) => new DeploymentService({ db, siteId, keys });

  it('a repeat sweep is a no-op and completedAt is written exactly once (Req 3.4)', async () => {
    if (!canConnect) return;
    const depId = await seedDeployment(SITE_A, targetA, 'pd_once');
    script('pd_once', { ref: readyRef('pd_once') });

    const first = await sweepPending({ db, keys }, SITE_A);
    expect(first).toEqual({ checked: 1, errors: 0 });

    const after = await rowById(depId);
    expect(after.status).toBe('ready');
    expect(after.completedAt?.toISOString()).toBe(READY_AT.toISOString());
    expect(after.url).toBe('https://example.test/ready');

    // A later, differing provider answer must not re-flip the terminal row.
    script('pd_once', { ref: errorRef('pd_once') });
    const second = await sweepPending({ db, keys }, SITE_A);
    // The row is no longer pending, so it is not even picked up …
    expect(second).toEqual({ checked: 0, errors: 0 });
    // … and a direct sync attempt is likewise inert.
    await service(SITE_A).syncDeployment(depId);

    const final = await rowById(depId);
    expect(final.status).toBe('ready');
    expect(final.completedAt?.toISOString()).toBe(READY_AT.toISOString());
    expect(final.errorMessage).toBeNull();
    expect(final.logExcerpt).toBeNull();
    expect(final.updatedAt.getTime()).toBe(after.updatedAt.getTime());
  });

  it('the conditional UPDATE rejects a write that lost the race (Req 3.4)', async () => {
    if (!canConnect) return;
    const depId = await seedDeployment(SITE_A, targetA, 'pd_race');
    // Both concurrent sweeps read the row while it is still `building`; the
    // guard decides which write commits. The two answers differ, so a blended
    // row would be visible.
    script('pd_race', { ref: readyRef('pd_race') }, { ref: errorRef('pd_race') });

    await Promise.all([sweepPending({ db, keys }, SITE_A), sweepPending({ db, keys }, SITE_A)]);

    const row = await rowById(depId);
    // Exactly one of the two answers landed — never a blend of both.
    if (row.status === 'ready') {
      expect(row.completedAt?.toISOString()).toBe(READY_AT.toISOString());
      expect(row.errorMessage).toBeNull();
    } else {
      expect(row.status).toBe('error');
      expect(row.completedAt?.toISOString()).toBe(OTHER_AT.toISOString());
      expect(row.errorMessage).toBe('build failed later');
    }
  });

  it('one failing deployment does not abort the sweep (Req 9.4)', async () => {
    if (!canConnect) return;
    const badId = await seedDeployment(SITE_A, targetA, 'pd_bad', 'queued');
    const goodId = await seedDeployment(SITE_A, targetA, 'pd_good');
    script('pd_bad', { throws: 'provider 503' });
    script('pd_good', { ref: readyRef('pd_good') });

    const result = await sweepPending({ db, keys }, SITE_A);
    expect(result.checked).toBe(2);
    expect(result.errors).toBe(1);

    expect((await rowById(goodId)).status).toBe('ready');
    // The failure is left pending for the next tick, not marked terminal.
    const bad = await rowById(badId);
    expect(bad.status).toBe('queued');
    expect(bad.completedAt).toBeNull();

    // Next tick: the transient failure recovers, the already-terminal row is
    // not re-checked.
    script('pd_bad', { ref: readyRef('pd_bad') });
    statusCalls.length = 0;
    const retry = await sweepPending({ db, keys }, SITE_A);
    expect(retry).toEqual({ checked: 1, errors: 0 });
    expect(statusCalls).toEqual(['pd_bad']);
    expect((await rowById(badId)).status).toBe('ready');
  });

  it('webhook and poller converge without double-writing (Req 7.3)', async () => {
    if (!canConnect) return;
    const depId = await seedDeployment(SITE_A, targetA, 'pd_hook');
    script('pd_hook', { ref: errorRef('pd_hook') });

    // Webhook wins the race and applies the terminal state first.
    await service(SITE_A).applyWebhookRef(readyRef('pd_hook'));
    const afterHook = await rowById(depId);
    expect(afterHook.status).toBe('ready');
    expect(afterHook.completedAt?.toISOString()).toBe(READY_AT.toISOString());

    // The poller then sweeps: the row is terminal, so nothing is rewritten
    // even though the scripted provider answer differs.
    const sweep = await sweepPending({ db, keys }, SITE_A);
    expect(sweep).toEqual({ checked: 0, errors: 0 });

    // And a duplicate webhook delivery is inert too (providers retry).
    await service(SITE_A).applyWebhookRef(errorRef('pd_hook'));
    const final = await rowById(depId);
    expect(final.status).toBe('ready');
    expect(final.completedAt?.toISOString()).toBe(READY_AT.toISOString());
    expect(final.errorMessage).toBeNull();
    expect(final.updatedAt.getTime()).toBe(afterHook.updatedAt.getTime());
  });

  it('sweeping site A never touches site B (DoD §2b two-site check)', async () => {
    if (!canConnect) return;
    // Same providerDeploymentId in both tenants — the worst case for a query
    // that forgot its site filter.
    const depA = await seedDeployment(SITE_A, targetA, 'pd_shared');
    const depB = await seedDeployment(SITE_B, targetB, 'pd_shared');
    script('pd_shared', { ref: readyRef('pd_shared') });

    const sweep = await sweepPending({ db, keys }, SITE_A);
    expect(sweep).toEqual({ checked: 1, errors: 0 });
    expect((await rowById(depA)).status).toBe('ready');
    const untouchedB = await rowById(depB);
    expect(untouchedB.status).toBe('building');
    expect(untouchedB.completedAt).toBeNull();

    // A webhook delivered on site A's tenant must not resolve site B's row.
    await service(SITE_A).applyWebhookRef(errorRef('pd_shared'));
    const stillUntouched = await rowById(depB);
    expect(stillUntouched.status).toBe('building');
    expect(stillUntouched.updatedAt.getTime()).toBe(untouchedB.updatedAt.getTime());

    // Sanity: site B's own sweep does resolve it.
    const sweepB = await sweepPending({ db, keys }, SITE_B);
    expect(sweepB).toEqual({ checked: 1, errors: 0 });
    expect((await rowById(depB)).status).toBe('ready');

    // Guard against a cross-tenant leak in either direction.
    const crossCount = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.siteId, SITE_B), eq(deployments.targetId, targetA)));
    expect(crossCount).toHaveLength(0);
  });
});
