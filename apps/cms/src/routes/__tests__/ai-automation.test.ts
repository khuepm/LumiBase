import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { validateGraph } from '@lumibase/contracts';
import { MemoryCacheProvider } from '@lumibase/runtime';
import type { AppEnv, AuthPrincipal } from '../../env';
import { MemoryAutomationActionStore } from '../../__tests__/helpers/memory-automation-store';
import { MemoryReviewStore } from '../../__tests__/helpers/memory-review-store';
import type { AutomationActionInsert } from '../../services/ai-automation-store';
import type { DecisionSiteSettings } from '../../services/decision-governance';
import { BRANCHING_OPERATIONS, flowSchema } from '../../services/flow-management';
import { listOperations } from '../../services/flow-service';
import { reviewContentHash, type ReviewContentAccess } from '../../services/review-service';
import { aiAutomationRouter, automationRouteDeps } from '../ai-automation';

/**
 * Automation routes (J11, #518): admin-only, site-scoped, and the audit chain
 * (revision → review run → action → feedback) is returned by id. Grants,
 * settings, stores and the caller's ItemService are faked; the route logic,
 * template builder, revert and metrics run for real.
 */

const ctx = vi.hoisted(() => ({
  grant: { allowed: true, capabilities: ['*'] as string[], controlPlaneAdmin: true } as {
    allowed: boolean;
    capabilities: string[];
    controlPlaneAdmin: boolean;
  },
  settings: { enabled: true, allowedStateFields: null, flows: true } as DecisionSiteSettings,
  reviews: null as unknown,
  content: null as unknown,
  item: { title: 'Tin nóng', tags: ['featured'] } as Record<string, unknown>,
  patches: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../services/governed-capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/governed-capabilities')>()),
  resolveRequestCapabilities: vi.fn(async () => ctx.grant),
}));
vi.mock('../../services/decision-governance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/decision-governance')>()),
  readDecisionSettings: vi.fn(async () => ctx.settings),
}));
vi.mock('../../services/review-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/review-store')>()),
  reviewStoreFor: () => ctx.reviews,
}));
vi.mock('../../services/review-content-access', () => ({
  reviewContentAccessForRequest: () => ctx.content,
}));
vi.mock('../../services/item-service-factory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/item-service-factory')>()),
  itemServiceForRequest: () => ({
    detail: async (_collection: string, _id: string, fields: string[]) =>
      Object.fromEntries(fields.map((field) => [field, ctx.item[field]])),
    patch: async (_collection: string, _id: string, patch: { data: Record<string, unknown> }) => {
      ctx.patches.push(patch.data);
      Object.assign(ctx.item, patch.data);
    },
  }),
}));

const SITE = 'site_1';
let reviews: MemoryReviewStore;
let actions: MemoryAutomationActionStore;
let runId: string;

const content: ReviewContentAccess = {
  async readItem(_collection, _itemId, fields) {
    const values: Record<string, unknown> = {};
    for (const field of fields) if (ctx.item[field] !== undefined) values[field] = ctx.item[field];
    return { values, omittedFields: [] };
  },
  async deniedSnapshotFields() {
    return [];
  },
  async latestRevisionId() {
    return 'rev_1';
  },
};

function action(overrides: Partial<AutomationActionInsert> = {}): AutomationActionInsert {
  return {
    id: `act_${Math.random().toString(36).slice(2)}`,
    siteId: SITE,
    flowRunId: 'flow_run_1',
    nodeId: 'tag',
    reviewRunId: runId,
    collection: 'posts',
    itemId: 'itm_1',
    revisionId: 'rev_1',
    contentHash: 'sha256:x',
    action: 'tag',
    mode: 'shadow',
    status: 'recorded',
    reason: 'mode_shadow',
    questionKey: 'category',
    locale: 'vi',
    provider: 'typesafe',
    model: 'jev-1.13',
    profileKey: 'taxonomy',
    profileVersion: 1,
    confidence: 0.9,
    inZone: true,
    proposed: { field: 'tags', value: ['featured', 'news'], target: 'news', choice: 'news', targets: { promo: 'ads-review' } },
    previous: { field: 'tags', value: ['featured'] },
    applied: false,
    principalType: 'user',
    principalId: 'usr_admin',
    ...overrides,
  };
}

beforeEach(async () => {
  ctx.grant = { allowed: true, capabilities: ['*'], controlPlaneAdmin: true };
  ctx.settings = { enabled: true, allowedStateFields: null, flows: true };
  ctx.item = { title: 'Tin nóng', tags: ['featured'] };
  ctx.patches = [];
  reviews = new MemoryReviewStore();
  actions = new MemoryAutomationActionStore(reviews);
  ctx.reviews = reviews;
  ctx.content = content;
  automationRouteDeps.store = () => actions;
  const profile = await reviews.insertFirstProfile({
    id: 'rp_1',
    siteId: SITE,
    collection: 'posts',
    key: 'taxonomy',
    version: 1,
    preset: null,
    fields: ['title'],
    questions: { category: { type: 'choice', instructions: 'Section?', criteria: { news: 'News', promo: 'Promo' } } },
    sourceField: null,
    minConfidence: null,
    note: null,
    createdBy: 'usr_admin',
  });
  const { run } = await reviews.claimRun({
    id: 'rr_1',
    siteId: SITE,
    profileId: profile!.id,
    profileKey: 'taxonomy',
    profileVersion: 1,
    collection: 'posts',
    itemId: 'itm_1',
    revisionId: 'rev_1',
    contentHash: await reviewContentHash({ title: 'Tin nóng' }),
    source: 'item',
    omittedFields: [],
    principalType: 'user',
    principalId: 'usr_admin',
    status: 'running',
    idempotencyKey: 'flow:flow_run_1:decide',
  });
  await reviews.completeRun(SITE, run.id, {
    status: 'success',
    provider: 'typesafe',
    model: 'jev-1.13',
    calibrated: true,
    answers: { category: { type: 'choice', choice: 'news', probabilities: { news: 0.9 }, confidence: 0.9 } },
    usage: null,
    latencyMs: 10,
    errorCode: null,
  }, run.createdAt);
  runId = run.id;
});

const adminAuth: AuthPrincipal = { userId: 'usr_admin', email: 'admin@example.com', roles: ['admin'], raw: {} };

function app(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('auth', adminAuth);
    c.set('siteId', SITE);
    c.set('requestId', 'req_1');
    c.set('db', {} as AppEnv['Variables']['db']);
    c.set('runtime', { cache: new MemoryCacheProvider() } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  a.route('/ai', aiAutomationRouter);
  return a;
}

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('admin only', () => {
  it.each([
    ['GET', '/ai/automation/templates'],
    ['POST', '/ai/automation/templates/taxonomy-tagging/build'],
    ['GET', '/ai/automation/actions'],
    ['GET', '/ai/automation/actions/act_1'],
    ['POST', '/ai/automation/actions/act_1/feedback'],
    ['POST', '/ai/automation/actions/act_1/revert'],
    ['GET', '/ai/automation/metrics'],
  ])('%s %s refuses a non-admin before touching data', async (method, path) => {
    ctx.grant = { allowed: true, capabilities: ['ai:decide', 'items:update'], controlPlaneAdmin: false };
    const seeded = await actions.claim(action({ id: 'act_1' }));
    const res = await app().request(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
    expect(res.status).toBe(403);
    expect(ctx.patches).toHaveLength(0);
    expect(reviews.feedback).toHaveLength(0);
    expect(seeded.row.status).toBe('recorded');
  });
});

describe('templates', () => {
  it('lists both templates; each example is a valid draft flow', async () => {
    const res = await app().request('/ai/automation/templates');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ key: string; example: unknown }> };
    expect(data.map((t) => t.key)).toEqual(['taxonomy-tagging', 'editorial-routing']);
    const keys = listOperations().map((o) => o.key);
    for (const template of data) {
      const flow = flowSchema.parse(template.example);
      expect(flow).toMatchObject({ status: 'draft', triggerType: 'manual' });
      const verdict = validateGraph(flow.graph as Parameters<typeof validateGraph>[0], keys, {
        branchingKeys: BRANCHING_OPERATIONS,
      });
      expect(verdict.ok).toBe(true);
    }
  });

  it('builds from parameters and rejects bad ones', async () => {
    const ok = await app().request(
      '/ai/automation/templates/taxonomy-tagging/build',
      json({ profileKey: 'taxonomy', profileVersion: 2, collection: 'posts', questionKey: 'category', choices: ['news', 'guide'], tagField: 'tags' }),
    );
    expect(ok.status).toBe(200);
    const { data } = (await ok.json()) as { data: { graph: { nodes: Array<{ id: string; branches?: Record<string, string | null> }> } } };
    expect(data.graph.nodes[0]!.branches).toEqual({ news: 'tag', guide: 'tag', unknown: 'tag', error: null });

    const reserved = await app().request(
      '/ai/automation/templates/taxonomy-tagging/build',
      json({ profileKey: 'taxonomy', profileVersion: 1, collection: 'posts', questionKey: 'category', choices: ['error'], tagField: 'tags' }),
    );
    expect(reserved.status).toBe(400);
    const missing = await app().request('/ai/automation/templates/nope/build', json({}));
    expect(missing.status).toBe(404);
  });
});

describe('actions and the audit chain', () => {
  it('returns the chain by id, site-scoped', async () => {
    const mine = await actions.claim(action());
    await actions.claim(action({ id: 'act_other', siteId: 'site_2' }));
    await reviews.insertFeedback(SITE, runId, 'usr_admin', [
      { id: 'fb_1', siteId: SITE, runId, questionKey: 'category', verdict: 'accept', editedValue: null, principalType: 'user', principalId: 'usr_admin' },
    ]);
    const res = await app().request('/ai/automation/actions?collection=posts');
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: mine.row.id,
      chain: {
        revisionId: 'rev_1',
        reviewRunId: runId,
        actionId: mine.row.id,
        flowRunId: 'flow_run_1',
        feedback: [expect.objectContaining({ verdict: 'accept', principalId: 'usr_admin' })],
      },
    });
    expect((await app().request('/ai/automation/actions/act_other')).status).toBe(404);
  });

  it('records accept and override feedback on the decision behind an action', async () => {
    const { row } = await actions.claim(action());
    const override = await app().request(`/ai/automation/actions/${row.id}/feedback`, json({ verdict: 'edit', editedValue: 'promo' }));
    expect(override.status).toBe(201);
    expect(reviews.feedback).toEqual([expect.objectContaining({ runId, questionKey: 'category', verdict: 'edit', editedValue: 'promo' })]);
    const bad = await app().request(`/ai/automation/actions/${row.id}/feedback`, json({ verdict: 'edit' }));
    expect(bad.status).toBe(400);
  });

  it('stores an override given as a mapped tag or queue in the decision vocabulary', async () => {
    const { row } = await actions.claim(action());
    const res = await app().request(`/ai/automation/actions/${row.id}/feedback`, json({ verdict: 'edit', editedValue: 'ads-review' }));
    expect(res.status).toBe(201);
    expect(reviews.feedback).toEqual([expect.objectContaining({ questionKey: 'category', verdict: 'edit', editedValue: 'promo' })]);
  });

  it('refuses an override that is not a value the decision can take', async () => {
    const { row } = await actions.claim(action());
    const res = await app().request(`/ai/automation/actions/${row.id}/feedback`, json({ verdict: 'edit', editedValue: 'newsdesk' }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: Array<{ code: string; message: string }> };
    expect(body.errors[0]).toMatchObject({ code: 'AUTOMATION_OVERRIDE_UNMAPPED' });
    expect(body.errors[0]!.message).toContain('ads-review');
    expect(reviews.feedback).toHaveLength(0);
    const notString = await app().request(`/ai/automation/actions/${row.id}/feedback`, json({ verdict: 'edit', editedValue: 3 }));
    expect(notString.status).toBe(422);
  });

  it('refuses accept on a stale decision unless acknowledged', async () => {
    const { row } = await actions.claim(action());
    ctx.item['title'] = 'Changed';
    const stale = await app().request(`/ai/automation/actions/${row.id}/feedback`, json({ verdict: 'accept' }));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('REVIEW_STALE');
    const acknowledged = await app().request(
      `/ai/automation/actions/${row.id}/feedback`,
      json({ verdict: 'accept', acknowledgeStale: true }),
    );
    expect(acknowledged.status).toBe(201);
  });

  it('reverts an applied action through the caller ItemService', async () => {
    const { row } = await actions.claim(action({ mode: 'live', status: 'pending_approval', approvalId: 'apr_1' }));
    actions.approvals.set('apr_1', 'approved');
    ctx.item['tags'] = ['featured', 'news'];
    const res = await app().request(`/ai/automation/actions/${row.id}/revert`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(ctx.patches).toEqual([{ tags: ['featured'] }]);
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe('reverted');
    const again = await app().request(`/ai/automation/actions/${row.id}/revert`, { method: 'POST' });
    expect(again.status).toBe(409);
  });

  it('a shadow action cannot be reverted', async () => {
    const { row } = await actions.claim(action());
    const res = await app().request(`/ai/automation/actions/${row.id}/revert`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(ctx.patches).toHaveLength(0);
  });
});

describe('metrics', () => {
  it('keeps shadow on with an insufficient sample', async () => {
    ctx.settings = {
      ...ctx.settings,
      automation: {
        mode: 'shadow',
        thresholds: {
          vi: {
            tag: {
              provider: 'typesafe',
              model: 'jev-1.13',
              profileKey: 'taxonomy',
              profileVersion: 1,
              questionKey: 'category',
              minConfidence: 0.8,
            },
          },
        },
      },
    };
    await actions.claim(action());
    const res = await app().request('/ai/automation/metrics?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { shadowRequired: boolean; splits: Array<{ insufficientSample: boolean; inZone: number }> } };
    expect(data.shadowRequired).toBe(true);
    expect(data.splits).toEqual([expect.objectContaining({ insufficientSample: true, inZone: 1 })]);
  });

  it('validates the window', async () => {
    expect((await app().request('/ai/automation/metrics?from=nope')).status).toBe(400);
  });
});
