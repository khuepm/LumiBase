import { describe, expect, it, vi } from 'vitest';
import { ReviewProfileCreateInputSchema } from '@lumibase/contracts/schemas';
import { MemoryReviewStore } from '../../__tests__/helpers/memory-review-store';
import { parseDecisionSettings, type GovernedDecisionOutcome } from '../decision-governance';
import type { DecisionRequest } from '../decision-provider';
import { diffDrifts, driftFingerprint, evaluateRules, type DriftItemView } from '../drift-service';
import { assertSemanticVersionBumps, intentInputSchema, type IntentRule } from '../intent-service';
import { planReconciliation, semanticGoalProvenance, type ReconcilableDrift } from '../reconciler-service';
import { ReviewService, ReviewServiceError, type ReviewContentAccess, type ReviewPrincipal } from '../review-service';
import { semanticOutcome, semanticRuleKey, type SemanticRule } from '../semantic-drift';
import {
  runSemanticPass,
  SEMANTIC_DRIFT_PRINCIPAL,
  type SemanticDriftInsert,
  type SemanticDriftRow,
  type SemanticDriftRuntime,
  type SemanticDriftStore,
} from '../semantic-drift-scan';

/**
 * Semantic drift (Jev J12, #519). The semantic pass runs against an
 * in-memory drift store with the DB's unique fingerprint, a real
 * ReviewService over the in-memory review store (same idempotency rules as
 * Postgres) and a stubbed governed decision. The DB path is covered by
 * `drift-semantic.db.integration.test.ts`.
 */

const SITE = 'site_1';
const INTENT = 'int_1';
const COLLECTION_ID = 'col_1';
const admin: ReviewPrincipal = { type: 'user', id: 'usr_admin', admin: true };

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface DriftRow extends SemanticDriftRow {
  detail: Record<string, unknown>;
  goalId: string | null;
}

class MemoryDriftStore implements SemanticDriftStore {
  rows: DriftRow[] = [];
  cursor: string | null = null;
  constructor(public items: Array<{ id: string; pinnedFields: string[] }>) {}

  async listItems(_collectionId: string, cursor: string | null, limit: number) {
    return this.items.filter((item) => cursor === null || item.id > cursor).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit);
  }
  async existing(_intentId: string, itemIds: readonly string[]) {
    return this.rows.filter((row) => itemIds.includes(row.itemId)).map(({ itemId, fingerprint, ruleKey, status }) => ({ itemId, fingerprint, ruleKey, status }));
  }
  async insert(_intentId: string, rows: readonly SemanticDriftInsert[]) {
    for (const row of rows) {
      if (this.rows.some((r) => r.fingerprint === row.fingerprint)) continue; // unique (site, fingerprint)
      this.rows.push({ ...row, goalId: null });
    }
  }
  async reopen(fingerprint: string, detail: Record<string, unknown>) {
    const row = this.rows.find((r) => r.fingerprint === fingerprint)!;
    Object.assign(row, { status: 'open', goalId: null, detail });
  }
  async updateDetail(fingerprint: string, detail: Record<string, unknown>) {
    const row = this.rows.find((r) => r.fingerprint === fingerprint && r.status === 'unevaluated');
    if (row) row.detail = detail;
  }
  async resolve(fingerprints: readonly string[]) {
    for (const row of this.rows) if (fingerprints.includes(row.fingerprint)) row.status = 'resolved';
  }
  async resolveOrphans(_intentId: string, liveKeys: readonly string[]) {
    let resolved = 0;
    for (const row of this.rows) {
      if (!['open', 'assigned', 'unevaluated'].includes(row.status)) continue;
      if (liveKeys.includes(row.ruleKey.split('@')[0]!)) continue;
      row.status = 'resolved';
      resolved += 1;
    }
    return resolved;
  }
  async saveCursor(_intentId: string, cursor: string | null) {
    this.cursor = cursor;
  }
  byStatus(status: string) {
    return this.rows.filter((row) => row.status === status);
  }
}

function ok(noul: number): GovernedDecisionOutcome {
  const data = {
    provider: 'typesafe',
    model: 'jev-1.13',
    calibrated: true,
    answers: { off_brief: { type: 'noul' as const, noul } },
    usage: { inputTokens: 40, outputTokens: 3 },
  };
  return {
    result: { ok: true, data, accounting: { attempts: 1, inputBytes: 10, estimatedInputTokens: 10, reservedTokens: 50, chargedTokens: 43 } },
    status: 200,
    body: { data },
  };
}

function outage(): GovernedDecisionOutcome {
  return {
    result: {
      ok: false,
      error: new Error('upstream'),
      accounting: { attempts: 1, inputBytes: 10, estimatedInputTokens: 10, reservedTokens: 50, chargedTokens: 50 },
    },
    status: 503,
    body: { errors: [{ code: 'DECISION_UNAVAILABLE', message: 'The decision provider is temporarily unavailable. Retry later.' }] },
  };
}

interface World {
  content: Record<string, Record<string, unknown>>;
  /** Answer per item id; a function lets a test vary it per call. */
  answer: (itemId: string, state: Record<string, unknown>) => GovernedDecisionOutcome;
  settings: unknown;
  /** Every `include` the runtime was asked to read, with the state sent. */
  sent: Array<{ state: Record<string, unknown> }>;
  reads: string[][];
}

async function setup(options: { items?: Array<{ id: string; pinnedFields?: string[] }>; profileFields?: string[] } = {}) {
  const reviewStore = new MemoryReviewStore();
  const world: World = {
    content: {},
    answer: () => ok(0.95),
    settings: { enabled: true, drift: true },
    sent: [],
    reads: [],
  };
  const items = (options.items ?? [{ id: 'itm_1' }]).map((item) => ({ id: item.id, pinnedFields: item.pinnedFields ?? [] }));
  for (const item of items) world.content[item.id] = { brief: 'A guide to composting at home', title: 'Composting basics', body: 'Layer greens and browns.' };

  const decide = vi.fn(async (request: DecisionRequest) => {
    const state = request.state as Record<string, unknown>;
    world.sent.push({ state });
    const itemId = Object.keys(world.content).find((id) => world.content[id]!['title'] === state['title']) ?? '';
    return world.answer(itemId, state);
  });

  const service = (include: readonly string[]) => {
    world.reads.push([...include]);
    const content: ReviewContentAccess = {
      async readItem(_collection, itemId, fields) {
        const item = world.content[itemId];
        if (!item) throw new ReviewServiceError('REVIEW_ITEM_NOT_FOUND', `Item "${itemId}" not found.`);
        const values: Record<string, unknown> = {};
        const omittedFields: string[] = [];
        for (const field of fields) {
          if (!include.includes(field)) omittedFields.push(field);
          else if (item[field] !== undefined) values[field] = item[field];
        }
        return { values, omittedFields };
      },
      async deniedSnapshotFields(_collection, keys) {
        return [...keys];
      },
      async latestRevisionId(itemId) {
        return `rev_${itemId}`;
      },
    };
    return { service: new ReviewService({ store: reviewStore, siteId: SITE, content, decide }), content };
  };

  const runtime: SemanticDriftRuntime = {
    readSettings: async () => parseDecisionSettings(world.settings),
    review: (include) => service(include),
  };

  // The profile a site admin pinned for the rule.
  await service([]).service.createProfile(
    ReviewProfileCreateInputSchema.parse({
      key: 'brief',
      collection: 'articles',
      fields: options.profileFields ?? ['brief', 'title', 'body'],
      questions: {
        off_brief: { type: 'noul', instructions: 'Does the text stray from the brief?', criteria: { true: 'off brief', false: 'on brief' } },
      },
    }),
    admin,
  );

  const store = new MemoryDriftStore(items);
  return { world, decide, runtime, store, reviewStore };
}

const RULE: SemanticRule = {
  type: 'semantic',
  key: 'off-brief',
  version: 1,
  profileKey: 'brief',
  profileVersion: 1,
  questionKey: 'off_brief',
  threshold: 0.8,
  fields: ['title', 'body'],
  contextSource: 'field:brief',
};

function pass(
  ctx: Awaited<ReturnType<typeof setup>>,
  options: { rules?: SemanticRule[]; maxItems?: number; deadline?: number; now?: () => number } = {},
) {
  return runSemanticPass({
    siteId: SITE,
    intent: { id: INTENT, collection: 'articles', semanticScanCursor: ctx.store.cursor },
    collectionId: COLLECTION_ID,
    rules: options.rules ?? [RULE],
    store: ctx.store,
    runtime: ctx.runtime,
    maxItems: options.maxItems,
    deadline: options.deadline ?? Number.MAX_SAFE_INTEGER,
    ...(options.now ? { now: options.now } : {}),
  });
}

// ---------------------------------------------------------------------------
// Deterministic rules are unchanged
// ---------------------------------------------------------------------------

describe('deterministic rules', () => {
  const item: DriftItemView = {
    id: 'itm_1',
    data: { title: '', body: 'x' },
    updatedAt: new Date('2026-01-01'),
    pinnedFields: [],
  };
  const deterministic: IntentRule[] = [
    { type: 'required_fields', fields: ['title'] },
    { type: 'freshness', maxAgeDays: 30 },
  ];

  it('evaluate exactly as before; a semantic rule adds nothing to evaluateRules', () => {
    const now = new Date('2026-03-01');
    const before = evaluateRules(deterministic, item, { now });
    const withSemantic = evaluateRules([...deterministic, { ...RULE } as IntentRule], item, { now });
    expect(withSemantic).toEqual(before);
    expect(before.map((v) => `${v.ruleType}:${v.ruleKey}`)).toEqual(['required_fields:title', 'freshness:age']);
  });

  it('diffDrifts without an unevaluated set behaves as before', () => {
    const existing = new Map([
      ['a', { status: 'open' }],
      ['b', { status: 'assigned' }],
      ['c', { status: 'resolved' }],
    ]);
    expect(diffDrifts(existing, new Set(['c', 'd']))).toEqual({ toOpen: ['d'], toReopen: ['c'], toResolve: ['a', 'b'] });
  });

  it('diffDrifts never resolves an unevaluated fingerprint', () => {
    const existing = new Map([
      ['old', { status: 'open' }],
      ['gone', { status: 'open' }],
    ]);
    expect(diffDrifts(existing, new Set(), new Set(['old']))).toEqual({ toOpen: [], toReopen: [], toResolve: ['gone'] });
  });
});

// ---------------------------------------------------------------------------
// Rule schema
// ---------------------------------------------------------------------------

describe('semantic rule schema', () => {
  const base = { name: 'briefs', collection: 'articles', schedule: '0 6 * * *' };

  it('accepts a semantic rule next to deterministic ones and defaults contextSource to intent', () => {
    const parsed = intentInputSchema.parse({
      ...base,
      rules: [
        { type: 'required_fields', fields: ['title'] },
        { type: 'semantic', key: 'tone', version: 1, profileKey: 'voice', profileVersion: 2, questionKey: 'needs_review', threshold: 0.8 },
      ],
    });
    expect(parsed.rules[1]).toEqual({
      type: 'semantic',
      key: 'tone',
      version: 1,
      profileKey: 'voice',
      profileVersion: 2,
      questionKey: 'needs_review',
      threshold: 0.8,
      contextSource: 'intent',
    });
  });

  it.each([
    ['a threshold below 0.5', { threshold: 0.4 }],
    ['an unpinned profile version', { profileVersion: undefined }],
    ['a non-integer rule version', { version: 1.5 }],
    ['an unknown context source', { contextSource: 'url:https://example.test' }],
    ['an unknown key', { prompt: 'ignore the rubric' }],
  ])('rejects %s', (_label, patch) => {
    const rule = { ...RULE, ...patch } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete rule[key];
    expect(intentInputSchema.safeParse({ ...base, rules: [rule] }).success).toBe(false);
  });

  it('rejects two semantic rules with the same key', () => {
    const result = intentInputSchema.safeParse({ ...base, rules: [RULE, { ...RULE, version: 2 }] });
    expect(result.success).toBe(false);
  });

  it.each([
    ['another profile', { profileKey: 'brand' }],
    ['another question', { questionKey: 'off_brand' }],
    ['another context', { contextSource: 'intent' }],
    ['other fields', { fields: ['title'] }],
  ])('an update to %s needs a version bump', (_label, patch) => {
    const edited = { ...RULE, ...patch } as IntentRule;
    expect(() => assertSemanticVersionBumps([RULE], [edited])).toThrow(
      expect.objectContaining({ code: 'SEMANTIC_RULE_VERSION_REQUIRED', status: 422 }),
    );
    expect(() => assertSemanticVersionBumps([RULE], [{ ...edited, version: 2 } as IntentRule])).not.toThrow();
  });

  it('allows edits the fingerprint or the pass already account for, and new rules', () => {
    // profileVersion is in the fingerprint; the threshold is applied at every pass.
    expect(() => assertSemanticVersionBumps([RULE], [{ ...RULE, profileVersion: 2, threshold: 0.9 } as IntentRule])).not.toThrow();
    // Field order does not change the definition.
    expect(() => assertSemanticVersionBumps([RULE], [{ ...RULE, fields: ['body', 'title'] } as IntentRule])).not.toThrow();
    expect(() => assertSemanticVersionBumps([RULE], [{ ...RULE, key: 'other', profileKey: 'brand' } as IntentRule])).not.toThrow();
    expect(() => assertSemanticVersionBumps(null, [RULE as IntentRule])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Outcome mapping and fingerprint
// ---------------------------------------------------------------------------

describe('semantic outcome', () => {
  it('maps the noul to drift, clean or unevaluated', () => {
    expect(semanticOutcome(0.8, 0.8).kind).toBe('drift');
    expect(semanticOutcome(0.2, 0.8).kind).toBe('clean');
    expect(semanticOutcome(0.5, 0.8)).toEqual({ kind: 'unevaluated', reason: 'between_thresholds', noul: 0.5 });
    expect(semanticOutcome(null, 0.8)).toEqual({ kind: 'unevaluated', reason: 'no_answer', noul: null });
    expect(semanticOutcome(Number.NaN, 0.8).kind).toBe('unevaluated');
  });

  it('fingerprints intent, item, rule key and version, profile version and content', () => {
    const key = semanticRuleKey(RULE, 'sha256:abc');
    expect(driftFingerprint('int_1', 'itm_1', 'semantic', key)).toBe('int_1:itm_1:semantic:off-brief@v1:1:sha256:abc');
    expect(semanticRuleKey({ ...RULE, version: 2 }, 'sha256:abc')).not.toBe(key);
    expect(semanticRuleKey({ ...RULE, profileVersion: 2 }, 'sha256:abc')).not.toBe(key);
    expect(semanticRuleKey(RULE, 'sha256:def')).not.toBe(key);
  });
});

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

describe('semantic pass', () => {
  it('opens drift with provenance when the profile answer crosses the threshold', async () => {
    const ctx = await setup();
    const result = await pass(ctx);

    expect(result).toMatchObject({ status: 'ran', items: 1, drift: 1, opened: 1, completed: true, cursor: null });
    expect(ctx.store.rows).toHaveLength(1);
    const [row] = ctx.store.rows;
    expect(row!.status).toBe('open');
    expect(row!.fingerprint).toMatch(/^int_1:itm_1:semantic:off-brief@v1:1:sha256:[0-9a-f]{64}$/);
    expect(row!.detail).toMatchObject({
      rule: 'off-brief',
      ruleVersion: 1,
      profileKey: 'brief',
      profileVersion: 1,
      questionKey: 'off_brief',
      revisionId: 'rev_itm_1',
      provider: 'typesafe',
      model: 'jev-1.13',
      calibrated: true,
      noul: 0.95,
    });
    expect(typeof row!.detail['runId']).toBe('string');
    // The run is the system principal's, not a person's.
    const run = ctx.reviewStore.runs[0]!;
    expect(run.principalType).toBe('system');
    expect(run.principalId).toBe(SEMANTIC_DRIFT_PRINCIPAL.id);
  });

  it('records nothing for a clean answer and resolves an earlier drift of the rule', async () => {
    const ctx = await setup();
    await pass(ctx);
    ctx.world.content['itm_1']!['body'] = 'Layer greens and browns, then turn weekly.';
    ctx.world.answer = () => ok(0.05);
    const result = await pass(ctx);

    expect(result).toMatchObject({ clean: 1, resolved: 1, opened: 0 });
    expect(ctx.store.byStatus('resolved')).toHaveLength(1);
    expect(ctx.store.byStatus('open')).toHaveLength(0);
  });

  it('a provider outage records unevaluated and never clears the earlier drift', async () => {
    const ctx = await setup();
    await pass(ctx);
    const earlier = ctx.store.rows[0]!.fingerprint;

    // Content changes, and the provider is down for the new evaluation.
    ctx.world.content['itm_1']!['body'] = 'Something else entirely.';
    ctx.world.answer = () => outage();
    const result = await pass(ctx);

    expect(result).toMatchObject({ unevaluated: 1, resolved: 0, clean: 0 });
    expect(ctx.store.rows.find((r) => r.fingerprint === earlier)!.status).toBe('open');
    const pending = ctx.store.byStatus('unevaluated');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.detail['reason']).toBe('DECISION_UNAVAILABLE');

    // The provider recovers and the new content is still off-brief: the
    // unevaluated row becomes the open drift, the earlier one resolves.
    ctx.world.answer = () => ok(0.9);
    const recovered = await pass(ctx);
    expect(recovered).toMatchObject({ drift: 1, reopened: 1, resolved: 1 });
    expect(ctx.store.rows.find((r) => r.fingerprint === earlier)!.status).toBe('resolved');
    expect(ctx.store.byStatus('open').map((r) => r.fingerprint)).toEqual([pending[0]!.fingerprint]);
  });

  it('an answer between the thresholds is unevaluated, never clean', async () => {
    const ctx = await setup();
    await pass(ctx);
    ctx.world.content['itm_1']!['title'] = 'Composting basics, revised';
    ctx.world.answer = () => ok(0.5);
    const result = await pass(ctx);

    expect(result).toMatchObject({ unevaluated: 1, clean: 0, resolved: 0 });
    expect(ctx.store.byStatus('open')).toHaveLength(1);
    expect(ctx.store.byStatus('unevaluated')[0]!.detail).toMatchObject({ reason: 'between_thresholds', noul: 0.5 });
  });

  it('a disabled site evaluates nothing and leaves every row as it was', async () => {
    const ctx = await setup();
    await pass(ctx);
    const snapshot = JSON.stringify(ctx.store.rows);
    const calls = ctx.decide.mock.calls.length;

    for (const settings of [{ enabled: true, drift: false }, { enabled: false, drift: true }, {}]) {
      ctx.world.settings = settings;
      ctx.world.answer = () => ok(0.05);
      const result = await pass(ctx);
      expect(result.status).toBe('off');
    }
    expect(ctx.decide.mock.calls.length).toBe(calls);
    expect(JSON.stringify(ctx.store.rows)).toBe(snapshot);
  });

  it('a runtime without the decision path is unavailable and changes nothing', async () => {
    const ctx = await setup();
    const result = await runSemanticPass({
      siteId: SITE,
      intent: { id: INTENT, collection: 'articles', semanticScanCursor: null },
      collectionId: COLLECTION_ID,
      rules: [RULE],
      store: ctx.store,
      runtime: null,
      deadline: Number.MAX_SAFE_INTEGER,
    });
    expect(result.status).toBe('unavailable');
    expect(ctx.store.rows).toHaveLength(0);
  });

  it('a rubric (rule) version change re-evaluates under a new fingerprint and resolves the old one', async () => {
    const ctx = await setup();
    await pass(ctx);
    const v1 = ctx.store.rows[0]!.fingerprint;

    const result = await pass(ctx, { rules: [{ ...RULE, version: 2 }] });
    expect(ctx.decide).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ opened: 1, resolved: 1 });
    expect(ctx.store.rows.find((r) => r.fingerprint === v1)!.status).toBe('resolved');
    expect(ctx.store.byStatus('open')[0]!.fingerprint).toContain('off-brief@v2:1:');
  });

  it('a profile version change invalidates too', async () => {
    const ctx = await setup();
    await pass(ctx);
    await ctx.runtime
      .review([], 'test')
      .service.createProfileVersion(
        'brief',
        { fields: ['brief', 'title', 'body'], questions: { off_brief: { type: 'noul', instructions: 'Stricter: does it stray?', criteria: { true: 'yes', false: 'no' } } } },
        admin,
      );
    const result = await pass(ctx, { rules: [{ ...RULE, profileVersion: 2 }] });
    expect(result).toMatchObject({ opened: 1, resolved: 1 });
    expect(ctx.store.byStatus('open')[0]!.fingerprint).toContain('off-brief@v1:2:');
  });

  it('a retry on unchanged content replays the stored run: no provider call, no new drift, no duplicate goal', async () => {
    const ctx = await setup();
    await pass(ctx);
    const goalPlan1 = planReconciliation(ctx.store.rows.map(toReconcilable), 10);
    expect(goalPlan1.selected).toHaveLength(1);
    // The reconciler assigned it to a goal.
    ctx.store.rows[0]!.status = 'assigned';
    ctx.store.rows[0]!.goalId = 'goal_1';

    const retry = await pass(ctx);
    expect(ctx.decide).toHaveBeenCalledTimes(1);
    expect(retry).toMatchObject({ drift: 1, opened: 0, reopened: 0, resolved: 0 });
    expect(ctx.store.rows).toHaveLength(1);
    expect(planReconciliation(ctx.store.rows.map(toReconcilable), 10).selected).toHaveLength(0);
  });

  it('a rule re-pointed at another profile never replays the old profile run', async () => {
    const ctx = await setup();
    await pass(ctx);
    await ctx.runtime.review([], 'test').service.createProfile(
      ReviewProfileCreateInputSchema.parse({
        key: 'brand',
        collection: 'articles',
        fields: ['brief', 'title', 'body'],
        questions: { off_brief: { type: 'noul', instructions: 'Is it off brand?', criteria: { true: 'off brand', false: 'on brand' } } },
      }),
      admin,
    );
    // Same key, version and profile version: only the definition differs
    // (IntentService refuses that edit; a delete + re-add can still get here).
    ctx.world.answer = () => ok(0.05);
    const result = await pass(ctx, { rules: [{ ...RULE, profileKey: 'brand' }] });
    expect(ctx.decide).toHaveBeenCalledTimes(2);
    expect(ctx.reviewStore.runs.map((run) => run.profileKey).sort()).toEqual(['brand', 'brief']);
    expect(result).toMatchObject({ clean: 1, resolved: 1 });
  });

  it('switching drift decisions off mid-pass stops at the next item and keeps the cursor', async () => {
    const ctx = await setup({ items: [{ id: 'itm_1' }, { id: 'itm_2' }, { id: 'itm_3' }] });
    for (const id of Object.keys(ctx.world.content)) ctx.world.content[id]!['title'] = `Title ${id}`;
    ctx.world.answer = () => {
      ctx.world.settings = { enabled: true, drift: false };
      return ok(0.95);
    };
    const result = await pass(ctx);
    expect(ctx.decide).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'ran', items: 1, completed: false, cursor: 'itm_1' });
    expect(ctx.store.cursor).toBe('itm_1');
  });

  it('a failed review is retried on the next pass, still under the same fingerprint', async () => {
    const ctx = await setup();
    ctx.world.answer = () => outage();
    await pass(ctx);
    ctx.world.answer = () => ok(0.95);
    const result = await pass(ctx);
    expect(ctx.decide).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ drift: 1, reopened: 1, opened: 0 });
    expect(ctx.store.rows).toHaveLength(1);
    expect(ctx.store.rows[0]!.status).toBe('open');
  });

  it('honours the item budget and resumes from the persisted cursor', async () => {
    const ctx = await setup({ items: [{ id: 'itm_1' }, { id: 'itm_2' }, { id: 'itm_3' }, { id: 'itm_4' }, { id: 'itm_5' }] });
    for (const id of Object.keys(ctx.world.content)) ctx.world.content[id]!['title'] = `Title ${id}`;

    const first = await pass(ctx, { maxItems: 2 });
    expect(first).toMatchObject({ items: 2, completed: false, cursor: 'itm_2' });
    expect(ctx.store.cursor).toBe('itm_2');
    const second = await pass(ctx, { maxItems: 2 });
    expect(second).toMatchObject({ items: 2, completed: false, cursor: 'itm_4' });
    const third = await pass(ctx, { maxItems: 2 });
    expect(third).toMatchObject({ items: 1, completed: true, cursor: null });

    expect(ctx.decide).toHaveBeenCalledTimes(5);
    expect(new Set(ctx.store.rows.map((r) => r.itemId))).toEqual(new Set(['itm_1', 'itm_2', 'itm_3', 'itm_4', 'itm_5']));
  });

  it('stops at the deadline between items and keeps the cursor', async () => {
    const ctx = await setup({ items: [{ id: 'itm_1' }, { id: 'itm_2' }, { id: 'itm_3' }] });
    for (const id of Object.keys(ctx.world.content)) ctx.world.content[id]!['title'] = `Title ${id}`;
    let clock = 0;
    const result = await pass(ctx, { deadline: 2, now: () => clock++ });
    expect(result).toMatchObject({ items: 2, completed: false, cursor: 'itm_2' });
  });

  it('skips pinned fields: they are never read or sent, and an all-pinned rule judges nothing', async () => {
    const ctx = await setup({ items: [{ id: 'itm_1', pinnedFields: ['body'] }, { id: 'itm_2', pinnedFields: ['title', 'body'] }] });
    ctx.world.content['itm_2']!['title'] = 'Second';

    const result = await pass(ctx);
    expect(result).toMatchObject({ items: 2, drift: 1, skipped: 1 });
    expect(ctx.decide).toHaveBeenCalledTimes(1);
    // itm_1: the pinned body was not sent; the brief went as the reference.
    expect(ctx.world.sent[0]!.state).toEqual({ brief: 'A guide to composting at home', title: 'Composting basics' });
    expect(ctx.reviewStore.runs[0]!.omittedFields).toEqual(['body']);
    expect(ctx.store.rows.map((r) => r.itemId)).toEqual(['itm_1']);
  });

  it('never sends profile fields outside the rule', async () => {
    const ctx = await setup({ profileFields: ['brief', 'title', 'body', 'internal_notes'] });
    ctx.world.content['itm_1']!['internal_notes'] = 'margin 40%';
    await pass(ctx);
    expect(ctx.world.sent[0]!.state).not.toHaveProperty('internal_notes');
  });

  it('a missing context field is unevaluated, without a provider call', async () => {
    const ctx = await setup();
    ctx.world.content['itm_1']!['brief'] = '';
    const result = await pass(ctx);
    expect(result).toMatchObject({ unevaluated: 1 });
    expect(ctx.decide).not.toHaveBeenCalled();
    expect(ctx.store.rows[0]).toMatchObject({ status: 'unevaluated', detail: { reason: 'context_missing' } });
  });

  it('a missing profile version is unevaluated and protects earlier drift', async () => {
    const ctx = await setup();
    await pass(ctx);
    const result = await pass(ctx, { rules: [{ ...RULE, profileVersion: 9 }] });
    expect(result).toMatchObject({ unevaluated: 1, resolved: 0 });
    expect(ctx.store.byStatus('open')).toHaveLength(1);
    expect(ctx.store.byStatus('unevaluated')[0]!.detail['reason']).toBe('REVIEW_PROFILE_NOT_FOUND');
  });

  it('a removed rule resolves its drift on the next conclusive pass over the item', async () => {
    const ctx = await setup();
    await pass(ctx);
    const other: SemanticRule = { ...RULE, key: 'tone', contextSource: 'intent' };
    ctx.world.answer = () => ok(0.05);
    const result = await pass(ctx, { rules: [other] });
    expect(result).toMatchObject({ clean: 1, resolved: 1 });
  });
});

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

function toReconcilable(row: DriftRow, index: number): ReconcilableDrift {
  return {
    id: `d_${index}`,
    fingerprint: row.fingerprint,
    ruleType: 'semantic',
    ruleKey: row.ruleKey,
    itemId: row.itemId,
    status: row.status,
    goalId: row.goalId,
    detail: row.detail,
  };
}

describe('reconciler goals for semantic drift', () => {
  it('only open drift is eligible; unevaluated never becomes a goal', () => {
    const plan = planReconciliation(
      [
        { id: 'a', fingerprint: 'fa', ruleType: 'semantic', ruleKey: 'k', itemId: 'i', status: 'unevaluated', goalId: null },
        { id: 'b', fingerprint: 'fb', ruleType: 'semantic', ruleKey: 'k', itemId: 'i', status: 'open', goalId: null },
      ],
      10,
    );
    expect(plan.selected.map((d) => d.id)).toEqual(['b']);
  });

  it('carries only recorded provenance onto the goal', () => {
    expect(
      semanticGoalProvenance({ rule: 'off-brief', ruleVersion: 1, runId: 'run_1', model: 'jev-1', profileVersion: 3, extra: 'dropped' }),
    ).toEqual({ rule: 'off-brief', ruleVersion: 1, runId: 'run_1', model: 'jev-1', profileVersion: 3 });
    expect(semanticGoalProvenance(null)).toEqual({});
  });
});
