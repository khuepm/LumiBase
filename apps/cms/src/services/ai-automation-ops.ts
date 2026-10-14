/**
 * Flows metadata automation operations (Jev J11, #518): `ai:apply-tags` and
 * `editorial:route`.
 *
 * Each node reads the output of an upstream `ai:decision` node and records one
 * action row for one item in `lumibase_ai_automation_actions`:
 *
 *   ai:apply-tags    add the chosen category (mapped by `tagMap`) to a tags
 *                    field (array of strings)
 *   editorial:route  set a routing field to the chosen queue (mapped by
 *                    `queues`); with `submitForReview`, the proposal names the
 *                    `submit_review` transition when `canTransition` allows it
 *
 * Shadow-first. The row is `recorded` and nothing is written unless
 * `resolveAutomationMode` says live and the decision is in the auto-action
 * zone. Even then the write goes through the governed harness
 * (`AISecureHarness.execute('updateItem')`) with:
 *
 *   - an ItemService bound to the run's principal (`itemServiceForPrincipal`):
 *     row/field RBAC and site scope are that principal's;
 *   - agent provenance on the revision, so fields a human pinned are refused
 *     (`PINNED_BY_HUMAN`);
 *   - `autonomyCap` = L1: whatever the `jev-automation` grant says, the write
 *     becomes an approval a human decides on, or is refused at L0;
 *   - the kill switch, keyed on the `jev-automation` agent.
 *
 * Never written: `status` (no publish/unpublish), deletes, schema. The
 * editorial state transition is proposed only; a human performs it from the
 * review queue.
 *
 * Skipped and recorded (nothing proposed): a stale decision (the item's
 * content hash or latest revision changed since the review run), a decision
 * a human already overrode (feedback `edit` / `reject`), a pinned or
 * unreadable target field, an `unknown` / `error` decision.
 *
 * Idempotent: the row is unique per (site, flow run, node, item). A
 * redelivered job returns the stored row and proposes nothing again.
 */

import { collections, items, type Database } from '@lumibase/database';
import type { ReviewRun } from '@lumibase/contracts/schemas';
import { formatSafeError } from '@lumibase/contracts/utils';
import type { CacheProvider, KeyProvider } from '@lumibase/runtime';
import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import {
  AUTOMATION_AGENT,
  AUTOMATION_AUTONOMY_CAP,
  automationThreshold,
  inAutoActionZone,
  parseAutomationSettings,
  resolveAutomationMode,
  type AutomationAction,
  type AutomationMode,
} from './ai-automation';
import {
  automationActionStoreFor,
  type AutomationActionRecord,
  type AutomationActionStore,
} from './ai-automation-store';
import type { HarnessExecutionResult } from './ai-harness';
import { flowDecisionsEnabled, type DecisionSiteSettings } from './decision-governance';
import {
  canTransition,
  editorialStateFromStatus,
  type EditorialState,
  type ItemStatus,
} from './editorial-service';
import type { AuthenticatedPrincipalRef } from './effective-capability-service';
import { aiDecisionRuntimeFromEnv, type AiDecisionOutput, type AiDecisionRecord } from './flow-ai-decision';
import type { FlowNode, FlowRunContext } from './flow-service';
import type { GovernedCapabilityResolution } from './governed-capabilities';
import { itemServiceForPrincipal } from './item-service-factory';
import type { MagicContext } from './permission-dsl';
import { reviewContentAccessForPrincipal } from './review-content-access';
import type { ReviewPrincipal } from './review-service';

export const APPLY_TAGS_OPERATION = 'ai:apply-tags';
export const ROUTE_OPERATION = 'editorial:route';

export class FlowAutomationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'FlowAutomationError';
    this.code = code;
  }
}

/** Why a row was skipped (nothing proposed). */
export type AutomationSkipReason =
  | 'decision_missing'
  | 'decision_error'
  | 'decision_unknown'
  | 'decision_incomplete'
  | 'stale'
  | 'human_override'
  | 'field_not_readable'
  | 'field_not_tags'
  | 'pinned'
  | 'no_route';

/** What the node returns into the flow run's steps. */
export interface AutomationNodeOutput {
  actionId: string;
  action: AutomationAction;
  mode: AutomationMode;
  status: string;
  reason: string | null;
  applied: boolean;
  approvalId: string | null;
  /** True when this execution found the row of an earlier delivery and did nothing. */
  replayed: boolean;
}

const tagKey = z.string().min(1).max(128);
const fieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'must be a field name');
const commonOptions = {
  /** Step id of the upstream `ai:decision` node; defaults to the previous step. */
  decisionNode: z.string().min(1).max(128).optional(),
  collection: z.string().min(1).max(128),
  itemId: z.string().min(1).max(128).optional(),
  /** Item locale used to pick the threshold; defaults to input.locale. */
  locale: z.string().min(2).max(35).optional(),
};

const applyTagsOptions = z
  .object({
    ...commonOptions,
    tagField: fieldName,
    /** Choice key → tag value. Unmapped keys use the choice key itself. */
    tagMap: z.record(tagKey, tagKey).optional(),
  })
  .strict();

const routeOptions = z
  .object({
    ...commonOptions,
    queueField: fieldName,
    /** Decision branch (choice key, or 'true'/'false' for a noul) → queue name. */
    queues: z.record(tagKey, tagKey).optional(),
    /** Queue proposed when the decision is `unknown` (recorded, never live). */
    manualQueue: tagKey.optional(),
    /** Propose the `submit_review` editorial transition when the state allows it. */
    submitForReview: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface AutomationTarget {
  /** False when the principal may not read the target field. */
  readable: boolean;
  value: unknown;
  pinnedFields: string[];
  editorialState: EditorialState;
}

export interface GovernedWriteInput {
  collection: string;
  itemId: string;
  data: Record<string, unknown>;
  title: string;
}

/** What the operations need from the platform; tests substitute it. */
export interface AutomationRuntime {
  siteId: string;
  store: AutomationActionStore;
  newId(): string;
  resolveGrant(principal: AuthenticatedPrincipalRef): Promise<GovernedCapabilityResolution>;
  readSettings(): Promise<DecisionSiteSettings>;
  /** The review run as the principal may see it, with staleness. */
  reviewRun(permissionContext: MagicContext, principal: ReviewPrincipal, runId: string): Promise<ReviewRun>;
  readTarget(permissionContext: MagicContext, collection: string, itemId: string, field: string): Promise<AutomationTarget>;
  /** The live write, through the governed harness at L1. */
  governedWrite(
    permissionContext: MagicContext,
    grant: GovernedCapabilityResolution,
    principal: AuthenticatedPrincipalRef,
    input: GovernedWriteInput,
  ): Promise<HarnessExecutionResult>;
}

/**
 * Governance envelope for an automation write. Exported so a test pins the L1
 * cap. The call site adds `requestedByPrincipal` itself, so the provenance
 * tripwire (`approval-provenance.wiring.test.ts`) can see it.
 */
export function automationEnvelope(title: string) {
  return {
    agentName: AUTOMATION_AGENT,
    autonomyCap: AUTOMATION_AUTONOMY_CAP,
    origin: 'automation',
    title,
  };
}

/** Site-scoped item metadata the RBAC read does not return: pins and editorial state. */
async function itemMeta(
  db: Database,
  siteId: string,
  collection: string,
  itemId: string,
): Promise<{ pinnedFields: string[]; editorialState: EditorialState } | null> {
  const [row] = await db
    .select({ pinnedFields: items.pinnedFields, editorialState: items.editorialState, status: items.status })
    .from(items)
    .innerJoin(collections, eq(collections.id, items.collectionId))
    .where(
      and(
        eq(items.siteId, siteId),
        eq(collections.siteId, siteId),
        eq(collections.name, collection),
        eq(items.id, itemId),
        isNull(items.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    pinnedFields: Array.isArray(row.pinnedFields) ? (row.pinnedFields as string[]) : [],
    editorialState: (row.editorialState as EditorialState | null) ?? editorialStateFromStatus(row.status as ItemStatus),
  };
}

/** Builds the runtime from the flow run environment (same inputs as `ai:decision`). */
export function automationRuntimeFromEnv(env: Record<string, unknown>): AutomationRuntime {
  const decisions = aiDecisionRuntimeFromEnv(env);
  const db = decisions.db!;
  const siteId = decisions.siteId;
  const cache = env['cache'] as CacheProvider | undefined;
  const keys = env['keys'] as KeyProvider | undefined;
  const processEnv = (env['processEnv'] ?? {}) as Record<string, string | undefined>;
  const encryptionKey = processEnv['ENCRYPTION_KEY'];
  const itemService = (permissionContext: MagicContext) =>
    itemServiceForPrincipal(
      { db, siteId, cache, userId: permissionContext.userId ?? null, keyProvider: keys, encryptionKey },
      permissionContext,
    );

  return {
    siteId,
    store: automationActionStoreFor(db),
    newId: uuidv7,
    resolveGrant: decisions.resolveGrant,
    readSettings: decisions.readSettings,
    reviewRun: (permissionContext, principal, runId) =>
      decisions
        .reviewService(permissionContext, { db, siteId, requestId: null, principal: null })
        .getRun(runId, principal),
    async readTarget(permissionContext, collection, itemId, field) {
      const access = reviewContentAccessForPrincipal({ db, permissionContext, cache, keys, encryptionKey });
      const read = await access.readItem(collection, itemId, [field]);
      const meta = await itemMeta(db, siteId, collection, itemId);
      if (!meta) throw new FlowAutomationError('ITEM_NOT_FOUND', `Item "${itemId}" not found.`);
      return {
        readable: !read.omittedFields.includes(field),
        value: read.values[field],
        pinnedFields: meta.pinnedFields,
        editorialState: meta.editorialState,
      };
    },
    async governedWrite(permissionContext, grant, principal, input) {
      // Lazy: the harness pulls in the whole skill registry.
      const { AISecureHarness } = await import('./ai-harness');
      const harness = new AISecureHarness({ db, siteId, itemService: itemService(permissionContext), keys, cache });
      return harness.execute(
        'updateItem',
        { collection: input.collection, id: input.itemId, data: input.data },
        grant.capabilities,
        input.title,
        // The run's principal is the requester: an approver later re-resolves
        // exactly these rights (#472), never the worker's.
        { ...automationEnvelope(input.title), requestedByPrincipal: { kind: 'principal', ref: principal } },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function principalOf(value: unknown): AuthenticatedPrincipalRef | null {
  if (!value || typeof value !== 'object') return null;
  const ref = value as Partial<AuthenticatedPrincipalRef> & Record<string, unknown>;
  if (typeof ref.siteId !== 'string') return null;
  if (ref.type === 'user' && typeof ref.userId === 'string') return ref as AuthenticatedPrincipalRef;
  if (ref.type === 'api_key' && typeof ref.apiKeyId === 'string') return ref as AuthenticatedPrincipalRef;
  if (ref.type === 'dev' && Array.isArray(ref.roles)) return ref as AuthenticatedPrincipalRef;
  return null;
}

function principalId(ref: AuthenticatedPrincipalRef): string {
  return ref.type === 'user' ? ref.userId : ref.type === 'api_key' ? ref.apiKeyId : 'dev';
}

function decisionOutputOf(value: unknown): AiDecisionOutput | null {
  if (!value || typeof value !== 'object') return null;
  const out = value as Partial<AiDecisionOutput>;
  if (typeof out.branch !== 'string') return null;
  if (out.runId !== null && typeof out.runId !== 'string') return null;
  return out as AiDecisionOutput;
}

/** Confidence of the decision: the choice confidence, or the noul side that won. */
function decisionConfidence(decision: AiDecisionRecord): number | null {
  if (decision.questionType === 'choice') return decision.confidence;
  if (typeof decision.value === 'number') return decision.value >= 0.5 ? decision.value : 1 - decision.value;
  return null;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Governance codes the harness returns as prose only. */
function denialReason(result: HarnessExecutionResult): string {
  if (result.code) return result.code;
  const message = result.message ?? 'denied';
  if (message.startsWith('frozen')) return 'frozen';
  if (message.startsWith('autonomy_shadow')) return 'AUTONOMY_SHADOW';
  if (message.includes('pinned by a human')) return 'PINNED_BY_HUMAN';
  if (message === 'Insufficient capabilities') return 'FORBIDDEN';
  return message.slice(0, 200);
}

function toOutput(row: AutomationActionRecord, replayed: boolean): AutomationNodeOutput {
  return {
    actionId: row.id,
    action: row.action as AutomationAction,
    mode: row.mode as AutomationMode,
    status: row.status,
    reason: row.reason,
    applied: row.applied,
    approvalId: row.approvalId,
    replayed,
  };
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

interface Proposal {
  field: string;
  value: unknown;
  /** Tag added / queue chosen. */
  target: string;
  transition?: 'submit_review' | null;
  transitionAllowed?: boolean;
}

export async function runAutomationNode(
  action: AutomationAction,
  ctx: FlowRunContext,
  rawOptions: Record<string, unknown>,
  node: FlowNode | undefined,
  runtimeOverride?: AutomationRuntime,
): Promise<AutomationNodeOutput> {
  const operation = action === 'tag' ? APPLY_TAGS_OPERATION : ROUTE_OPERATION;
  if (!node) throw new FlowAutomationError('DECISION_FLOW_MISCONFIGURED', `${operation} runs only as a node of a flow graph.`);

  const parsed = (action === 'tag' ? applyTagsOptions : routeOptions).safeParse(rawOptions);
  if (!parsed.success) {
    throw new FlowAutomationError(
      'VALIDATION',
      parsed.error.issues.map((i) => `${i.path.join('.') || 'options'}: ${i.message}`).join('; '),
    );
  }
  const options = parsed.data as z.infer<typeof applyTagsOptions> & z.infer<typeof routeOptions>;
  const field = action === 'tag' ? options.tagField : options.queueField;
  const itemId = options.itemId ?? (typeof ctx.input['itemId'] === 'string' ? (ctx.input['itemId'] as string) : null);
  if (!itemId) throw new FlowAutomationError('VALIDATION', `${operation} needs options.itemId or input.itemId.`);
  const locale = options.locale ?? (typeof ctx.input['locale'] === 'string' ? (ctx.input['locale'] as string) : null);

  const flowRunId = ctx.env['runId'];
  if (typeof flowRunId !== 'string' || flowRunId.length === 0) {
    throw new FlowAutomationError('DECISION_FLOW_MISCONFIGURED', `${operation} needs a flow run id for idempotency.`);
  }
  const principal = principalOf(ctx.env['principal']);
  if (!principal) {
    throw new FlowAutomationError(
      'FORBIDDEN',
      `This flow run has no principal to act for. ${operation} runs only in manual runs.`,
    );
  }

  const runtime = runtimeOverride ?? automationRuntimeFromEnv(ctx.env);

  // Who and whether, read now: a revoked grant or a disabled site stops queued runs too.
  const grant = await runtime.resolveGrant(principal);
  if (!grant.allowed || !grant.permissionContext) {
    throw new FlowAutomationError('FORBIDDEN', grant.message ?? 'The principal of this run could not be resolved.');
  }
  const permissionContext = grant.permissionContext;
  const settings = await runtime.readSettings();
  if (!flowDecisionsEnabled(settings)) {
    throw new FlowAutomationError('DECISION_DISABLED', 'Flow decisions are off for this site.');
  }
  const automation = parseAutomationSettings(settings);
  const reviewPrincipal: ReviewPrincipal = {
    type: principal.type,
    id: principalId(principal),
    admin: grant.controlPlaneAdmin,
  };

  const decision = decisionOutputOf(ctx.steps[options.decisionNode ?? 'previous']);
  const record = decision?.decision ?? null;
  const base = {
    id: runtime.newId(),
    siteId: runtime.siteId,
    flowRunId,
    nodeId: node.id,
    reviewRunId: decision?.runId ?? null,
    collection: options.collection,
    itemId,
    action,
    questionKey: record?.questionKey ?? null,
    locale,
    provider: record?.provider ?? null,
    model: record?.model ?? null,
    profileKey: record?.profileKey ?? null,
    profileVersion: record?.profileVersion ?? null,
    confidence: record ? decisionConfidence(record) : null,
    principalType: principal.type,
    principalId: principalId(principal),
  };

  const finish = async (
    status: string,
    reason: string | null,
    extra: { proposed?: Proposal | null; previous?: unknown; revisionId?: string | null; contentHash?: string | null; inZone?: boolean } = {},
  ): Promise<AutomationNodeOutput> => {
    const { row, created } = await runtime.store.claim({
      ...base,
      mode: 'shadow',
      status,
      reason,
      inZone: extra.inZone ?? false,
      proposed: extra.proposed ?? null,
      previous: extra.previous === undefined ? null : { field, value: extra.previous },
      revisionId: extra.revisionId ?? null,
      contentHash: extra.contentHash ?? null,
      applied: false,
    });
    return toOutput(row, !created);
  };

  // 1. The decision.
  if (!decision || !record || decision.runId === null) {
    return finish('skipped', decision?.branch === 'error' ? 'decision_error' : 'decision_missing');
  }
  if (decision.branch === 'error') return finish('skipped', 'decision_error');
  if (action === 'tag' && record.questionType !== 'choice') {
    throw new FlowAutomationError('VALIDATION', 'ai:apply-tags needs a choice decision.');
  }

  let run: ReviewRun;
  try {
    run = await runtime.reviewRun(permissionContext, reviewPrincipal, decision.runId);
  } catch (err) {
    if ((err as { code?: string }).code === 'REVIEW_RUN_NOT_FOUND') return finish('skipped', 'decision_missing');
    throw err;
  }
  const chain = { revisionId: run.revisionId, contentHash: run.contentHash };
  if (run.status !== 'success' && run.status !== 'abstained') return finish('skipped', 'decision_incomplete', chain);
  // 2. Freshness: never act on content that changed since the decision.
  if (run.stale) return finish('skipped', `stale:${run.staleReason ?? 'content_changed'}`, chain);

  // 3. A human already overrode this decision.
  const feedback = await runtime.store.feedbackForRuns(runtime.siteId, [run.id]);
  if (feedback.some((f) => f.questionKey === record.questionKey && (f.verdict === 'edit' || f.verdict === 'reject'))) {
    return finish('skipped', 'human_override', chain);
  }

  // 4. The target field, read as the principal.
  const target = await runtime.readTarget(permissionContext, options.collection, itemId, field);
  if (!target.readable) return finish('skipped', 'field_not_readable', chain);
  if (target.pinnedFields.includes(field)) return finish('skipped', 'pinned', { ...chain, previous: target.value });

  // 5. The proposal.
  const branch = decision.branch;
  let proposal: Proposal | null = null;
  if (action === 'tag') {
    const current = target.value === undefined || target.value === null ? [] : target.value;
    if (!Array.isArray(current) || current.some((v) => typeof v !== 'string')) {
      return finish('skipped', 'field_not_tags', { ...chain, previous: target.value });
    }
    if (branch === 'unknown') return finish('skipped', 'decision_unknown', { ...chain, previous: target.value });
    const tag = options.tagMap?.[String(record.value)] ?? String(record.value);
    const next = current.includes(tag) ? current : [...current, tag];
    proposal = { field, value: next, target: tag };
  } else {
    const queue = branch === 'unknown' ? options.manualQueue : (options.queues?.[branch] ?? (record.questionType === 'choice' ? String(record.value) : undefined));
    if (!queue) return finish('skipped', branch === 'unknown' ? 'decision_unknown' : 'no_route', { ...chain, previous: target.value });
    proposal = { field, value: queue, target: queue };
    if (options.submitForReview) {
      const allowed = canTransition(target.editorialState, 'submit_review');
      proposal.transition = allowed ? 'submit_review' : null;
      proposal.transitionAllowed = allowed;
    }
    // An unknown decision only ever suggests the manual queue.
    if (branch === 'unknown') {
      return finish('skipped', 'decision_unknown', { ...chain, proposed: proposal, previous: target.value });
    }
  }

  if (sameJson(proposal.value, target.value)) {
    return finish('noop', 'already_applied', { ...chain, proposed: proposal, previous: target.value });
  }

  // 6. Shadow or live.
  const facts = {
    action,
    locale,
    provider: run.provider,
    model: run.model,
    profileVersion: run.profileVersion,
  };
  const threshold = automationThreshold(automation, facts);
  const inZone = inAutoActionZone(base.confidence, threshold);
  const resolution = resolveAutomationMode(automation, facts);
  if (resolution.mode !== 'live' || !inZone) {
    const reason = resolution.mode === 'live' ? 'below_threshold' : resolution.reason;
    return finish('recorded', reason, { ...chain, proposed: proposal, previous: target.value, inZone });
  }

  // Live: claim first, so a redelivery finds the row and never proposes twice.
  const { row, created } = await runtime.store.claim({
    ...base,
    mode: 'live',
    status: 'pending',
    reason: null,
    inZone,
    proposed: proposal,
    previous: { field, value: target.value ?? null },
    revisionId: run.revisionId,
    contentHash: run.contentHash,
    applied: false,
  });
  if (!created) return toOutput(row, true);

  let result: HarnessExecutionResult;
  try {
    result = await runtime.governedWrite(permissionContext, grant, principal, {
      collection: options.collection,
      itemId,
      data: { [field]: proposal.value },
      title: `Jev automation: ${operation} ${options.collection}/${itemId}`,
    });
  } catch (err) {
    console.error('[flow:automation] governed write failed', formatSafeError(err));
    const failed = await runtime.store.update(runtime.siteId, row.id, { status: 'denied', reason: 'INTERNAL' });
    return toOutput(failed ?? row, false);
  }

  const patch =
    result.status === 'pending_approval'
      ? { status: 'pending_approval', approvalId: result.agentApprovalId ?? null, agentRunId: result.runId ?? null }
      : result.status === 'executed'
        ? { status: 'applied', applied: true, agentRunId: result.runId ?? null }
        : { status: 'denied', reason: denialReason(result), agentRunId: result.runId ?? null };
  const updated = await runtime.store.update(runtime.siteId, row.id, patch);
  return toOutput(updated ?? row, false);
}

// ---------------------------------------------------------------------------
// Approval outcome and revert
// ---------------------------------------------------------------------------

/**
 * Brings a live row up to date with its approval: `approved` (the harness sets
 * it only after the write succeeded) → `applied`; `rejected` → `rejected`;
 * `failed` → `denied`. Other rows are returned unchanged.
 */
export async function reconcileAutomationAction(
  store: AutomationActionStore,
  row: AutomationActionRecord,
): Promise<AutomationActionRecord> {
  if (row.status !== 'pending_approval' || !row.approvalId) return row;
  const status = await store.approvalStatus(row.siteId, row.approvalId);
  if (status === 'approved') return (await store.update(row.siteId, row.id, { status: 'applied', applied: true })) ?? row;
  if (status === 'rejected') return (await store.update(row.siteId, row.id, { status: 'rejected' })) ?? row;
  if (status === 'failed') return (await store.update(row.siteId, row.id, { status: 'denied', reason: 'approval_failed' })) ?? row;
  return row;
}

export type AutomationRevertErrorCode =
  | 'AUTOMATION_ACTION_NOT_FOUND'
  | 'AUTOMATION_NOT_APPLIED'
  | 'AUTOMATION_ALREADY_REVERTED'
  | 'AUTOMATION_REVERT_CONFLICT';

export class AutomationRevertError extends Error {
  constructor(
    readonly code: AutomationRevertErrorCode,
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
    this.name = 'AutomationRevertError';
  }
}

export interface AutomationRevertDeps {
  store: AutomationActionStore;
  siteId: string;
  /** Reads/writes as the caller (human provenance, the caller's RBAC). */
  readField(collection: string, itemId: string, field: string): Promise<unknown>;
  writeField(collection: string, itemId: string, field: string, value: unknown): Promise<void>;
  now?: () => Date;
}

/**
 * Restores `previous` of an applied action. Refused when the field no longer
 * holds what the action wrote (a human changed it since: their edit wins).
 * The row is claimed `reverted` before the write, so two reverts never both
 * write; a failed write puts it back to `applied`.
 */
export async function revertAutomationAction(
  deps: AutomationRevertDeps,
  id: string,
  actor: string,
): Promise<AutomationActionRecord> {
  const found = await deps.store.get(deps.siteId, id);
  if (!found) throw new AutomationRevertError('AUTOMATION_ACTION_NOT_FOUND', `Automation action "${id}" not found.`, 404);
  const row = await reconcileAutomationAction(deps.store, found);
  if (row.revertedAt || row.status === 'reverted') {
    throw new AutomationRevertError('AUTOMATION_ALREADY_REVERTED', 'This action was already reverted.', 409);
  }
  if (row.status !== 'applied' || !row.applied) {
    throw new AutomationRevertError(
      'AUTOMATION_NOT_APPLIED',
      `Only an applied action can be reverted; this one is ${row.mode}/${row.status}.`,
      409,
    );
  }
  const proposed = row.proposed as Proposal | null;
  const previous = row.previous as { field: string; value: unknown } | null;
  if (!proposed || !previous) {
    throw new AutomationRevertError('AUTOMATION_NOT_APPLIED', 'This action has no recorded previous value.', 409);
  }
  const current = await deps.readField(row.collection, row.itemId, previous.field);
  if (!sameJson(current, proposed.value)) {
    throw new AutomationRevertError(
      'AUTOMATION_REVERT_CONFLICT',
      `"${previous.field}" changed after the action was applied; the later edit is kept.`,
      409,
    );
  }
  const claimed = await deps.store.markReverted(deps.siteId, row.id, actor, (deps.now ?? (() => new Date()))());
  if (!claimed) throw new AutomationRevertError('AUTOMATION_ALREADY_REVERTED', 'This action was already reverted.', 409);
  try {
    await deps.writeField(row.collection, row.itemId, previous.field, previous.value);
  } catch (err) {
    await deps.store.update(deps.siteId, row.id, { status: 'applied', applied: true, revertedAt: null, revertedBy: null });
    throw err;
  }
  return claimed;
}
