import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
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
import { AISecureHarness } from '../ai-harness';
import { EffectiveCapabilityService } from '../effective-capability-service';
import { itemServiceForPrincipal } from '../item-service-factory';
import type { ConfiguredLLM, LLMMessage } from '../llm-provider';
import { SchemaService } from '../schema-service';

/**
 * What `aiContentAssist` puts in front of the model as "RAG" context (#581).
 *
 * The context is a live `ItemService.list` sample, so these cases check what
 * actually reaches the provider: tenant, row and field rules; freshness after
 * an update, a delete and a permission revocation; no internal row metadata;
 * and the retrieval baseline of the versioned dataset (Recall@k, MRR@k).
 *
 * Evidence class: REAL PostgreSQL, REAL `ItemService` bound to a resolved
 * API-key principal, two sites. The provider is a recorder that captures the
 * prompt; no live model is called.
 */
interface CorpusItem {
  key: string;
  status: string;
  updatedRank: number;
  title: string;
  body: string;
}
interface RetrievalDataset {
  version: string;
  k: number;
  permittedScope: { rowRule: Record<string, unknown>; fields: string[] };
  corpus: CorpusItem[];
  otherSite: Array<{ key: string; status: string; title: string; body: string }>;
  queries: Array<{ id: string; instruction: string; relevant: string[] }>;
  baseline: {
    retrievedForEveryQuery: string[];
    recallAtK: Record<string, number>;
    meanRecallAtK: number;
    reciprocalRank: Record<string, number>;
    mrrAtK: number;
  };
}

const DATASET = JSON.parse(
  readFileSync(resolve(__dirname, '../../../eval/retrieval/dataset.v1.json'), 'utf8'),
) as RetrievalDataset;

const SITE_A = 'site_581_a';
const SITE_B = 'site_581_b';
const POLICY = 'pol_581_reader';
const KEY = 'key_581_reader';
const HIDDEN_CANARY = 'CANARY-581-HIDDEN-FIELD';
const SITE_B_CANARY = 'CANARY-581-SITE-B';

const round = (n: number) => Math.round(n * 10_000) / 10_000;

describe.skipIf(!hasDbIntegrationUrl)('#581 aiContentAssist retrieval context — DB integration', () => {
  let db: Database;
  let collectionA: string;
  /** dataset key → item id */
  const ids = new Map<string, string>();
  /** dataset key → title currently stored */
  const titles = new Map<string, string>();

  beforeAll(async () => {
    db = await connectDbIntegration('ai-content-assist-retrieval');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(sql`${sites.id} IN (${SITE_A}, ${SITE_B})`).catch(() => undefined);
  });

  beforeEach(async () => {
    ids.clear();
    titles.clear();
    await db.delete(sites).where(sql`${sites.id} IN (${SITE_A}, ${SITE_B})`);
    await db.insert(sites).values([
      { id: SITE_A, name: '581 A' },
      { id: SITE_B, name: '581 B' },
    ]);
    await db.insert(policies).values({
      id: POLICY,
      siteId: SITE_A,
      name: '581 reader',
      key: '581-reader',
      adminAccess: false,
      appAccess: true,
    });
    await db.insert(permissions).values({
      siteId: SITE_A,
      policyId: POLICY,
      collection: 'articles',
      action: 'read',
      permissions: DATASET.permittedScope.rowRule,
      fields: DATASET.permittedScope.fields,
    });
    await db.insert(apiKeys).values({
      id: KEY,
      siteId: SITE_A,
      name: '581 reader key',
      prefix: 'lbk_581',
      tokenHash: 'fixture-not-a-credential',
    });
    await db.insert(apiKeyPolicies).values({ siteId: SITE_A, apiKeyId: KEY, policyId: POLICY, priority: 0 });

    const [articlesA] = await db
      .insert(collections)
      .values({ siteId: SITE_A, name: 'articles', label: 'Articles' })
      .returning();
    collectionA = articlesA!.id;
    await db.insert(fields).values(
      ['title', 'body', 'internalNote'].map((name) => ({
        siteId: SITE_A,
        collectionId: collectionA,
        name,
        type: 'string',
        interface: 'input',
      })),
    );
    // updatedRank 1 = most recently updated; fixed timestamps keep the default
    // `updated_at DESC` order deterministic.
    const base = Date.UTC(2026, 10, 1, 12, 0, 0);
    for (const entry of DATASET.corpus) {
      const at = new Date(base - entry.updatedRank * 60_000);
      const [row] = await db
        .insert(items)
        .values({
          siteId: SITE_A,
          collectionId: collectionA,
          status: entry.status,
          data: { title: entry.title, body: entry.body, internalNote: HIDDEN_CANARY },
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      ids.set(entry.key, row!.id);
      titles.set(entry.key, entry.title);
    }

    const [articlesB] = await db
      .insert(collections)
      .values({ siteId: SITE_B, name: 'articles', label: 'Articles' })
      .returning();
    for (const entry of DATASET.otherSite) {
      await db.insert(items).values({
        siteId: SITE_B,
        collectionId: articlesB!.id,
        status: entry.status,
        data: { title: entry.title, body: entry.body },
        // Newer than everything on site A: it would be sampled first if the
        // tenant filter were missing.
        updatedAt: new Date(base + 60_000),
      });
    }
  });

  const keyRef = { type: 'api_key' as const, siteId: SITE_A, apiKeyId: KEY };

  function recorder() {
    const prompts: string[] = [];
    const llm: ConfiguredLLM = {
      name: 'recorder',
      model: 'recorder-1',
      provider: {
        chat: async (messages: LLMMessage[]) => {
          prompts.push(messages.map((m) => m.content).join('\n'));
          return { content: '{"content":"ok"}', toolCalls: [] };
        },
      },
    };
    return { llm, prompts };
  }

  async function assist(instruction: string, expectStatus: 'executed' | 'denied' = 'executed') {
    const grant = await new EffectiveCapabilityService({ db, siteId: SITE_A }).resolve(keyRef);
    expect(grant.allowed, 'fixture principal must resolve').toBe(true);
    const allowed = grant as Extract<typeof grant, { allowed: true }>;
    const itemService = itemServiceForPrincipal({ db, siteId: SITE_A }, allowed.permissionContext!);
    const listSpy = vi.spyOn(itemService, 'list');
    const { llm, prompts } = recorder();
    const harness = new AISecureHarness({
      db,
      siteId: SITE_A,
      schemaService: new SchemaService({ db, siteId: SITE_A }),
      itemService,
      llm,
    });
    const result = await harness.execute(
      'aiContentAssist',
      { collection: 'articles', fieldName: 'body', instruction },
      allowed.capabilities,
      `#581 ${instruction}`,
      { requestedByPrincipal: { kind: 'principal', ref: keyRef } as never },
    );
    expect(result.status, result.message ?? '').toBe(expectStatus);
    expect(prompts).toHaveLength(expectStatus === 'executed' ? 1 : 0);
    return {
      prompt: prompts[0] ?? '',
      data: result.data as { ragSamples: number },
      listCalls: listSpy.mock.calls,
    };
  }

  /** Dataset keys whose current title appears in the prompt, in prompt order. */
  function retrieved(prompt: string): string[] {
    return [...titles.entries()]
      .map(([key, title]) => ({ key, at: prompt.indexOf(title) }))
      .filter((hit) => hit.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((hit) => hit.key);
  }

  it('sends only permitted content of the caller site, without internal row metadata', async () => {
    const { prompt, data, listCalls } = await assist(DATASET.queries[0]!.instruction);
    expect(data.ragSamples).toBe(DATASET.k);
    expect(prompt).not.toContain(HIDDEN_CANARY); // field rule
    expect(prompt).not.toContain(SITE_B_CANARY); // tenant
    expect(retrieved(prompt)).not.toContain('c7'); // row rule (draft)
    for (const leaked of [SITE_A, collectionA, ...ids.values(), '"siteId"', '"collectionId"', '"dekWrapped"', '"userCreated"']) {
      expect(prompt, `internal metadata reached the model: ${leaked}`).not.toContain(leaked);
    }
    // No count(*) over the collection for a 3-row sample.
    expect(listCalls).toEqual([['articles', { limit: 3, withTotal: false }]]);
  });

  it('reproduces the versioned baseline: Recall@k and MRR@k', async () => {
    const k = DATASET.k;
    const recall: Record<string, number> = {};
    const rr: Record<string, number> = {};
    for (const query of DATASET.queries) {
      const got = retrieved((await assist(query.instruction)).prompt).slice(0, k);
      expect(got, `${query.id}: retrieved set`).toEqual(DATASET.baseline.retrievedForEveryQuery);
      const hits = query.relevant.filter((key) => got.includes(key)).length;
      recall[query.id] = round(hits / query.relevant.length);
      const first = got.findIndex((key) => query.relevant.includes(key));
      rr[query.id] = first < 0 ? 0 : round(1 / (first + 1));
    }
    const mean = (values: number[]) => round(values.reduce((a, b) => a + b, 0) / values.length);
    expect(recall).toEqual(DATASET.baseline.recallAtK);
    expect(rr).toEqual(DATASET.baseline.reciprocalRank);
    expect(mean(Object.values(recall))).toBe(DATASET.baseline.meanRecallAtK);
    expect(mean(Object.values(rr))).toBe(DATASET.baseline.mrrAtK);
  });

  it('reflects an update and a delete on the next call (no stale context)', async () => {
    const before = retrieved((await assist('anything')).prompt);
    expect(before).toEqual(['c6', 'c5', 'c4']);

    const renamed = 'Winter heat pump efficiency (revised 2026)';
    await db
      .update(items)
      .set({ data: { title: renamed, body: 'Revised.', internalNote: HIDDEN_CANARY } })
      .where(and(eq(items.siteId, SITE_A), eq(items.id, ids.get('c5')!)));
    await db
      .update(items)
      .set({ deletedAt: new Date() })
      .where(and(eq(items.siteId, SITE_A), eq(items.id, ids.get('c6')!)));

    const { prompt } = await assist('anything');
    expect(prompt).not.toContain('Battery storage sizing'); // deleted
    expect(prompt).not.toContain('"Winter heat pump efficiency"'); // old title
    titles.set('c5', renamed);
    expect(retrieved(prompt)).toEqual(['c5', 'c4', 'c3']);
  });

  it('sends no samples once read on the collection is revoked (other reads kept)', async () => {
    // A read grant elsewhere keeps `items:read`, so the skill still runs.
    await db.insert(permissions).values({ siteId: SITE_A, policyId: POLICY, collection: 'pages', action: 'read', fields: ['*'] });
    expect((await assist('anything')).data.ragSamples).toBe(DATASET.k);
    await db
      .delete(permissions)
      .where(and(eq(permissions.siteId, SITE_A), eq(permissions.policyId, POLICY), eq(permissions.collection, 'articles')));

    const { prompt, data } = await assist('anything');
    expect(data.ragSamples).toBe(0);
    for (const entry of DATASET.corpus) expect(prompt).not.toContain(entry.title);
  });

  it('refuses before any model call once every read grant is revoked', async () => {
    expect((await assist('anything')).data.ragSamples).toBe(DATASET.k);
    await db.delete(permissions).where(and(eq(permissions.siteId, SITE_A), eq(permissions.policyId, POLICY)));
    await assist('anything', 'denied'); // asserts zero prompts
  });
});
