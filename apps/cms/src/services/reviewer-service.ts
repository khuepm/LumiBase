import { activity, agentApprovals, agentGoals, agentRuns, agentToolCalls, settings } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { getContentOsFlags } from './feature-flags';

/**
 * Agent-as-reviewer (content-os task 11; Req 11.1-11.5).
 *
 * Below a per-site confidence threshold agents may decide approvals so
 * humans only see exceptions. Hard rules:
 * - global off switch: the `contentOs.agentReview` flag gates everything;
 * - capability: the reviewing caller needs `review:<domain>` for the
 *   approval's domain;
 * - no self-review: an approval belonging to goal-tree G can never be
 *   decided by a run inside G (Property 8) — colluding with yourself is
 *   not review;
 * - rejections and low-confidence approvals never finalize: they escalate
 *   to a human with a deep-link, the approval stays pending (Req 11.4).
 */

export const DEFAULT_REVIEW_MIN_CONFIDENCE = 0.8;
/** Walk guard: goal trees deeper than this are treated as one tree. */
const MAX_TREE_DEPTH = 32;

export interface AgentReviewConfig {
  enabled: boolean;
  /** Agents may finalize approvals at or above this confidence (0-1). */
  minConfidence: number;
}

export interface ReviewDecisionInput {
  approvalId: string;
  /** The reviewing agent's run — recorded as approverRunId. */
  reviewerRunId: string;
  decision: 'approved' | 'rejected';
  /** Reviewer self-reported confidence 0-1. */
  confidence: number;
  reason?: string;
  /** Capabilities of the credential the reviewer runs under. */
  capabilities: string[];
}

export type ReviewOutcome =
  | { outcome: 'decided'; status: 'approved'; approvalId: string }
  | { outcome: 'escalated'; reason: 'rejected' | 'low_confidence'; deepLink: string };

export class ReviewerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'ReviewerError';
  }
}

/**
 * Pure self-review predicate (Property 8) — two goal ancestry paths belong
 * to the same tree when they share any goal id. Exported for property tests.
 */
export function sharesGoalTree(pathA: readonly string[], pathB: readonly string[]): boolean {
  const a = new Set(pathA);
  return pathB.some((goalId) => a.has(goalId));
}

/**
 * Review domain for a subject (Req 11.2): schema-shaped tools need
 * `review:schema`, everything item-shaped needs `review:items`.
 * Exported pure for tests.
 */
export function reviewDomainFor(subjectType: string, toolName?: string): string {
  if (subjectType === 'plan') return 'plans';
  if (subjectType === 'artifact') return 'artifacts';
  if (toolName && /(collection|field|schema)/i.test(toolName)) return 'schema';
  return 'items';
}

export interface ReviewerServiceDeps {
  db: Database;
  siteId: string;
}

export class ReviewerService {
  constructor(private readonly deps: ReviewerServiceDeps) {}

  /** Per-site reviewer config: global flag + confidence threshold (Req 11.1/11.5). */
  async getConfig(): Promise<AgentReviewConfig> {
    const flags = await getContentOsFlags(this.deps.db, this.deps.siteId);
    const [row] = await this.deps.db
      .select()
      .from(settings)
      .where(and(eq(settings.siteId, this.deps.siteId), eq(settings.key, 'contentOs')))
      .limit(1);
    const value =
      row?.value && typeof row.value === 'object' && !Array.isArray(row.value)
        ? (row.value as Record<string, unknown>)
        : {};
    const raw = value['agentReviewMinConfidence'];
    const minConfidence =
      typeof raw === 'number' && raw >= 0 && raw <= 1 ? raw : DEFAULT_REVIEW_MIN_CONFIDENCE;
    return { enabled: flags.agentReview, minConfidence };
  }

  async decide(input: ReviewDecisionInput): Promise<ReviewOutcome> {
    const config = await this.getConfig();
    if (!config.enabled) {
      throw new ReviewerError(
        'AGENT_REVIEW_DISABLED',
        'Agent review is disabled for this site (contentOs.agentReview).',
        403,
      );
    }

    const [approval] = await this.deps.db
      .select()
      .from(agentApprovals)
      .where(
        and(eq(agentApprovals.id, input.approvalId), eq(agentApprovals.siteId, this.deps.siteId)),
      )
      .limit(1);
    if (!approval) {
      throw new ReviewerError('NOT_FOUND', 'Approval not found.', 404);
    }
    if (approval.status !== 'pending') {
      throw new ReviewerError('CONFLICT', 'Approval already processed.', 409);
    }
    if (approval.kind === 'veto') {
      // The veto window exists precisely to give HUMANS the last word.
      throw new ReviewerError('HUMAN_ONLY', 'Veto-window approvals require a human.', 403);
    }

    // Capability: review:<domain> (Req 11.2).
    const toolName =
      approval.subjectType === 'tool_call'
        ? await this.toolNameOf(approval.subjectId)
        : undefined;
    const domain = reviewDomainFor(approval.subjectType, toolName);
    const required = `review:${domain}`;
    if (!(input.capabilities.includes(required) || input.capabilities.includes('*'))) {
      throw new ReviewerError('FORBIDDEN', `Capability "${required}" is required.`, 403);
    }

    // No self-review (Req 11.3, Property 8): the reviewer's goal tree must
    // be disjoint from the subject's goal tree.
    const subjectPath = await this.goalPathOfRun(approval.runId);
    const reviewerPath = await this.goalPathOfRun(input.reviewerRunId);
    if (reviewerPath.length === 0) {
      throw new ReviewerError('NOT_FOUND', 'Reviewer run not found.', 404);
    }
    if (sharesGoalTree(subjectPath, reviewerPath)) {
      throw new ReviewerError(
        'SELF_REVIEW_FORBIDDEN',
        'An approval cannot be decided by a run inside its own goal tree.',
        403,
      );
    }

    // Rejections and low confidence escalate to a human (Req 11.4) — the
    // approval stays pending so the human decision path is untouched.
    const deepLink = `/agent/approvals/${approval.id}`;
    if (input.decision === 'rejected' || input.confidence < config.minConfidence) {
      const reason = input.decision === 'rejected' ? 'rejected' : 'low_confidence';
      await this.deps.db.insert(activity).values({
        siteId: this.deps.siteId,
        action: 'review.escalated',
        payload: {
          approvalId: approval.id,
          reviewerRunId: input.reviewerRunId,
          reason,
          confidence: input.confidence,
          comment: input.reason ?? null,
          deepLink,
        },
      });
      return { outcome: 'escalated', reason, deepLink };
    }

    await this.deps.db
      .update(agentApprovals)
      .set({
        status: 'approved',
        approverType: 'agent',
        approverRunId: input.reviewerRunId,
        decidedAt: new Date(),
        decisionReason: input.reason ?? `agent review (confidence ${input.confidence.toFixed(2)})`,
      })
      .where(
        and(eq(agentApprovals.id, approval.id), eq(agentApprovals.siteId, this.deps.siteId)),
      );
    return { outcome: 'decided', status: 'approved', approvalId: approval.id };
  }

  private async toolNameOf(toolCallId: string): Promise<string | undefined> {
    const [row] = await this.deps.db
      .select({ toolName: agentToolCalls.toolName })
      .from(agentToolCalls)
      .where(
        and(eq(agentToolCalls.id, toolCallId), eq(agentToolCalls.siteId, this.deps.siteId)),
      )
      .limit(1);
    return row?.toolName;
  }

  /** Goal ancestry (goal id up to the root) for a run, site-scoped. */
  private async goalPathOfRun(runId: string): Promise<string[]> {
    const [run] = await this.deps.db
      .select({ goalId: agentRuns.goalId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.deps.siteId)))
      .limit(1);
    if (!run) return [];

    const path: string[] = [];
    let cursor: string | null = run.goalId;
    while (cursor && path.length < MAX_TREE_DEPTH) {
      path.push(cursor);
      const [goal] = await this.deps.db
        .select({ parentGoalId: agentGoals.parentGoalId })
        .from(agentGoals)
        .where(and(eq(agentGoals.id, cursor), eq(agentGoals.siteId, this.deps.siteId)))
        .limit(1);
      cursor = goal?.parentGoalId ?? null;
    }
    return path;
  }
}
