/**
 * Draft-review pilot report (Jev J09, #516).
 *
 * Turns the JSON of `GET /api/v1/ai/reviews/metrics` into a versioned report:
 * the pre-registered criteria with their status, the human adjudication
 * result when one is supplied, and a go / no-go / insufficient-data decision.
 *
 * The report never invents a number. Without metrics it is a template with
 * every criterion `insufficient_sample`; without adjudication the decision
 * cannot be `go`. Lives outside `src/`, so none of it is in the Worker bundle.
 */
import {
  computeReviewMetrics,
  PILOT_PROTOCOL,
  wilson,
  type CriterionResult,
  type CriterionStatus,
  type ReviewMetrics,
} from '../../src/services/review-metrics';

export const PILOT_REPORT_VERSION = 1;

/** Human adjudication of a random sample of viewed suggestions, recorded outside the system. */
export interface Adjudication {
  /** Suggestions an adjudicator checked. */
  sampled: number;
  /** Of those, suggestions the adjudicator judged wrong. */
  errors: number;
  /** Number of independent adjudicators. */
  adjudicators?: number;
  note?: string;
}

export const ADJUDICATION_THRESHOLD = 0.1;

export type PilotDecision = 'go' | 'no_go' | 'insufficient_data';

export interface PilotReport {
  kind: 'jev-draft-review-pilot';
  reportVersion: typeof PILOT_REPORT_VERSION;
  protocolVersion: string;
  /** `template`: no metrics were supplied; nothing here is measured. */
  status: 'template' | 'measured';
  generatedAt: string;
  window: { from: string; to: string };
  sampleCounts: ReviewMetrics['sampleCounts'];
  minimums: ReviewMetrics['minimums'];
  insufficientSample: boolean;
  criteria: CriterionResult[];
  adjudication: (Omit<CriterionResult, 'id'> & { id: 'adjudicated_error_rate'; adjudicators: number | null }) | {
    id: 'adjudicated_error_rate';
    status: 'not_collected';
  };
  decision: PilotDecision;
  decisionReason: string;
  limitations: string[];
  metrics: ReviewMetrics | null;
}

export class PilotReportError extends Error {}

/** Accepts the endpoint body (`{ data }`) or the bare metrics object. */
export function parseMetricsJson(raw: unknown): ReviewMetrics {
  const value =
    typeof raw === 'object' && raw !== null && 'data' in raw ? (raw as { data: unknown }).data : raw;
  if (typeof value !== 'object' || value === null) throw new PilotReportError('Metrics JSON is not an object.');
  const m = value as Partial<ReviewMetrics>;
  if (m.protocolVersion !== PILOT_PROTOCOL.version) {
    throw new PilotReportError(
      `Metrics use protocol "${String(m.protocolVersion)}"; this report is for "${PILOT_PROTOCOL.version}". A different protocol is a different pilot.`,
    );
  }
  for (const key of ['window', 'sampleCounts', 'timePerItem', 'suggestions', 'operations', 'splits', 'criteria'] as const) {
    if (m[key] === undefined) throw new PilotReportError(`Metrics JSON is missing "${key}".`);
  }
  return m as ReviewMetrics;
}

function adjudicationResult(adjudication: Adjudication | undefined): PilotReport['adjudication'] {
  if (!adjudication) return { id: 'adjudicated_error_rate', status: 'not_collected' };
  const { sampled, errors } = adjudication;
  if (!Number.isInteger(sampled) || !Number.isInteger(errors) || sampled < 0 || errors < 0 || errors > sampled) {
    throw new PilotReportError('Adjudication needs integer sampled >= errors >= 0.');
  }
  const rate = wilson(errors, sampled);
  const base = {
    id: 'adjudicated_error_rate' as const,
    description: 'Upper 95% bound of the share of adjudicated viewed suggestions judged wrong is at most this.',
    threshold: ADJUDICATION_THRESHOLD,
    observed: rate.value,
    bound: rate.ci95?.high ?? null,
    sampleCount: sampled,
    adjudicators: adjudication.adjudicators ?? null,
  };
  let status: CriterionStatus;
  if (sampled < PILOT_PROTOCOL.minimums.adjudicated || rate.value === null || rate.ci95 === null) {
    status = 'insufficient_sample';
  } else if (rate.ci95.high <= ADJUDICATION_THRESHOLD) {
    status = 'pass';
  } else {
    status = rate.value <= ADJUDICATION_THRESHOLD ? 'inconclusive' : 'fail';
  }
  return { ...base, status };
}

const LIMITATIONS = [
  'Sessions measure editor time from opening the editor to the first save; time spent elsewhere is not seen.',
  'Baseline and assisted samples are compared as groups, not paired per item or editor.',
  'Accept/edit/reject rates count only suggestions rendered to the editor; feedback sent without a viewing session is excluded.',
  'Run and API-call counts are operational denominators, not user value. Only signed-in users record sessions; API-key and dev-principal sessions and verdicts are excluded.',
  'Sessions are reported by the editor client and not de-duplicated per editor or item; check the distinct editor and item counts before reading a minimum as met.',
  'time_reduction compares two medians as a point estimate, with no confidence interval; treat a ratio near the threshold as unresolved.',
  'Provider probabilities are not correctness probabilities unless the provider is calibrated on this data.',
];

export function buildPilotReport(
  metrics: ReviewMetrics | null,
  options: { adjudication?: Adjudication; now?: Date; window?: { from: Date; to: Date } } = {},
): PilotReport {
  const now = options.now ?? new Date();
  const template = metrics === null;
  const window = options.window ?? { from: new Date(now.getTime() - 30 * 86_400_000), to: now };
  const m = metrics ?? computeReviewMetrics({ sessions: [], runs: [], feedback: [], window, now });
  const adjudication = adjudicationResult(options.adjudication);

  const statuses: CriterionStatus[] = m.criteria.map((c) => c.status);
  let decision: PilotDecision;
  let decisionReason: string;
  if (template) {
    decision = 'insufficient_data';
    decisionReason = 'Template: no pilot data was supplied.';
  } else if (statuses.includes('fail') || adjudication.status === 'fail') {
    decision = 'no_go';
    decisionReason = 'At least one pre-registered criterion failed on a sufficient sample.';
  } else if (m.truncated) {
    decision = 'insufficient_data';
    decisionReason = 'The metrics hit the row limit; narrow the window so every row is counted.';
  } else if (adjudication.status === 'not_collected') {
    decision = 'insufficient_data';
    decisionReason = 'No human adjudication was recorded, so error detection is unmeasured.';
  } else if (statuses.every((s) => s === 'pass') && adjudication.status === 'pass') {
    decision = 'go';
    decisionReason = 'Every pre-registered criterion passed on at least the minimum sample.';
  } else {
    decision = 'insufficient_data';
    decisionReason = 'Some criteria are below the minimum sample or their interval straddles the threshold.';
  }

  return {
    kind: 'jev-draft-review-pilot',
    reportVersion: PILOT_REPORT_VERSION,
    protocolVersion: m.protocolVersion,
    status: template ? 'template' : 'measured',
    generatedAt: now.toISOString(),
    window: m.window,
    sampleCounts: m.sampleCounts,
    minimums: m.minimums,
    insufficientSample: m.insufficientSample,
    criteria: m.criteria,
    adjudication,
    decision,
    decisionReason,
    limitations: LIMITATIONS,
    metrics: template ? null : m,
  };
}

function fmt(value: number | null, id: string): string {
  if (value === null) return '—';
  if (id === 'latency_p95') return `${Math.round(value)} ms`;
  return value.toFixed(3);
}

export function renderPilotReportMarkdown(report: PilotReport): string {
  const lines: string[] = [];
  lines.push(`# Jev draft-review pilot report (${report.protocolVersion})`, '');
  if (report.status === 'template') {
    lines.push('> **Template — no measured results.** Every value below is empty until real pilot data is supplied.', '');
  }
  lines.push(
    `- Report version: ${report.reportVersion}`,
    `- Generated: ${report.generatedAt}`,
    `- Window: ${report.window.from} → ${report.window.to}`,
    `- Decision: **${report.decision}** — ${report.decisionReason}`,
    '',
    '## Sample counts',
    '',
    '| Sample | Count | Pre-registered minimum |',
    '|---|---|---|',
    `| Baseline sessions | ${report.sampleCounts.baselineSessions} | ${report.minimums.sessionsPerMode} |`,
    `| Assisted sessions | ${report.sampleCounts.assistedSessions} | ${report.minimums.sessionsPerMode} |`,
    `| Viewed suggestions | ${report.sampleCounts.viewedSuggestions} | ${report.minimums.viewedSuggestions} |`,
    `| Completed runs | ${report.sampleCounts.completedRuns} | ${report.minimums.completedRuns} |`,
    `| Idle sessions excluded | ${report.sampleCounts.idleSessionsExcluded} | — |`,
    `| Distinct editors (baseline / assisted) | ${report.sampleCounts.distinctEditors.baseline} / ${report.sampleCounts.distinctEditors.assisted} | — |`,
    `| Distinct items (baseline / assisted) | ${report.sampleCounts.distinctItems.baseline} / ${report.sampleCounts.distinctItems.assisted} | — |`,
    '',
    '## Criteria',
    '',
    '| Criterion | Threshold | Observed | Bound | n | Status |',
    '|---|---|---|---|---|---|',
  );
  for (const c of report.criteria) {
    lines.push(`| ${c.id} | ${fmt(c.threshold, c.id)} | ${fmt(c.observed, c.id)} | ${fmt(c.bound, c.id)} | ${c.sampleCount} | ${c.status} |`);
  }
  const a = report.adjudication;
  lines.push(
    a.status === 'not_collected'
      ? '| adjudicated_error_rate | 0.100 | — | — | 0 | not_collected |'
      : `| adjudicated_error_rate | ${fmt(a.threshold, a.id)} | ${fmt(a.observed, a.id)} | ${fmt(a.bound, a.id)} | ${a.sampleCount} | ${a.status} |`,
    '',
    '## Limitations',
    '',
    ...report.limitations.map((l) => `- ${l}`),
    '',
  );
  return lines.join('\n');
}
