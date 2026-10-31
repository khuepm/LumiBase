/**
 * Shadow metrics for Jev metadata automation (J11, #518).
 *
 * The question before any live switch: in the auto-action zone (confidence at
 * or above the locale/action threshold chosen on the J06 tune split), how
 * often would the proposal have been right, and how much of the work does the
 * zone cover?
 *
 *   precision  over in-zone proposals an editor gave a verdict on: `accept`,
 *              or `edit` to the same decision value (choice key / noul
 *              branch, not the tag or queue name), counts as right; `reject`
 *              or an `edit` to another value counts as wrong.
 *   coverage   in-zone proposals / decided items (proposals + abstentions).
 *
 * Only verdicts from signed-in users count (as in the J09 pilot): an API key
 * that accepts its own proposals adds no evidence. Zones are evaluated against
 * the CURRENT thresholds, and only for rows whose provider, model, profile
 * (key and version) and question match the threshold, so a precision is
 * always about the setup the threshold was measured for. Splits use the same
 * identity, so profiles that share a version number are never pooled.
 *
 * Below the pre-registered minimum a split is flagged `insufficientSample`
 * and `shadowRequired` stays true. The metrics never switch anything on: going
 * live is a separate admin decision recorded in `aiDecisions.automation.gate`.
 */

import {
  AUTOMATION_ACTIONS,
  automationThreshold,
  thresholdMismatch,
  type AutomationAction,
  type AutomationSettings,
  type AutomationThreshold,
} from './ai-automation';
import type { AutomationActionRecord, AutomationFeedbackRecord } from './ai-automation-store';
import { wilson, type Rate } from './review-metrics';

export const AUTOMATION_METRICS_PROTOCOL = {
  version: 'jev-automation-v1',
  minimums: {
    /** In-zone proposals with a user verdict, per split. */
    reviewedInZonePerSplit: 30,
    /** The same, over all splits. */
    reviewedInZone: 100,
  },
  /** A rate is conclusive only when its 95% Wilson half-width is at most this. */
  maxHalfWidth: 0.1,
} as const;

/** Statuses whose row carries a concrete proposal. */
const PROPOSAL_STATUSES = new Set(['recorded', 'noop', 'pending', 'pending_approval', 'applied', 'denied', 'rejected', 'reverted']);

export interface AutomationSplitMetrics {
  action: AutomationAction;
  locale: string | null;
  provider: string | null;
  model: string | null;
  profileKey: string | null;
  profileVersion: number | null;
  questionKey: string | null;
  threshold: number | null;
  /** Proposals plus `decision_unknown` abstentions. */
  decided: number;
  proposals: number;
  inZone: number;
  reviewedInZone: number;
  precision: Rate;
  coverage: Rate;
  insufficientSample: boolean;
}

export interface AutomationMetrics {
  protocol: typeof AUTOMATION_METRICS_PROTOCOL;
  window: { from: string; to: string };
  /** Rows by status, including skips, for context. */
  statusCounts: Record<string, number>;
  /** Rows whose provider/model/profile/question do not match the configured threshold. */
  excludedMismatch: number;
  splits: AutomationSplitMetrics[];
  overall: { reviewedInZone: number; precision: Rate; coverage: Rate; insufficientSample: boolean };
  /** True unless every split has enough reviewed in-zone samples. Always true without thresholds. */
  shadowRequired: boolean;
  /** True when more rows existed than were loaded. */
  truncated: boolean;
  note: string;
}

export const AUTOMATION_METRICS_NOTE =
  'Precision and coverage are measured in shadow. They do not switch automation on; going live is a separate admin decision with a gate record.';

interface ProposalValue {
  /** The decision value in the decision's vocabulary (choice key or noul branch). */
  choice?: unknown;
}

function thresholdFor(
  settings: AutomationSettings,
  row: AutomationActionRecord,
): { threshold: AutomationThreshold | null; mismatch: boolean } {
  const threshold = automationThreshold(settings, { action: row.action as AutomationAction, locale: row.locale });
  if (!threshold) return { threshold: null, mismatch: false };
  const mismatch = thresholdMismatch(threshold, row) !== null;
  return { threshold: mismatch ? null : threshold, mismatch };
}

/** Latest verdict per (run, question) from signed-in users. */
function latestVerdicts(feedback: readonly AutomationFeedbackRecord[]): Map<string, AutomationFeedbackRecord> {
  const out = new Map<string, AutomationFeedbackRecord>();
  for (const entry of feedback) {
    if (entry.principalType !== 'user') continue;
    const key = `${entry.runId}\u0000${entry.questionKey}`;
    const seen = out.get(key);
    if (!seen || seen.createdAt < entry.createdAt) out.set(key, entry);
  }
  return out;
}

function verdictCorrect(entry: AutomationFeedbackRecord, row: AutomationActionRecord): boolean | null {
  if (entry.verdict === 'accept') return true;
  if (entry.verdict === 'reject') return false;
  if (entry.verdict === 'edit') {
    // Feedback is per decision (run, question), shared by every action fed by
    // it, so an override is compared in the decision's vocabulary, never in a
    // tag or queue name.
    const choice = (row.proposed as ProposalValue | null)?.choice;
    if (typeof choice !== 'string') return null;
    return entry.editedValue === choice;
  }
  return null;
}

export function computeAutomationMetrics(input: {
  rows: readonly AutomationActionRecord[];
  feedback: readonly AutomationFeedbackRecord[];
  settings: AutomationSettings;
  window: { from: Date; to: Date };
  truncated?: boolean;
}): AutomationMetrics {
  const { rows, settings } = input;
  const verdicts = latestVerdicts(input.feedback);
  const statusCounts: Record<string, number> = {};
  let excludedMismatch = 0;

  type Acc = Omit<AutomationSplitMetrics, 'precision' | 'coverage' | 'insufficientSample'> & { correct: number };
  const splits = new Map<string, Acc>();

  for (const row of rows) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    if (!(AUTOMATION_ACTIONS as readonly string[]).includes(row.action)) continue;
    const isProposal = PROPOSAL_STATUSES.has(row.status) && row.proposed !== null;
    const abstained = row.status === 'skipped' && row.reason === 'decision_unknown';
    if (!isProposal && !abstained) continue;

    const { threshold, mismatch } = thresholdFor(settings, row);
    if (mismatch) {
      excludedMismatch += 1;
      continue;
    }
    const key = [row.action, row.locale, row.provider, row.model, row.profileKey, row.profileVersion, row.questionKey].join(
      '\u0000',
    );
    let acc = splits.get(key);
    if (!acc) {
      acc = {
        action: row.action as AutomationAction,
        locale: row.locale,
        provider: row.provider,
        model: row.model,
        profileKey: row.profileKey,
        profileVersion: row.profileVersion,
        questionKey: row.questionKey,
        threshold: threshold?.minConfidence ?? null,
        decided: 0,
        proposals: 0,
        inZone: 0,
        reviewedInZone: 0,
        correct: 0,
      };
      splits.set(key, acc);
    }
    acc.decided += 1;
    if (!isProposal) continue;
    acc.proposals += 1;
    const inZone = threshold !== null && row.confidence !== null && row.confidence >= threshold.minConfidence;
    if (!inZone) continue;
    acc.inZone += 1;
    const verdict = row.reviewRunId && row.questionKey ? verdicts.get(`${row.reviewRunId}\u0000${row.questionKey}`) : undefined;
    const correct = verdict ? verdictCorrect(verdict, row) : null;
    if (correct === null) continue;
    acc.reviewedInZone += 1;
    if (correct) acc.correct += 1;
  }

  const min = AUTOMATION_METRICS_PROTOCOL.minimums;
  const splitMetrics: AutomationSplitMetrics[] = [...splits.values()].map(({ correct, ...acc }) => ({
    ...acc,
    precision: wilson(correct, acc.reviewedInZone),
    coverage: wilson(acc.inZone, acc.decided),
    insufficientSample: acc.threshold === null || acc.reviewedInZone < min.reviewedInZonePerSplit,
  }));
  const totals = [...splits.values()].reduce(
    (sum, acc) => ({
      correct: sum.correct + acc.correct,
      reviewed: sum.reviewed + acc.reviewedInZone,
      inZone: sum.inZone + acc.inZone,
      decided: sum.decided + acc.decided,
    }),
    { correct: 0, reviewed: 0, inZone: 0, decided: 0 },
  );
  const overallInsufficient = totals.reviewed < min.reviewedInZone;

  return {
    protocol: AUTOMATION_METRICS_PROTOCOL,
    window: { from: input.window.from.toISOString(), to: input.window.to.toISOString() },
    statusCounts,
    excludedMismatch,
    splits: splitMetrics,
    overall: {
      reviewedInZone: totals.reviewed,
      precision: wilson(totals.correct, totals.reviewed),
      coverage: wilson(totals.inZone, totals.decided),
      insufficientSample: overallInsufficient,
    },
    shadowRequired: overallInsufficient || splitMetrics.length === 0 || splitMetrics.some((split) => split.insufficientSample),
    truncated: input.truncated ?? false,
    note: AUTOMATION_METRICS_NOTE,
  };
}
