import { beforeEach, describe, expect, it } from 'vitest';
import {
  decisionHarness,
  editorRef,
  PROFILE_KEY,
  SITE,
  type DecisionHarness,
} from '../../__tests__/helpers/flow-decision-harness';
import { MemoryAutomationActionStore } from '../../__tests__/helpers/memory-automation-store';
import { AUTOMATION_AUTONOMY_CAP } from '../ai-automation';
import {
  automationEnvelope,
  AutomationRevertError,
  FlowAutomationError,
  reconcileAutomationAction,
  revertAutomationAction,
  runAutomationNode,
  type AutomationNodeOutput,
  type AutomationRuntime,
  type GovernedWriteInput,
} from '../ai-automation-ops';
import type { HarnessExecutionResult } from '../ai-harness';
import { AUTONOMY_LEVELS, resolveAutonomy } from '../autonomy-service';
import type { EditorialState } from '../editorial-service';
import { runAiDecisionNode, type AiDecisionOutput } from '../flow-ai-decision';
import type { FlowNode, FlowRunContext } from '../flow-service';
import { ReviewService } from '../review-service';

/**
 * Flows metadata automation (J11, #518). The decision is produced by the real
 * `ai:decision` node over the J10 harness (real ReviewService + governed
 * decision path, fake upstream). The governed write is a stand-in for the
 * harness that applies the REAL autonomy resolver to the envelope the
 * operation builds, so the L1 cap is what decides, not the fake.
 */

let h: DecisionHarness;
let actions: MemoryAutomationActionStore;
let runtime: AutomationRuntime;
let item: { data: Record<string, unknown>; pinned: string[]; state: EditorialState; hidden: Set<string> };
let writes: GovernedWriteInput[];
let grantLevel: number | null;
let frozen: boolean;
let approvalSeq: number;

const GATE = { approvedBy: 'usr_admin', approvedAt: '2026-10-01T00:00:00Z', evidenceRef: 'eval/jev-benchmark/reports/v1/live/report.heldout.json' };
const THRESHOLD = { provider: 'typesafe', model: 'jev-1.13', profileVersion: 1, minConfidence: 0.8 };
const liveAutomation = (overrides: Record<string, unknown> = {}) => ({
  mode: 'live',
  thresholds: { vi: { tag: THRESHOLD, route: THRESHOLD } },
  gate: GATE,
  ...overrides,
});

function setAutomation(automation: unknown) {
  h.settings.value = { ...h.settings.value, automation };
}

const DECIDE_NODE: FlowNode = {
  id: 'decide',
  key: 'ai:decision',
  options: {},
  branches: { news: 'act', promo: 'act', unknown: 'act', error: 'act' },
};
const DECIDE_OPTIONS = { profileKey: PROFILE_KEY, profileVersion: 1, collection: 'posts', questionKey: 'category', minConfidence: 0.8 };
const TAG_NODE: FlowNode = { id: 'tag', key: 'ai:apply-tags', options: {} };
const ROUTE_NODE: FlowNode = { id: 'route', key: 'editorial:route', options: {} };

function envFor(flowRunId = 'flow_run_1'): Record<string, unknown> {
  return { runId: flowRunId, principal: editorRef };
}

async function decide(flowRunId = 'flow_run_1'): Promise<AiDecisionOutput> {
  const ctx: FlowRunContext = { input: { itemId: 'itm_1', locale: 'vi' }, steps: {}, env: envFor(flowRunId) };
  return runAiDecisionNode(ctx, DECIDE_OPTIONS, DECIDE_NODE, h.runtime);
}

function automationCtx(decision: AiDecisionOutput | null, flowRunId = 'flow_run_1'): FlowRunContext {
  return {
    input: { itemId: 'itm_1', locale: 'vi' },
    steps: decision ? { decide: decision, previous: decision } : {},
    env: envFor(flowRunId),
  };
}

const TAG_OPTIONS = { decisionNode: 'decide', collection: 'posts', tagField: 'tags', tagMap: { news: 'tin-tuc' } };
const ROUTE_OPTIONS = {
  decisionNode: 'decide',
  collection: 'posts',
  queueField: 'review_queue',
  queues: { news: 'newsdesk', promo: 'ads-review' },
  manualQueue: 'manual-triage',
  submitForReview: true,
};

async function tag(decision?: AiDecisionOutput | null, flowRunId = 'flow_run_1'): Promise<AutomationNodeOutput> {
  const d = decision === undefined ? await decide(flowRunId) : decision;
  return runAutomationNode('tag', automationCtx(d, flowRunId), TAG_OPTIONS, TAG_NODE, runtime);
}

async function route(decision?: AiDecisionOutput | null): Promise<AutomationNodeOutput> {
  const d = decision === undefined ? await decide() : decision;
  return runAutomationNode('route', automationCtx(d), ROUTE_OPTIONS, ROUTE_NODE, runtime);
}

const rowOf = (out: AutomationNodeOutput) => actions.rows.find((r) => r.id === out.actionId)!;

beforeEach(async () => {
  h = await decisionHarness();
  actions = new MemoryAutomationActionStore(h.store);
  item = { data: { tags: ['featured'], review_queue: null }, pinned: [], state: 'draft', hidden: new Set() };
  writes = [];
  grantLevel = null;
  frozen = false;
  approvalSeq = 0;
  h.content.latestRevisionId = async () => 'rev_1';
  let n = 0;
  runtime = {
    siteId: SITE,
    store: actions,
    newId: () => `act_${(n += 1)}`,
    resolveGrant: (ref) => h.runtime.resolveGrant(ref),
    readSettings: () => h.runtime.readSettings(),
    reviewRun: (permissionContext, principal, runId) =>
      h.runtime
        .reviewService(permissionContext, { db: undefined, siteId: SITE, requestId: null, principal: null })
        .getRun(runId, principal),
    async readTarget(_ctx, _collection, _itemId, field) {
      return {
        readable: !item.hidden.has(field),
        value: item.data[field],
        pinnedFields: item.pinned,
        editorialState: item.state,
      };
    },
    // Stand-in for AISecureHarness.execute('updateItem'): the real resolver
    // decides with the envelope the operation uses.
    async governedWrite(_ctx, _grant, _principal, input): Promise<HarnessExecutionResult> {
      if (frozen) return { status: 'denied', message: 'frozen: agent runtime is frozen for this site' };
      const envelope = automationEnvelope(input.title);
      const level = resolveAutonomy({ grantLevel, dangerous: false, intentCap: envelope.autonomyCap });
      if (level === AUTONOMY_LEVELS.SHADOW) return { status: 'denied', code: 'AUTONOMY_SHADOW', message: 'autonomy_shadow: L0' };
      if (level === AUTONOMY_LEVELS.PROPOSE) {
        approvalSeq += 1;
        return { status: 'pending_approval', agentApprovalId: `apr_${approvalSeq}`, runId: `agent_run_${approvalSeq}` };
      }
      writes.push(input);
      Object.assign(item.data, input.data);
      return { status: 'executed', runId: 'agent_run_direct' };
    },
  };
});

describe('shadow is the default and never mutates', () => {
  it('records the proposal without calling the governed write', async () => {
    const out = await tag();
    expect(out).toMatchObject({ mode: 'shadow', status: 'recorded', reason: 'mode_shadow', applied: false, replayed: false });
    expect(writes).toHaveLength(0);
    expect(approvalSeq).toBe(0);
    expect(item.data['tags']).toEqual(['featured']);
    expect(rowOf(out)).toMatchObject({
      action: 'tag',
      proposed: { field: 'tags', value: ['featured', 'tin-tuc'], target: 'tin-tuc' },
      previous: { field: 'tags', value: ['featured'] },
      confidence: 0.9,
      locale: 'vi',
    });
  });

  it('places a shadow proposal in the zone using the configured thresholds', async () => {
    setAutomation({ mode: 'shadow', thresholds: { vi: { tag: THRESHOLD } } });
    const out = await tag();
    expect(rowOf(out)).toMatchObject({ mode: 'shadow', status: 'recorded', inZone: true });
    expect(writes).toHaveLength(0);
  });
});

describe('live without a full gate is forced to shadow', () => {
  it.each([
    ['gate missing', liveAutomation({ gate: undefined }), 'gate_missing'],
    ['malformed block', { mode: 'live', thresholds: 'all' }, 'settings_malformed'],
    ['no threshold for the locale', liveAutomation({ thresholds: { en: { tag: THRESHOLD } } }), 'threshold_missing'],
    ['model mismatch', liveAutomation({ thresholds: { vi: { tag: { ...THRESHOLD, model: 'jev-2' } } } }), 'model_mismatch'],
    ['provider mismatch', liveAutomation({ thresholds: { vi: { tag: { ...THRESHOLD, provider: 'openrouter' } } } }), 'provider_mismatch'],
    ['profile version mismatch', liveAutomation({ thresholds: { vi: { tag: { ...THRESHOLD, profileVersion: 2 } } } }), 'profile_version_mismatch'],
  ])('%s', async (_name, automation, reason) => {
    setAutomation(automation);
    const out = await tag();
    expect(out).toMatchObject({ mode: 'shadow', status: 'recorded', reason });
    expect(writes).toHaveLength(0);
    expect(approvalSeq).toBe(0);
  });

  it('below the threshold stays shadow even with a full gate', async () => {
    setAutomation(liveAutomation({ thresholds: { vi: { tag: { ...THRESHOLD, minConfidence: 0.95 } } } }));
    const out = await tag();
    expect(out).toMatchObject({ mode: 'shadow', status: 'recorded', reason: 'below_threshold' });
    expect(rowOf(out).inZone).toBe(false);
    expect(approvalSeq).toBe(0);
  });
});

describe('live goes through the governed path, capped at L1', () => {
  beforeEach(() => setAutomation(liveAutomation()));

  it('pins the envelope to the L1 cap and the automation agent', () => {
    const envelope = automationEnvelope('t');
    expect(envelope).toEqual({ agentName: 'jev-automation', autonomyCap: 1, origin: 'automation', title: 't' });
    expect(AUTOMATION_AUTONOMY_CAP).toBe(AUTONOMY_LEVELS.PROPOSE);
  });

  it.each([null, 2, 3, 4])('a grant of %s creates an approval and writes nothing', async (level) => {
    grantLevel = level;
    const out = await tag();
    expect(out).toMatchObject({ mode: 'live', status: 'pending_approval', approvalId: 'apr_1', applied: false });
    expect(writes).toHaveLength(0);
    expect(item.data['tags']).toEqual(['featured']);
    expect(rowOf(out).agentRunId).toBe('agent_run_1');
  });

  it('an L0 grant is refused and writes nothing', async () => {
    grantLevel = 0;
    const out = await tag();
    expect(out).toMatchObject({ mode: 'live', status: 'denied', reason: 'AUTONOMY_SHADOW' });
    expect(writes).toHaveLength(0);
  });

  it('the kill switch denies the live proposal', async () => {
    frozen = true;
    const out = await tag();
    expect(out).toMatchObject({ mode: 'live', status: 'denied', reason: 'frozen' });
    expect(writes).toHaveLength(0);
  });

  it('proposes only the metadata field, never status', async () => {
    let seen: GovernedWriteInput | null = null;
    const inner = runtime.governedWrite;
    runtime.governedWrite = async (...args) => {
      seen = args[3];
      return inner(...args);
    };
    await tag();
    expect(seen).not.toBeNull();
    expect(Object.keys(seen!.data)).toEqual(['tags']);
    expect(seen!).not.toHaveProperty('status');
  });
});

describe('humans win: pins, overrides and stale content', () => {
  beforeEach(() => setAutomation(liveAutomation()));

  it('a pinned field is skipped and nothing is proposed', async () => {
    item.pinned = ['tags'];
    const out = await tag();
    expect(out).toMatchObject({ mode: 'shadow', status: 'skipped', reason: 'pinned' });
    expect(approvalSeq).toBe(0);
  });

  it('a decision the editor overrode is skipped', async () => {
    const decision = await decide();
    const reviews = new ReviewService({ store: h.store, siteId: SITE, content: h.content, decide: async () => { throw new Error('unused'); } });
    await reviews.submitFeedback(
      decision.runId!,
      { entries: [{ questionKey: 'category', verdict: 'edit', editedValue: 'promo' }] },
      { type: 'user', id: 'usr_editor', admin: false },
    );
    const out = await tag(decision);
    expect(out).toMatchObject({ status: 'skipped', reason: 'human_override' });
    expect(approvalSeq).toBe(0);
  });

  it('stale content (hash changed since the decision) is skipped and recorded', async () => {
    const decision = await decide();
    h.content.items['itm_1'] = { ...h.content.items['itm_1'], title: 'Edited after the decision' };
    const out = await tag(decision);
    expect(out).toMatchObject({ status: 'skipped', reason: 'stale:content_changed' });
    expect(rowOf(out).contentHash).toMatch(/^sha256:/);
    expect(approvalSeq).toBe(0);
  });

  it('a new revision since the decision is stale too', async () => {
    const decision = await decide();
    h.content.latestRevisionId = async () => 'rev_2';
    const out = await tag(decision);
    expect(out).toMatchObject({ status: 'skipped', reason: 'stale:revision_changed' });
  });

  it('an unreadable target field is skipped', async () => {
    item.hidden.add('tags');
    expect(await tag()).toMatchObject({ status: 'skipped', reason: 'field_not_readable' });
  });

  it('an already present tag is a noop', async () => {
    item.data['tags'] = ['tin-tuc'];
    expect(await tag()).toMatchObject({ status: 'noop', reason: 'already_applied' });
    expect(approvalSeq).toBe(0);
  });
});

describe('idempotency', () => {
  it('a redelivered job finds its row and proposes nothing twice', async () => {
    setAutomation(liveAutomation());
    const decision = await decide();
    const first = await tag(decision);
    const again = await tag(decision);
    expect(first).toMatchObject({ status: 'pending_approval', replayed: false });
    expect(again).toMatchObject({ actionId: first.actionId, status: 'pending_approval', replayed: true });
    expect(approvalSeq).toBe(1);
    expect(actions.rows).toHaveLength(1);
  });

  it('a shadow retry records one row', async () => {
    const decision = await decide();
    await tag(decision);
    expect(await tag(decision)).toMatchObject({ replayed: true });
    expect(actions.rows).toHaveLength(1);
  });

  it('another flow run is a separate action', async () => {
    await tag(undefined, 'flow_run_1');
    await tag(undefined, 'flow_run_2');
    expect(actions.rows).toHaveLength(2);
  });
});

describe('decision outcomes', () => {
  it('an unknown decision is skipped; routing suggests the manual queue but never live', async () => {
    setAutomation(liveAutomation());
    h.upstream.answers.category = { type: 'choice', choice: 'news', probabilities: { news: 0.5, promo: 0.5 }, confidence: 0.5 };
    const decision = await decide();
    expect(decision.branch).toBe('unknown');
    expect(await tag(decision)).toMatchObject({ status: 'skipped', reason: 'decision_unknown', mode: 'shadow' });
    const routed = await runAutomationNode('route', automationCtx(decision, 'flow_run_r'), ROUTE_OPTIONS, ROUTE_NODE, runtime);
    expect(routed).toMatchObject({ status: 'skipped', reason: 'decision_unknown', mode: 'shadow' });
    expect(rowOf(routed).proposed).toMatchObject({ value: 'manual-triage' });
    expect(approvalSeq).toBe(0);
  });

  it('an error branch is skipped as decision_error', async () => {
    const out = await tag({ branch: 'error', runId: null, replayed: false, decision: null, errorCode: 'DECISION_TIMEOUT' });
    expect(out).toMatchObject({ status: 'skipped', reason: 'decision_error' });
  });

  it('no upstream decision is skipped as decision_missing', async () => {
    expect(await tag(null)).toMatchObject({ status: 'skipped', reason: 'decision_missing' });
  });

  it('refuses a run without a principal', async () => {
    const ctx = automationCtx(await decide());
    ctx.env = { runId: 'flow_run_1' };
    await expect(runAutomationNode('tag', ctx, TAG_OPTIONS, TAG_NODE, runtime)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('the site switch stops the node at execution time', async () => {
    const decision = await decide();
    h.settings.value = { ...h.settings.value, flows: false };
    await expect(tag(decision)).rejects.toBeInstanceOf(FlowAutomationError);
    expect(actions.rows).toHaveLength(0);
  });

  it('a principal from another site does not resolve', async () => {
    const decision = await decide();
    const ctx = automationCtx(decision);
    ctx.env = { runId: 'flow_run_1', principal: { ...editorRef, siteId: 'site_other' } };
    await expect(runAutomationNode('tag', ctx, TAG_OPTIONS, TAG_NODE, runtime)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('routing', () => {
  it('proposes the queue and the submit_review transition when allowed, never publish', async () => {
    const out = await route();
    expect(rowOf(out).proposed).toEqual({
      field: 'review_queue',
      value: 'newsdesk',
      target: 'newsdesk',
      transition: 'submit_review',
      transitionAllowed: true,
    });
  });

  it('does not propose a transition the state machine forbids', async () => {
    item.state = 'published';
    const out = await route();
    expect(rowOf(out).proposed).toMatchObject({ transition: null, transitionAllowed: false });
  });
});

describe('reversal', () => {
  async function appliedAction() {
    setAutomation(liveAutomation());
    const out = await tag();
    // A human approves: the harness writes and marks the approval approved.
    Object.assign(item.data, { tags: ['featured', 'tin-tuc'] });
    actions.approvals.set(out.approvalId!, 'approved');
    return out;
  }

  const deps = () => ({
    store: actions,
    siteId: SITE,
    readField: async (_c: string, _i: string, field: string) => item.data[field],
    writeField: async (_c: string, _i: string, field: string, value: unknown) => {
      item.data[field] = value;
    },
  });

  it('reconciles an approved proposal to applied, then restores the prior value', async () => {
    const out = await appliedAction();
    const reconciled = await reconcileAutomationAction(actions, rowOf(out));
    expect(reconciled).toMatchObject({ status: 'applied', applied: true });
    const reverted = await revertAutomationAction(deps(), out.actionId, 'usr_admin');
    expect(reverted).toMatchObject({ status: 'reverted', applied: false, revertedBy: 'usr_admin' });
    expect(item.data['tags']).toEqual(['featured']);
    await expect(revertAutomationAction(deps(), out.actionId, 'usr_admin')).rejects.toMatchObject({
      code: 'AUTOMATION_ALREADY_REVERTED',
    });
  });

  it('keeps a later human edit instead of reverting over it', async () => {
    const out = await appliedAction();
    item.data['tags'] = ['edited-by-human'];
    await expect(revertAutomationAction(deps(), out.actionId, 'usr_admin')).rejects.toMatchObject({
      code: 'AUTOMATION_REVERT_CONFLICT',
    });
    expect(item.data['tags']).toEqual(['edited-by-human']);
  });

  it('refuses to revert a shadow or rejected action', async () => {
    const shadow = await tag();
    await expect(revertAutomationAction(deps(), shadow.actionId, 'usr_admin')).rejects.toBeInstanceOf(AutomationRevertError);
    setAutomation(liveAutomation());
    const live = await tag(undefined, 'flow_run_2');
    actions.approvals.set(live.approvalId!, 'rejected');
    await expect(revertAutomationAction(deps(), live.actionId, 'usr_admin')).rejects.toMatchObject({ code: 'AUTOMATION_NOT_APPLIED' });
    expect(rowOf(live).status).toBe('rejected');
  });

  it('puts the row back to applied when the restoring write fails', async () => {
    const out = await appliedAction();
    const failing = { ...deps(), writeField: async () => { throw new Error('write failed'); } };
    await expect(revertAutomationAction(failing, out.actionId, 'usr_admin')).rejects.toThrow('write failed');
    expect(rowOf(out)).toMatchObject({ status: 'applied', applied: true, revertedAt: null });
  });
});

describe('audit chain: input revision → review run → action → feedback', () => {
  it('links every step by id', async () => {
    const decision = await decide();
    const out = await tag(decision);
    const row = rowOf(out);
    const run = h.store.runs.find((r) => r.id === decision.runId)!;
    expect(row.reviewRunId).toBe(run.id);
    expect(row.revisionId).toBe('rev_1');
    expect(row.revisionId).toBe(run.revisionId);
    expect(row.contentHash).toBe(run.contentHash);
    expect(row.questionKey).toBe('category');
    expect(row).toMatchObject({ flowRunId: 'flow_run_1', nodeId: 'tag', profileKey: PROFILE_KEY, profileVersion: 1 });

    const reviews = new ReviewService({ store: h.store, siteId: SITE, content: h.content, decide: async () => { throw new Error('unused'); } });
    await reviews.submitFeedback(
      run.id,
      { entries: [{ questionKey: 'category', verdict: 'accept' }] },
      { type: 'user', id: 'usr_admin', admin: true },
    );
    const feedback = await actions.feedbackForRuns(SITE, [row.reviewRunId!]);
    expect(feedback).toEqual([expect.objectContaining({ runId: run.id, questionKey: row.questionKey, verdict: 'accept' })]);
    expect(await actions.feedbackForRuns('site_other', [row.reviewRunId!])).toEqual([]);
    expect(await actions.list('site_other', { limit: 10 })).toEqual([]);
  });
});
