/**
 * Draft-review pilot metrics (Jev J09, #516).
 *
 * The pilot asks whether draft review makes editors faster without making
 * them accept bad suggestions. User value is measured from two sources only:
 *
 *   - editor sessions (`lumibase_review_sessions`): time from opening the
 *     editor to the first save, in `baseline` (panel hidden) and `assisted`
 *     (panel shown) mode;
 *   - feedback on suggestions the editor actually **viewed** (the session's
 *     `run_id` + `viewed_questions`). Feedback sent for a suggestion nobody
 *     was shown — e.g. straight through the API — is not counted.
 *
 * Run and API-call counts appear only as operational denominators (coverage,
 * errors, latency, tokens). They are never reported as user value.
 *
 * The success criteria and minimum samples below are pre-registered: they are
 * fixed before data is collected and versioned with {@link PILOT_PROTOCOL}.
 * Changing them means a new protocol version, not a re-read of the same data.
 */

import { reviewFeedback, reviewRuns, reviewSessions, type Database } from '@lumibase/database';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Pre-registered protocol
// ---------------------------------------------------------------------------

export type PilotCriterionId = 'time_reduction' | 'rejection_rate' | 'coverage' | 'error_rate' | 'latency_p95';

export interface PilotCriterion {
  id: PilotCriterionId;
  description: string;
  threshold: number;
}

export const PILOT_PROTOCOL = {
  version: 'jev-pilot-v1',
  /** Below these counts a result is reported but flagged `insufficientSample`. */
  minimums: {
    /** Real review sessions per mode (baseline and assisted each). */
    sessionsPerMode: 100,
    /** Suggestions rendered to editors in assisted sessions. */
    viewedSuggestions: 100,
    /** Runs that ended `success`, `abstained` or `error`. */
    completedRuns: 100,
    /** Each locale / provider / profile-version split. */
    perSplit: 30,
    /** Suggestions checked by a human adjudicator (report only). */
    adjudicated: 50,
  },
  /** Acceptable error: a rate is conclusive only when its 95% Wilson half-width is at most this. */
  maxHalfWidth: 0.1,
  /** Sessions longer than this are treated as idle and excluded from time metrics (reported as a count). */
  idleSessionMs: 2 * 3_600_000,
  criteria: [
    {
      id: 'time_reduction',
      description: 'Median assisted time per item is at most this fraction of the median baseline time.',
      threshold: 0.8,
    },
    {
      id: 'rejection_rate',
      description: 'Upper 95% bound of the reject rate over viewed suggestions is at most this.',
      threshold: 0.3,
    },
    {
      id: 'coverage',
      description: 'Lower 95% bound of the share of completed runs that did not abstain is at least this.',
      threshold: 0.8,
    },
    {
      id: 'error_rate',
      description: 'Upper 95% bound of the share of finished runs that errored is at most this.',
      threshold: 0.1,
    },
    {
      id: 'latency_p95',
      description: 'p95 provider latency of completed runs, in milliseconds, is at most this.',
      threshold: 10_000,
    },
  ] satisfies PilotCriterion[],
} as const;

export const USER_VALUE_NOTE =
  'User value is editor time and verdicts on viewed suggestions. Run and API-call counts are operational denominators only.';

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

const Z_95 = 1.959963984540054;

export interface Rate {
  k: number;
  n: number;
  /** k / n, or null when n is 0. */
  value: number | null;
  /** 95% Wilson score interval, or null when n is 0. */
  ci95: { low: number; high: number } | null;
}

export function wilson(k: number, n: number): Rate {
  if (n <= 0) return { k, n, value: null, ci95: null };
  const p = k / n;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, value: p, ci95: { low: Math.max(0, centre - half), high: Math.min(1, centre + half) } };
}

/** Nearest-rank percentile (`p` in 0..1); null for an empty sample. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1]!;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface MetricsSession {
  mode: string;
  durationMs: number;
  locale: string | null;
  runId: string | null;
  viewedQuestions: unknown;
  principalId: string;
}

export interface MetricsRun {
  id: string;
  status: string;
  provider: string | null;
  profileKey: string;
  profileVersion: number;
  latencyMs: number | null;
  usage: unknown;
}

export interface MetricsFeedback {
  runId: string;
  questionKey: string;
  verdict: string;
  principalId: string;
}

export interface ReviewMetricsInput {
  /** Sessions created in the window. */
  sessions: readonly MetricsSession[];
  /** Runs created in the window (operations). */
  runs: readonly MetricsRun[];
  /** Runs referenced by viewed sessions but created before the window (lookups only). */
  referencedRuns?: readonly MetricsRun[];
  /** Feedback on the runs referenced by sessions. */
  feedback: readonly MetricsFeedback[];
  window: { from: Date; to: Date };
  truncated?: boolean;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface TimeStats {
  sessions: number;
  p50Ms: number | null;
  p95Ms: number | null;
  meanMs: number | null;
  insufficientSample: boolean;
}

export interface SuggestionStats {
  /** Distinct (run, question) suggestions rendered to the editor. */
  viewed: number;
  accept: Rate;
  edit: Rate;
  reject: Rate;
  /** Viewed with no verdict from the viewing editor. */
  noAction: Rate;
  insufficientSample: boolean;
}

export interface OperationStats {
  /** Operational denominator — not user value. */
  runs: number;
  success: number;
  abstained: number;
  error: number;
  running: number;
  /** Completed runs (success + abstained) that did not abstain. */
  coverage: Rate;
  abstention: Rate;
  /** Finished runs (success + abstained + error) that errored. */
  errorRate: Rate;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  tokensPerRun: { mean: number | null; p50: number | null; runsWithUsage: number; runsWithoutUsage: number };
  insufficientSample: boolean;
}

export interface LocaleSplit {
  sampleCount: number;
  insufficientSample: boolean;
  timePerItem: { baseline: TimeStats; assisted: TimeStats };
  suggestions: SuggestionStats;
}

export interface RunSplit {
  sampleCount: number;
  insufficientSample: boolean;
  operations: OperationStats;
  suggestions: SuggestionStats;
}

export type CriterionStatus = 'pass' | 'fail' | 'inconclusive' | 'insufficient_sample';

export interface CriterionResult {
  id: PilotCriterionId;
  description: string;
  threshold: number;
  observed: number | null;
  /** The bound compared with the threshold (Wilson bound for rates). */
  bound: number | null;
  sampleCount: number;
  status: CriterionStatus;
}

export interface ReviewMetrics {
  protocolVersion: string;
  generatedAt: string;
  window: { from: string; to: string };
  note: string;
  truncated: boolean;
  sampleCounts: {
    baselineSessions: number;
    assistedSessions: number;
    idleSessionsExcluded: number;
    viewedSuggestions: number;
    completedRuns: number;
  };
  minimums: (typeof PILOT_PROTOCOL)['minimums'];
  /** True while any pre-registered minimum is unmet. */
  insufficientSample: boolean;
  timePerItem: { baseline: TimeStats; assisted: TimeStats; assistedToBaselineP50: number | null };
  suggestions: SuggestionStats;
  operations: OperationStats;
  splits: {
    byLocale: Record<string, LocaleSplit>;
    byProvider: Record<string, RunSplit>;
    byProfileVersion: Record<string, RunSplit>;
  };
  criteria: CriterionResult[];
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const UNKNOWN = 'unknown';

function timeStats(durations: readonly number[], minimum: number): TimeStats {
  return {
    sessions: durations.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    meanMs: mean(durations),
    insufficientSample: durations.length < minimum,
  };
}

interface ViewedSuggestion {
  runId: string;
  questionKey: string;
  locale: string;
  verdict: string | null;
}

function suggestionStats(viewed: readonly ViewedSuggestion[], minimum: number): SuggestionStats {
  const n = viewed.length;
  const count = (verdict: string | null) => viewed.filter((v) => v.verdict === verdict).length;
  return {
    viewed: n,
    accept: wilson(count('accept'), n),
    edit: wilson(count('edit'), n),
    reject: wilson(count('reject'), n),
    noAction: wilson(count(null), n),
    insufficientSample: n < minimum,
  };
}

function tokensOf(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const { inputTokens, outputTokens } = usage as { inputTokens?: unknown; outputTokens?: unknown };
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return null;
  return inputTokens + outputTokens;
}

function operationStats(runs: readonly MetricsRun[], minimum: number): OperationStats {
  const by = (status: string) => runs.filter((r) => r.status === status).length;
  const success = by('success');
  const abstained = by('abstained');
  const error = by('error');
  const completed = runs.filter((r) => r.status === 'success' || r.status === 'abstained');
  const latencies = completed.map((r) => r.latencyMs).filter((v): v is number => typeof v === 'number');
  const tokens = completed.map((r) => tokensOf(r.usage));
  const known = tokens.filter((v): v is number => v !== null);
  return {
    runs: runs.length,
    success,
    abstained,
    error,
    running: by('running'),
    coverage: wilson(success, success + abstained),
    abstention: wilson(abstained, success + abstained),
    errorRate: wilson(error, success + abstained + error),
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    tokensPerRun: {
      mean: mean(known),
      p50: percentile(known, 0.5),
      runsWithUsage: known.length,
      runsWithoutUsage: tokens.length - known.length,
    },
    insufficientSample: success + abstained + error < minimum,
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

const profileVersionKey = (run: MetricsRun) => `${run.profileKey}@v${run.profileVersion}`;

function rateCriterion(
  criterion: PilotCriterion,
  rate: Rate,
  minimum: number,
  direction: 'max' | 'min',
): CriterionResult {
  const base = { id: criterion.id, description: criterion.description, threshold: criterion.threshold, sampleCount: rate.n };
  if (rate.n < minimum || rate.value === null || rate.ci95 === null) {
    return { ...base, observed: rate.value, bound: null, status: 'insufficient_sample' };
  }
  const bound = direction === 'max' ? rate.ci95.high : rate.ci95.low;
  const halfWidth = (rate.ci95.high - rate.ci95.low) / 2;
  const meets = direction === 'max' ? bound <= criterion.threshold : bound >= criterion.threshold;
  const pointMeets = direction === 'max' ? rate.value <= criterion.threshold : rate.value >= criterion.threshold;
  let status: CriterionStatus;
  if (meets) status = halfWidth <= PILOT_PROTOCOL.maxHalfWidth ? 'pass' : 'inconclusive';
  else status = pointMeets ? 'inconclusive' : 'fail';
  return { ...base, observed: rate.value, bound, status };
}

function criterionById(id: PilotCriterionId): PilotCriterion {
  return PILOT_PROTOCOL.criteria.find((c) => c.id === id)!;
}

export function evaluatePilotCriteria(metrics: Omit<ReviewMetrics, 'criteria'>): CriterionResult[] {
  const min = PILOT_PROTOCOL.minimums;
  const time = criterionById('time_reduction');
  const { baseline, assisted, assistedToBaselineP50 } = metrics.timePerItem;
  const timeSample = Math.min(baseline.sessions, assisted.sessions);
  const timeResult: CriterionResult = {
    id: time.id,
    description: time.description,
    threshold: time.threshold,
    observed: assistedToBaselineP50,
    bound: assistedToBaselineP50,
    sampleCount: timeSample,
    status:
      timeSample < min.sessionsPerMode || assistedToBaselineP50 === null
        ? 'insufficient_sample'
        : assistedToBaselineP50 <= time.threshold
          ? 'pass'
          : 'fail',
  };

  const ops = metrics.operations;
  const latency = criterionById('latency_p95');
  const latencyResult: CriterionResult = {
    id: latency.id,
    description: latency.description,
    threshold: latency.threshold,
    observed: ops.latencyP95Ms,
    bound: ops.latencyP95Ms,
    sampleCount: ops.success + ops.abstained,
    status:
      ops.success + ops.abstained < min.completedRuns || ops.latencyP95Ms === null
        ? 'insufficient_sample'
        : ops.latencyP95Ms <= latency.threshold
          ? 'pass'
          : 'fail',
  };

  return [
    timeResult,
    rateCriterion(criterionById('rejection_rate'), metrics.suggestions.reject, min.viewedSuggestions, 'max'),
    rateCriterion(criterionById('coverage'), ops.coverage, min.completedRuns, 'min'),
    rateCriterion(criterionById('error_rate'), ops.errorRate, min.completedRuns, 'max'),
    latencyResult,
  ];
}

/** Pure aggregation over loaded rows. Every input must already be scoped to one site. */
export function computeReviewMetrics(input: ReviewMetricsInput): ReviewMetrics {
  const min = PILOT_PROTOCOL.minimums;
  const runsById = new Map<string, MetricsRun>();
  for (const run of input.referencedRuns ?? []) runsById.set(run.id, run);
  for (const run of input.runs) runsById.set(run.id, run);

  const active = input.sessions.filter((s) => s.durationMs <= PILOT_PROTOCOL.idleSessionMs);
  const idle = input.sessions.length - active.length;
  const durations = (mode: string, rows: readonly MetricsSession[] = active) =>
    rows.filter((s) => s.mode === mode).map((s) => s.durationMs);

  // Viewed suggestions: assisted sessions' (run, question) pairs, deduplicated,
  // each matched only to the verdict of the editor who viewed it.
  const verdicts = new Map<string, string>();
  for (const f of input.feedback) verdicts.set(`${f.runId}\u0000${f.questionKey}\u0000${f.principalId}`, f.verdict);
  const seen = new Set<string>();
  const viewed: ViewedSuggestion[] = [];
  for (const session of input.sessions) {
    if (session.mode !== 'assisted' || !session.runId || !Array.isArray(session.viewedQuestions)) continue;
    for (const questionKey of session.viewedQuestions) {
      if (typeof questionKey !== 'string') continue;
      const key = `${session.runId}\u0000${questionKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      viewed.push({
        runId: session.runId,
        questionKey,
        locale: session.locale ?? UNKNOWN,
        verdict: verdicts.get(`${key}\u0000${session.principalId}`) ?? null,
      });
    }
  }

  const baseline = timeStats(durations('baseline'), min.sessionsPerMode);
  const assisted = timeStats(durations('assisted'), min.sessionsPerMode);
  const operations = operationStats(input.runs, min.completedRuns);
  const suggestions = suggestionStats(viewed, min.viewedSuggestions);

  const byLocale: Record<string, LocaleSplit> = {};
  const localeSessions = groupBy(active, (s) => s.locale ?? UNKNOWN);
  const localeViewed = groupBy(viewed, (v) => v.locale);
  for (const locale of new Set([...localeSessions.keys(), ...localeViewed.keys()])) {
    const rows = localeSessions.get(locale) ?? [];
    byLocale[locale] = {
      sampleCount: rows.length,
      insufficientSample: rows.length < min.perSplit,
      timePerItem: {
        baseline: timeStats(durations('baseline', rows), min.perSplit),
        assisted: timeStats(durations('assisted', rows), min.perSplit),
      },
      suggestions: suggestionStats(localeViewed.get(locale) ?? [], min.perSplit),
    };
  }

  const runSplit = (key: (run: MetricsRun) => string): Record<string, RunSplit> => {
    const out: Record<string, RunSplit> = {};
    const runs = groupBy(input.runs, key);
    const views = groupBy(viewed, (v) => {
      const run = runsById.get(v.runId);
      return run ? key(run) : UNKNOWN;
    });
    for (const k of new Set([...runs.keys(), ...views.keys()])) {
      const ops = operationStats(runs.get(k) ?? [], min.perSplit);
      const finished = ops.success + ops.abstained + ops.error;
      out[k] = {
        sampleCount: finished,
        insufficientSample: finished < min.perSplit,
        operations: ops,
        suggestions: suggestionStats(views.get(k) ?? [], min.perSplit),
      };
    }
    return out;
  };

  const completedRuns = operations.success + operations.abstained;
  const partial: Omit<ReviewMetrics, 'criteria'> = {
    protocolVersion: PILOT_PROTOCOL.version,
    generatedAt: (input.now ?? new Date()).toISOString(),
    window: { from: input.window.from.toISOString(), to: input.window.to.toISOString() },
    note: USER_VALUE_NOTE,
    truncated: input.truncated ?? false,
    sampleCounts: {
      baselineSessions: baseline.sessions,
      assistedSessions: assisted.sessions,
      idleSessionsExcluded: idle,
      viewedSuggestions: viewed.length,
      completedRuns,
    },
    minimums: PILOT_PROTOCOL.minimums,
    insufficientSample:
      baseline.insufficientSample ||
      assisted.insufficientSample ||
      suggestions.insufficientSample ||
      completedRuns < min.completedRuns,
    timePerItem: {
      baseline,
      assisted,
      assistedToBaselineP50:
        baseline.p50Ms !== null && baseline.p50Ms > 0 && assisted.p50Ms !== null
          ? assisted.p50Ms / baseline.p50Ms
          : null,
    },
    suggestions,
    operations,
    splits: {
      byLocale,
      byProvider: runSplit((run) => run.provider ?? UNKNOWN),
      byProfileVersion: runSplit(profileVersionKey),
    },
  };
  return { ...partial, criteria: evaluatePilotCriteria(partial) };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Rows per table per request. Hitting it sets `truncated`: narrow the window. */
export const METRICS_ROW_LIMIT = 50_000;
const ID_CHUNK = 500;

export interface ReviewMetricsSource {
  load(siteId: string, window: { from: Date; to: Date }): Promise<Omit<ReviewMetricsInput, 'window' | 'now'>>;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Every query is scoped by `site_id`. */
export class DrizzleReviewMetricsSource implements ReviewMetricsSource {
  constructor(private readonly db: Database) {}

  async load(siteId: string, window: { from: Date; to: Date }) {
    const runColumns = {
      id: reviewRuns.id,
      status: reviewRuns.status,
      provider: reviewRuns.provider,
      profileKey: reviewRuns.profileKey,
      profileVersion: reviewRuns.profileVersion,
      latencyMs: reviewRuns.latencyMs,
      usage: reviewRuns.usage,
    };
    const sessions = await this.db
      .select({
        mode: reviewSessions.mode,
        durationMs: reviewSessions.durationMs,
        locale: reviewSessions.locale,
        runId: reviewSessions.runId,
        viewedQuestions: reviewSessions.viewedQuestions,
        principalId: reviewSessions.principalId,
      })
      .from(reviewSessions)
      .where(
        and(
          eq(reviewSessions.siteId, siteId),
          gte(reviewSessions.createdAt, window.from),
          lt(reviewSessions.createdAt, window.to),
        ),
      )
      .limit(METRICS_ROW_LIMIT);
    const runs = await this.db
      .select(runColumns)
      .from(reviewRuns)
      .where(and(eq(reviewRuns.siteId, siteId), gte(reviewRuns.createdAt, window.from), lt(reviewRuns.createdAt, window.to)))
      .limit(METRICS_ROW_LIMIT);

    const inWindow = new Set(runs.map((r) => r.id));
    const referenced = [...new Set(sessions.map((s) => s.runId).filter((id): id is string => id !== null))];
    const referencedRuns: MetricsRun[] = [];
    const feedback: MetricsFeedback[] = [];
    for (const ids of chunks(referenced, ID_CHUNK)) {
      const missing = ids.filter((id) => !inWindow.has(id));
      if (missing.length > 0) {
        referencedRuns.push(
          ...(await this.db
            .select(runColumns)
            .from(reviewRuns)
            .where(and(eq(reviewRuns.siteId, siteId), inArray(reviewRuns.id, missing)))),
        );
      }
      feedback.push(
        ...(await this.db
          .select({
            runId: reviewFeedback.runId,
            questionKey: reviewFeedback.questionKey,
            verdict: reviewFeedback.verdict,
            principalId: reviewFeedback.principalId,
          })
          .from(reviewFeedback)
          .where(and(eq(reviewFeedback.siteId, siteId), inArray(reviewFeedback.runId, ids)))),
      );
    }
    return {
      sessions,
      runs,
      referencedRuns,
      feedback,
      truncated: sessions.length >= METRICS_ROW_LIMIT || runs.length >= METRICS_ROW_LIMIT,
    };
  }
}

/** A function (not `new`) so route tests can swap in an in-memory source. */
export function reviewMetricsSourceFor(db: Database): ReviewMetricsSource {
  return new DrizzleReviewMetricsSource(db);
}
