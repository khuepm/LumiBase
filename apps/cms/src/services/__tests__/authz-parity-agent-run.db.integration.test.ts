import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentRuns,
  agentToolCalls,
  apiKeyPolicies,
  apiKeys,
  collections,
  fields,
  items,
  permissions,
  policies,
  sites,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { AgentRunService } from '../agent-run-service';
import { processAgentRunJob, type AgentRunJobPayload } from '../agent-run-worker';
import { AISecureHarness } from '../ai-harness';
import { EffectiveCapabilityService } from '../effective-capability-service';
import { itemServiceForPrincipal } from '../item-service-factory';
import { SchemaService } from '../schema-service';

/**
 * Authorization parity between the synchronous transports and the queued
 * Agent API path (#580).
 *
 * The synchronous transports (Copilot `POST /ai/chat`, governed `POST /mcp`, the
 * approval decide routes) and the async Copilot worker all execute skills with an
 * ItemService bound to the caller (`itemServiceForRequest` /
 * `itemServiceForPrincipal`). The Agent API worker (`processAgentRunJob`) built a
 * SYSTEM ItemService for every job, so a run that carried a principal passed the
 * coarse capability check and then wrote with no row or field rules.
 *
 * Each case runs the same tool call twice: once through a request-equivalent
 * harness (what Copilot/MCP do) and once as a queued Agent API run. Both must
 * leave the same rows behind.
 *
 * Evidence class: REAL PostgreSQL, REAL worker entry point, REAL ItemService,
 * two sites, a least-privilege API key principal. No network, no LLM.
 */

const SITE_A = 'site_580_a';
const SITE_B = 'site_580_b';
const POLICY = 'pol_580_writer';
const KEY = 'key_580_writer';
const CANARY_A = 'CANARY-580-A';
const CANARY_B = 'CANARY-580-B';

const keyRef = { type: 'api_key' as const, siteId: SITE_A, apiKeyId: KEY };

describe.skipIf(!hasDbIntegrationUrl)('#580 authorization parity — sync transports vs queued Agent API run', { timeout: 180_000 }, () => {
  let db: Database;
  let postA: string;
  let postB: string;

  beforeAll(async () => {
    db = await connectDbIntegration('authz-parity-agent-run');
  }, 180_000);

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(sql`${sites.id} IN (${SITE_A}, ${SITE_B})`).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(sql`${sites.id} IN (${SITE_A}, ${SITE_B})`);
    await db.insert(sites).values([
      { id: SITE_A, name: '580 A' },
      { id: SITE_B, name: '580 B' },
    ]);
    await db.insert(policies).values({
      id: POLICY,
      siteId: SITE_A,
      name: '580 writer',
      key: '580-writer',
      adminAccess: false,
      appAccess: true,
    });
    // `posts` only, and only `title`/`body`. `internalNote` and the whole
    // `secrets` collection are outside the grant.
    await db.insert(permissions).values([
      { siteId: SITE_A, policyId: POLICY, collection: 'posts', action: 'read', fields: ['title', 'body'] },
      { siteId: SITE_A, policyId: POLICY, collection: 'posts', action: 'create', fields: ['title', 'body'] },
      { siteId: SITE_A, policyId: POLICY, collection: 'posts', action: 'update', fields: ['title', 'body'] },
    ]);
    await db.insert(apiKeys).values({
      id: KEY,
      siteId: SITE_A,
      name: '580 writer key',
      prefix: 'lbk_580',
      tokenHash: 'fixture-not-a-credential',
    });
    await db.insert(apiKeyPolicies).values({ siteId: SITE_A, apiKeyId: KEY, policyId: POLICY, priority: 0 });

    const [postsA] = await db.insert(collections).values({ siteId: SITE_A, name: 'posts', label: 'Posts' }).returning();
    const [secretsA] = await db.insert(collections).values({ siteId: SITE_A, name: 'secrets', label: 'Secrets' }).returning();
    await db.insert(fields).values([
      ...['title', 'body', 'internalNote'].map((name) => ({
        siteId: SITE_A,
        collectionId: postsA!.id,
        name,
        type: 'string',
        interface: 'input',
      })),
      { siteId: SITE_A, collectionId: secretsA!.id, name: 'title', type: 'string', interface: 'input' },
    ]);
    const [itemA] = await db
      .insert(items)
      .values({ siteId: SITE_A, collectionId: postsA!.id, data: { title: 'Original', body: 'b', internalNote: CANARY_A } })
      .returning();
    postA = itemA!.id;

    const [postsB] = await db.insert(collections).values({ siteId: SITE_B, name: 'posts', label: 'Posts' }).returning();
    const [itemB] = await db
      .insert(items)
      .values({ siteId: SITE_B, collectionId: postsB!.id, data: { title: CANARY_B } })
      .returning();
    postB = itemB!.id;
  }, 180_000);

  /** What Copilot sync / governed MCP do: principal-bound ItemService. */
  async function runSync(skill: string, args: Record<string, unknown>) {
    const grant = await new EffectiveCapabilityService({ db, siteId: SITE_A }).resolve(keyRef);
    expect(grant.allowed, 'fixture principal must resolve').toBe(true);
    const allowed = grant as Extract<typeof grant, { allowed: true }>;
    const harness = new AISecureHarness({
      db,
      siteId: SITE_A,
      schemaService: new SchemaService({ db, siteId: SITE_A }),
      itemService: itemServiceForPrincipal({ db, siteId: SITE_A }, allowed.permissionContext!),
    });
    return harness.execute(skill, args, allowed.capabilities, '#580 sync', {
      requestedByPrincipal: { kind: 'principal', ref: keyRef } as never,
    });
  }

  /** What `POST /agent/goals` with `execution: 'async'` enqueues, then the worker. */
  async function runQueued(skill: string, args: Record<string, unknown>) {
    const run = await new AgentRunService(db, SITE_A).ensureRun({ title: `#580 ${skill}`, status: 'queued' });
    const payload: AgentRunJobPayload = {
      siteId: SITE_A,
      goalId: run.goalId,
      runId: run.runId,
      skillName: skill,
      arguments: args,
      principal: keyRef as never,
      userId: null,
      contextMessage: '#580 queued',
    };
    await processAgentRunJob({ db, env: { LLM_PROVIDER: 'echo', LUMIBASE_ENV: 'development' } } as never, payload);
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.runId));
    const calls = await db
      .select()
      .from(agentToolCalls)
      .where(and(eq(agentToolCalls.siteId, SITE_A), eq(agentToolCalls.runId, run.runId)));
    return { run: row!, calls };
  }

  async function rowsWithTitle(collection: string, title: string) {
    return db
      .select({ id: items.id, data: items.data })
      .from(items)
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(and(eq(items.siteId, SITE_A), eq(collections.name, collection), sql`${items.data}->>'title' = ${title}`));
  }

  async function itemData(id: string) {
    const [row] = await db.select().from(items).where(eq(items.id, id));
    return row!.data as Record<string, unknown>;
  }

  it('an authorized create executes on both paths', async () => {
    const sync = await runSync('createItem', { collection: 'posts', data: { title: 'sync-ok' } });
    expect(sync.status).toBe('executed');
    const queued = await runQueued('createItem', { collection: 'posts', data: { title: 'queued-ok' } });
    expect(queued.run.status, queued.run.error ?? '').toBe('succeeded');
    expect(await rowsWithTitle('posts', 'sync-ok')).toHaveLength(1);
    expect(await rowsWithTitle('posts', 'queued-ok')).toHaveLength(1);
  });

  it('a create in a collection outside the grant writes nothing on either path', async () => {
    const sync = await runSync('createItem', { collection: 'secrets', data: { title: 'sync-secret' } });
    expect(sync.status).not.toBe('executed');
    const queued = await runQueued('createItem', { collection: 'secrets', data: { title: 'queued-secret' } });
    expect(queued.run.status).not.toBe('succeeded');
    expect(await rowsWithTitle('secrets', 'sync-secret')).toHaveLength(0);
    expect(await rowsWithTitle('secrets', 'queued-secret')).toHaveLength(0);
  });

  it('an update to a field outside the grant leaves the item unchanged on either path', async () => {
    const sync = await runSync('updateItem', { collection: 'posts', id: postA, data: { internalNote: 'sync-overwrite' } });
    expect(sync.status).not.toBe('executed');
    const queued = await runQueued('updateItem', { collection: 'posts', id: postA, data: { internalNote: 'queued-overwrite' } });
    expect(queued.run.status).not.toBe('succeeded');
    expect(await itemData(postA)).toMatchObject({ title: 'Original', internalNote: CANARY_A });
  });

  it('a read returns neither the masked field nor the other tenant on either path', async () => {
    const sync = await runSync('listItems', { collection: 'posts' });
    expect(sync.status).toBe('executed');
    const queued = await runQueued('listItems', { collection: 'posts' });
    expect(queued.run.status, queued.run.error ?? '').toBe('succeeded');
    for (const text of [JSON.stringify(sync.data ?? null), JSON.stringify(queued.calls.map((c) => c.output))]) {
      expect(text).toContain('Original');
      expect(text).not.toContain(CANARY_A);
      expect(text).not.toContain(CANARY_B);
    }
  });

  it('a cross-tenant item id is not reachable on either path', async () => {
    await runSync('updateItem', { collection: 'posts', id: postB, data: { title: 'sync-cross' } });
    await runQueued('updateItem', { collection: 'posts', id: postB, data: { title: 'queued-cross' } });
    expect(await itemData(postB)).toEqual({ title: CANARY_B });
  });

  it('a grant revoked between enqueue and pickup stops the queued run with no side effect', async () => {
    const run = await new AgentRunService(db, SITE_A).ensureRun({ title: '#580 revoked', status: 'queued' });
    // Revocation lands after the job was accepted.
    await db.delete(apiKeyPolicies).where(eq(apiKeyPolicies.apiKeyId, KEY));
    await processAgentRunJob({ db, env: { LLM_PROVIDER: 'echo', LUMIBASE_ENV: 'development' } } as never, {
      siteId: SITE_A,
      goalId: run.goalId,
      runId: run.runId,
      skillName: 'createItem',
      arguments: { collection: 'posts', data: { title: 'after-revoke' } },
      principal: keyRef as never,
      userId: null,
    });
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.runId));
    expect(row!.status).toBe('failed');
    expect(await rowsWithTitle('posts', 'after-revoke')).toHaveLength(0);
  });
});
