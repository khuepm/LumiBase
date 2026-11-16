/**
 * Agent receipts (#713, epic #671 A05).
 *
 * Aggregates what governed agents did on one site over a bounded window, from
 * the tables the harness and trust ledger already write. Pure reads: nothing
 * here runs on, or adds a write to, the agent hot path. Every query is scoped
 * to `site_id` and to the window.
 *
 * Alert thresholds are the one piece of state (a `settings` row); they are
 * evaluated at read time, so an alert is a property of the report, not an
 * event that has to be produced by a worker.
 */

import {
  activity,
  agentApprovals,
  agentAutonomyGrants,
  agentIncidents,
  agentRuns,
  agentToolCalls,
  contentDrifts,
  settings,
  type Database,
} from '@lumibase/database';
import {
  AGENT_RECEIPTS_ALERTS_SETTING_KEY,
  AGENT_RECEIPTS_DEFAULT_WINDOW_DAYS,
  AGENT_RECEIPTS_EXPORT_MAX_ROWS,
  AGENT_RECEIPTS_MAX_WINDOW_DAYS,
  DEFAULT_AGENT_RECEIPTS_ALERT_THRESHOLDS,
  agentReceiptsAlertThresholdsSchema,
  type AgentReceipts,
  type AgentReceiptsAlert,
  type AgentReceiptsAlertThresholds,
  type AgentReceiptsExportKind,
} from '@lumibase/contracts';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { and, asc, eq, gte, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';

/** Drift rows that still need work. */
export const OPEN_DRIFT_STATUSES = ['open', 'assigned'];

const DAY_MS = 86_400_000;

export class AgentReceiptsError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'WINDOW_TOO_WIDE',
    message: string,
  ) {
    super(message);
    this.name = 'AgentReceiptsError';
  }
}

export interface ReceiptsWindow {
  since: Date;
  until: Date;
}

/** Defaults to the last 30 days; refuses inverted or over-wide windows. */
export function resolveReceiptsWindow(input: { since?: string; until?: string }, now = new Date()): ReceiptsWindow {
  const until = input.until ? new Date(input.until) : now;
  const since = input.since ? new Date(input.since) : new Date(until.getTime() - AGENT_RECEIPTS_DEFAULT_WINDOW_DAYS * DAY_MS);
  if (Number.isNaN(until.getTime()) || Number.isNaN(since.getTime())) {
    throw new AgentReceiptsError('VALIDATION', 'since/until must be ISO timestamps');
  }
  if (since >= until) throw new AgentReceiptsError('VALIDATION', 'since must be before until');
  if (until.getTime() - since.getTime() > AGENT_RECEIPTS_MAX_WINDOW_DAYS * DAY_MS) {
    throw new AgentReceiptsError('WINDOW_TOO_WIDE', `The window may span at most ${AGENT_RECEIPTS_MAX_WINDOW_DAYS} days`);
  }
  return { since, until };
}

const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);
const round = (value: number | null, digits = 2): number | null =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

/** A jsonb number field, or 0 when absent or not a number. */
function jsonNumber(column: SQL | PgColumn, key: string): SQL<number> {
  return sql<number>`case when jsonb_typeof(${column}->${key}) = 'number' then (${column}->>${key})::numeric else 0 end`;
}

const tokensOf = sql<number>`coalesce(nullif(${jsonNumber(agentToolCalls.cost, 'tokens')}, 0), ${jsonNumber(agentToolCalls.cost, 'estimatedTokens')}, 0)`;
const usdOf = jsonNumber(agentToolCalls.cost, 'usd');

function dayKey(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString().slice(0, 10);
}

/** Thresholds crossed by a report. */
export function evaluateReceiptAlerts(
  receipts: Omit<AgentReceipts, 'alerts' | 'thresholds'>,
  thresholds: AgentReceiptsAlertThresholds,
): AgentReceiptsAlert[] {
  const checks: Array<[keyof AgentReceiptsAlertThresholds, number | null, string]> = [
    ['maxRunFailureRate', receipts.runs.failureRate, 'Run failure rate'],
    ['maxVetoRate', receipts.vetoes.vetoRate, 'Veto rate'],
    ['maxOverrideRate', receipts.overrides.overrideRate, 'Human override rate'],
    ['maxApprovalLatencyP90Minutes', receipts.approvals.latency.p90Minutes, 'Approval latency p90 (minutes)'],
    ['maxCostUsd', receipts.cost.usd, 'Cost (USD)'],
    ['maxTokens', receipts.cost.tokens, 'Tokens'],
    ['maxOpenDrift', receipts.drift.openNow, 'Open drift'],
    ['maxIncidents', receipts.incidents.total, 'Incidents'],
  ];
  const alerts: AgentReceiptsAlert[] = [];
  for (const [metric, value, label] of checks) {
    const threshold = thresholds[metric];
    if (threshold === undefined || value === null || value <= threshold) continue;
    alerts.push({ metric, value, threshold, message: `${label} ${round(value, 3)} exceeds ${threshold}` });
  }
  return alerts;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Spreadsheet formula injection: a cell starting with one of these is data, not a formula.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return [header.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n') + '\n';
}

export class AgentReceiptsService {
  constructor(private readonly deps: { db: Database; siteId: string }) {}

  // ── Thresholds ──────────────────────────────────────────────────────────

  async getThresholds(): Promise<AgentReceiptsAlertThresholds> {
    const [row] = await this.deps.db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.siteId, this.deps.siteId), eq(settings.key, AGENT_RECEIPTS_ALERTS_SETTING_KEY)))
      .limit(1);
    if (!row) return { ...DEFAULT_AGENT_RECEIPTS_ALERT_THRESHOLDS };
    const parsed = agentReceiptsAlertThresholdsSchema.safeParse(row.value);
    // A corrupt row falls back to the defaults rather than silencing every alert.
    return parsed.success ? parsed.data : { ...DEFAULT_AGENT_RECEIPTS_ALERT_THRESHOLDS };
  }

  async setThresholds(input: unknown): Promise<AgentReceiptsAlertThresholds> {
    const parsed = agentReceiptsAlertThresholdsSchema.safeParse(input);
    if (!parsed.success) {
      throw new AgentReceiptsError('VALIDATION', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    }
    await this.deps.db
      .insert(settings)
      .values({ siteId: this.deps.siteId, key: AGENT_RECEIPTS_ALERTS_SETTING_KEY, value: parsed.data, scope: 'site' })
      .onConflictDoUpdate({ target: [settings.siteId, settings.key], set: { value: parsed.data, updatedAt: new Date() } });
    return parsed.data;
  }

  // ── Report ─────────────────────────────────────────────────────────────

  async report(window: ReceiptsWindow): Promise<AgentReceipts> {
    const { db, siteId } = this.deps;
    const { since, until } = window;
    const runsInWindow = and(eq(agentRuns.siteId, siteId), gte(agentRuns.createdAt, since), lt(agentRuns.createdAt, until));
    const callsInWindow = and(
      eq(agentToolCalls.siteId, siteId),
      gte(agentToolCalls.createdAt, since),
      lt(agentToolCalls.createdAt, until),
    );
    const approvalsInWindow = and(
      eq(agentApprovals.siteId, siteId),
      gte(agentApprovals.createdAt, since),
      lt(agentApprovals.createdAt, until),
    );
    const incidentsInWindow = and(
      eq(agentIncidents.siteId, siteId),
      gte(agentIncidents.createdAt, since),
      lt(agentIncidents.createdAt, until),
    );
    const day = (column: SQL | PgColumn) => sql<string>`to_char(date_trunc('day', ${column}), 'YYYY-MM-DD')`;

    const [
      runRows,
      callRows,
      latencyRows,
      costRows,
      approvalRows,
      approvalLatency,
      driftOpened,
      driftResolved,
      driftOpenNow,
      driftByRule,
      incidentRows,
      grants,
      promotions,
      dailyRuns,
      dailyApprovals,
      dailyIncidents,
      dailyCost,
    ] = await Promise.all([
      db
        .select({ agent: agentRuns.agentName, status: agentRuns.status, count: sql<number>`count(*)::int` })
        .from(agentRuns)
        .where(runsInWindow)
        .groupBy(agentRuns.agentName, agentRuns.status),
      db
        .select({ tool: agentToolCalls.toolName, status: agentToolCalls.status, count: sql<number>`count(*)::int` })
        .from(agentToolCalls)
        .where(callsInWindow)
        .groupBy(agentToolCalls.toolName, agentToolCalls.status),
      db
        .select({
          tool: agentToolCalls.toolName,
          p50: sql<number | null>`percentile_cont(0.5) within group (order by ${agentToolCalls.latencyMs})`,
        })
        .from(agentToolCalls)
        .where(and(callsInWindow, sql`${agentToolCalls.latencyMs} is not null`))
        .groupBy(agentToolCalls.toolName),
      db
        .select({
          tool: agentToolCalls.toolName,
          tokens: sql<number>`coalesce(sum(${tokensOf}), 0)`,
          usd: sql<number>`coalesce(sum(${usdOf}), 0)`,
        })
        .from(agentToolCalls)
        .where(callsInWindow)
        .groupBy(agentToolCalls.toolName),
      db
        .select({
          kind: agentApprovals.kind,
          status: agentApprovals.status,
          approverType: agentApprovals.approverType,
          count: sql<number>`count(*)::int`,
        })
        .from(agentApprovals)
        .where(approvalsInWindow)
        .groupBy(agentApprovals.kind, agentApprovals.status, agentApprovals.approverType),
      db
        .select({
          count: sql<number>`count(*)::int`,
          p50: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from (${agentApprovals.decidedAt} - ${agentApprovals.createdAt})) / 60)`,
          p90: sql<number | null>`percentile_cont(0.9) within group (order by extract(epoch from (${agentApprovals.decidedAt} - ${agentApprovals.createdAt})) / 60)`,
          avg: sql<number | null>`avg(extract(epoch from (${agentApprovals.decidedAt} - ${agentApprovals.createdAt})) / 60)`,
        })
        .from(agentApprovals)
        .where(
          and(
            approvalsInWindow,
            eq(agentApprovals.kind, 'approval'),
            inArray(agentApprovals.status, ['approved', 'rejected']),
            sql`${agentApprovals.decidedAt} is not null`,
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(contentDrifts)
        .where(and(eq(contentDrifts.siteId, siteId), gte(contentDrifts.createdAt, since), lt(contentDrifts.createdAt, until))),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(contentDrifts)
        .where(and(eq(contentDrifts.siteId, siteId), gte(contentDrifts.resolvedAt, since), lt(contentDrifts.resolvedAt, until))),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(contentDrifts)
        .where(and(eq(contentDrifts.siteId, siteId), inArray(contentDrifts.status, OPEN_DRIFT_STATUSES))),
      db
        .select({ ruleType: contentDrifts.ruleType, count: sql<number>`count(*)::int` })
        .from(contentDrifts)
        .where(and(eq(contentDrifts.siteId, siteId), gte(contentDrifts.createdAt, since), lt(contentDrifts.createdAt, until)))
        .groupBy(contentDrifts.ruleType),
      db
        .select({
          source: agentIncidents.source,
          severity: agentIncidents.severity,
          count: sql<number>`count(*)::int`,
          demotions: sql<number>`count(*) filter (where ${agentIncidents.capability} is not null)::int`,
        })
        .from(agentIncidents)
        .where(incidentsInWindow)
        .groupBy(agentIncidents.source, agentIncidents.severity),
      db
        .select({
          agentRole: agentAutonomyGrants.agentRole,
          capability: agentAutonomyGrants.capability,
          level: agentAutonomyGrants.level,
          updatedAt: agentAutonomyGrants.updatedAt,
        })
        .from(agentAutonomyGrants)
        .where(eq(agentAutonomyGrants.siteId, siteId))
        .orderBy(asc(agentAutonomyGrants.agentRole), asc(agentAutonomyGrants.capability))
        .limit(500),
      db
        .select({ at: activity.createdAt, payload: activity.payload })
        .from(activity)
        .where(
          and(
            eq(activity.siteId, siteId),
            eq(activity.action, 'trust_ledger.promotion_applied'),
            gte(activity.createdAt, since),
            lt(activity.createdAt, until),
          ),
        )
        .orderBy(asc(activity.createdAt))
        .limit(500),
      db
        .select({
          date: day(agentRuns.createdAt),
          runs: sql<number>`count(*)::int`,
          succeeded: sql<number>`count(*) filter (where ${agentRuns.status} = 'succeeded')::int`,
          failed: sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')::int`,
        })
        .from(agentRuns)
        .where(runsInWindow)
        .groupBy(day(agentRuns.createdAt)),
      db
        .select({ date: day(agentApprovals.createdAt), count: sql<number>`count(*)::int` })
        .from(agentApprovals)
        .where(and(approvalsInWindow, ne(agentApprovals.kind, 'question')))
        .groupBy(day(agentApprovals.createdAt)),
      db
        .select({ date: day(agentIncidents.createdAt), count: sql<number>`count(*)::int` })
        .from(agentIncidents)
        .where(incidentsInWindow)
        .groupBy(day(agentIncidents.createdAt)),
      db
        .select({
          date: day(agentToolCalls.createdAt),
          tokens: sql<number>`coalesce(sum(${tokensOf}), 0)`,
          usd: sql<number>`coalesce(sum(${usdOf}), 0)`,
        })
        .from(agentToolCalls)
        .where(callsInWindow)
        .groupBy(day(agentToolCalls.createdAt)),
    ]);

    // Runs
    const runsByStatus: Record<string, number> = {};
    const byAgent = new Map<string, { agent: string; total: number; succeeded: number; failed: number }>();
    for (const row of runRows) {
      const count = num(row.count);
      runsByStatus[row.status] = (runsByStatus[row.status] ?? 0) + count;
      const entry = byAgent.get(row.agent) ?? { agent: row.agent, total: 0, succeeded: 0, failed: 0 };
      entry.total += count;
      if (row.status === 'succeeded') entry.succeeded += count;
      if (row.status === 'failed') entry.failed += count;
      byAgent.set(row.agent, entry);
    }
    const succeeded = runsByStatus['succeeded'] ?? 0;
    const failed = runsByStatus['failed'] ?? 0;

    // Tool calls
    const latencyByTool = new Map(latencyRows.map((row) => [row.tool, numOrNull(row.p50)]));
    const byTool = new Map<string, { tool: string; total: number; byStatus: Record<string, number>; p50LatencyMs: number | null }>();
    for (const row of callRows) {
      const entry = byTool.get(row.tool) ?? {
        tool: row.tool,
        total: 0,
        byStatus: {},
        p50LatencyMs: round(latencyByTool.get(row.tool) ?? null, 0),
      };
      entry.total += num(row.count);
      entry.byStatus[row.status] = (entry.byStatus[row.status] ?? 0) + num(row.count);
      byTool.set(row.tool, entry);
    }

    // Approvals, vetoes, questions
    const approvalsByStatus: Record<string, number> = {};
    const byApprover: Record<string, number> = {};
    const vetoes = { total: 0, vetoed: 0, committed: 0, pending: 0 };
    const questions = { asked: 0, answered: 0, expired: 0, cancelled: 0, pending: 0 };
    let approvalsTotal = 0;
    let rejectedApprovals = 0;
    let decidedApprovals = 0;
    for (const row of approvalRows) {
      const count = num(row.count);
      if (row.kind === 'veto') {
        vetoes.total += count;
        if (row.status === 'rejected') vetoes.vetoed += count;
        else if (row.status === 'approved') vetoes.committed += count;
        else if (row.status === 'pending' || row.status === 'deciding') vetoes.pending += count;
        continue;
      }
      if (row.kind === 'question') {
        questions.asked += count;
        if (row.status in questions && row.status !== 'asked') questions[row.status as keyof typeof questions] += count;
        continue;
      }
      approvalsTotal += count;
      approvalsByStatus[row.status] = (approvalsByStatus[row.status] ?? 0) + count;
      if (row.status === 'approved' || row.status === 'rejected') {
        decidedApprovals += count;
        byApprover[row.approverType] = (byApprover[row.approverType] ?? 0) + count;
        if (row.status === 'rejected' && row.approverType === 'human') rejectedApprovals += count;
      }
    }
    const latency = approvalLatency[0];

    // Cost
    const costByTool = costRows
      .map((row) => ({ tool: row.tool, tokens: num(row.tokens), usd: num(row.usd) }))
      .filter((row) => row.tokens > 0 || row.usd > 0)
      .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens || a.tool.localeCompare(b.tool));

    // Incidents
    const bySource: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    let incidentsTotal = 0;
    let demotionCandidates = 0;
    for (const row of incidentRows) {
      const count = num(row.count);
      incidentsTotal += count;
      bySource[row.source] = (bySource[row.source] ?? 0) + count;
      bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + count;
      demotionCandidates += num(row.demotions);
    }

    // Autonomy
    const levelDistribution: Record<string, number> = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0 };
    for (const grant of grants) {
      const key = `L${grant.level}`;
      levelDistribution[key] = (levelDistribution[key] ?? 0) + 1;
    }

    // Daily series, one entry per day of the window that has any activity.
    const daily = new Map<string, AgentReceipts['daily'][number]>();
    const dayEntry = (date: string) => {
      const existing = daily.get(date);
      if (existing) return existing;
      const created = { date, runs: 0, succeeded: 0, failed: 0, approvals: 0, incidents: 0, tokens: 0, usd: 0 };
      daily.set(date, created);
      return created;
    };
    for (const row of dailyRuns) Object.assign(dayEntry(dayKey(row.date)), { runs: num(row.runs), succeeded: num(row.succeeded), failed: num(row.failed) });
    for (const row of dailyApprovals) dayEntry(dayKey(row.date)).approvals = num(row.count);
    for (const row of dailyIncidents) dayEntry(dayKey(row.date)).incidents = num(row.count);
    for (const row of dailyCost) Object.assign(dayEntry(dayKey(row.date)), { tokens: num(row.tokens), usd: round(num(row.usd), 4) ?? 0 });

    const vetoesClosed = vetoes.vetoed + vetoes.committed;
    const base: Omit<AgentReceipts, 'alerts' | 'thresholds'> = {
      window: { since: since.toISOString(), until: until.toISOString() },
      runs: {
        total: Object.values(runsByStatus).reduce((a, b) => a + b, 0),
        byStatus: runsByStatus,
        byAgent: [...byAgent.values()].sort((a, b) => b.total - a.total || a.agent.localeCompare(b.agent)),
        failureRate: round(ratio(failed, succeeded + failed), 4),
      },
      toolCalls: {
        total: [...byTool.values()].reduce((a, b) => a + b.total, 0),
        byTool: [...byTool.values()].sort((a, b) => b.total - a.total || a.tool.localeCompare(b.tool)),
      },
      approvals: {
        total: approvalsTotal,
        byStatus: approvalsByStatus,
        byApprover,
        latency: {
          count: num(latency?.count),
          p50Minutes: round(numOrNull(latency?.p50)),
          p90Minutes: round(numOrNull(latency?.p90)),
          avgMinutes: round(numOrNull(latency?.avg)),
        },
      },
      vetoes: { ...vetoes, vetoRate: round(ratio(vetoes.vetoed, vetoesClosed), 4) },
      questions,
      overrides: {
        rejectedApprovals,
        vetoed: vetoes.vetoed,
        total: rejectedApprovals + vetoes.vetoed,
        overrideRate: round(ratio(rejectedApprovals + vetoes.vetoed, decidedApprovals + vetoesClosed), 4),
      },
      cost: {
        tokens: costByTool.reduce((a, b) => a + b.tokens, 0),
        usd: round(costByTool.reduce((a, b) => a + b.usd, 0), 4) ?? 0,
        byTool: costByTool,
      },
      drift: {
        opened: num(driftOpened[0]?.count),
        resolved: num(driftResolved[0]?.count),
        openNow: num(driftOpenNow[0]?.count),
        byRule: driftByRule.map((row) => ({ ruleType: row.ruleType, count: num(row.count) })).sort((a, b) => b.count - a.count || a.ruleType.localeCompare(b.ruleType)),
      },
      incidents: { total: incidentsTotal, bySource, bySeverity },
      autonomy: {
        grants: grants.map((grant) => ({
          agentRole: grant.agentRole,
          capability: grant.capability,
          level: grant.level,
          updatedAt: grant.updatedAt.toISOString(),
        })),
        levelDistribution,
        promotions: promotions.map((row) => {
          const payload = (row.payload ?? {}) as Record<string, unknown>;
          return {
            at: row.at.toISOString(),
            agentRole: String(payload['agentRole'] ?? ''),
            capability: String(payload['capability'] ?? ''),
            toLevel: numOrNull(payload['targetLevel']),
          };
        }),
        demotions: demotionCandidates,
      },
      daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
    const thresholds = await this.getThresholds();
    return { ...base, alerts: evaluateReceiptAlerts(base, thresholds), thresholds };
  }

  // ── CSV export ────────────────────────────────────────────────────────

  async exportCsv(kind: AgentReceiptsExportKind, window: ReceiptsWindow): Promise<{ csv: string; rows: number; truncated: boolean }> {
    const { db, siteId } = this.deps;
    const { since, until } = window;
    const limit = AGENT_RECEIPTS_EXPORT_MAX_ROWS + 1;
    let header: string[];
    let rows: unknown[][];
    if (kind === 'runs') {
      const data = await db
        .select({
          id: agentRuns.id,
          goalId: agentRuns.goalId,
          agent: agentRuns.agentName,
          status: agentRuns.status,
          risk: agentRuns.risk,
          startedAt: agentRuns.startedAt,
          finishedAt: agentRuns.finishedAt,
          stopReason: sql<string | null>`${agentRuns.metrics}->>'stopReason'`,
          retryOf: agentRuns.retryOfRunId,
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.siteId, siteId), gte(agentRuns.createdAt, since), lt(agentRuns.createdAt, until)))
        .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id))
        .limit(limit);
      // Per-run totals in a second grouped query (chunked) rather than a
      // correlated subquery per row.
      const perRun = new Map<string, { calls: number; tokens: number; usd: number }>();
      const ids = data.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        const totals = await db
          .select({
            runId: agentToolCalls.runId,
            calls: sql<number>`count(*)::int`,
            tokens: sql<number>`coalesce(sum(${tokensOf}), 0)`,
            usd: sql<number>`coalesce(sum(${usdOf}), 0)`,
          })
          .from(agentToolCalls)
          .where(and(eq(agentToolCalls.siteId, siteId), inArray(agentToolCalls.runId, chunk)))
          .groupBy(agentToolCalls.runId);
        for (const t of totals) perRun.set(t.runId, { calls: num(t.calls), tokens: num(t.tokens), usd: num(t.usd) });
      }
      header = ['run_id', 'goal_id', 'agent', 'status', 'risk', 'started_at', 'finished_at', 'stop_reason', 'retry_of', 'tool_calls', 'tokens', 'usd'];
      rows = data.map((r) => {
        const t = perRun.get(r.id) ?? { calls: 0, tokens: 0, usd: 0 };
        return [r.id, r.goalId, r.agent, r.status, r.risk, r.startedAt, r.finishedAt, r.stopReason, r.retryOf, t.calls, t.tokens, t.usd];
      });
    } else if (kind === 'tool_calls') {
      const data = await db
        .select({
          id: agentToolCalls.id,
          runId: agentToolCalls.runId,
          tool: agentToolCalls.toolName,
          status: agentToolCalls.status,
          risk: agentToolCalls.risk,
          approvalId: agentToolCalls.approvalId,
          latencyMs: agentToolCalls.latencyMs,
          tokens: tokensOf,
          usd: usdOf,
          createdAt: agentToolCalls.createdAt,
          finishedAt: agentToolCalls.finishedAt,
        })
        .from(agentToolCalls)
        .where(and(eq(agentToolCalls.siteId, siteId), gte(agentToolCalls.createdAt, since), lt(agentToolCalls.createdAt, until)))
        .orderBy(asc(agentToolCalls.createdAt), asc(agentToolCalls.id))
        .limit(limit);
      // Inputs and outputs are deliberately not exported: they can carry
      // content and are already masked/untrusted in their own tables.
      header = ['tool_call_id', 'run_id', 'tool', 'status', 'risk', 'approval_id', 'latency_ms', 'tokens', 'usd', 'created_at', 'finished_at'];
      rows = data.map((r) => [r.id, r.runId, r.tool, r.status, r.risk, r.approvalId, r.latencyMs, num(r.tokens), num(r.usd), r.createdAt, r.finishedAt]);
    } else {
      const data = await db
        .select({
          id: agentApprovals.id,
          runId: agentApprovals.runId,
          kind: agentApprovals.kind,
          subjectType: agentApprovals.subjectType,
          status: agentApprovals.status,
          policy: agentApprovals.approvalPolicy,
          requestedBy: agentApprovals.requestedByAgent,
          approverType: agentApprovals.approverType,
          decidedBy: agentApprovals.decidedBy,
          createdAt: agentApprovals.createdAt,
          decidedAt: agentApprovals.decidedAt,
        })
        .from(agentApprovals)
        .where(and(eq(agentApprovals.siteId, siteId), gte(agentApprovals.createdAt, since), lt(agentApprovals.createdAt, until)))
        .orderBy(asc(agentApprovals.createdAt), asc(agentApprovals.id))
        .limit(limit);
      header = ['approval_id', 'run_id', 'kind', 'subject_type', 'status', 'policy', 'requested_by_agent', 'approver_type', 'decided_by', 'created_at', 'decided_at', 'latency_minutes'];
      rows = data.map((r) => [
        r.id, r.runId, r.kind, r.subjectType, r.status, r.policy, r.requestedBy, r.approverType, r.decidedBy, r.createdAt, r.decidedAt,
        r.decidedAt ? round((r.decidedAt.getTime() - r.createdAt.getTime()) / 60_000) : null,
      ]);
    }
    const truncated = rows.length > AGENT_RECEIPTS_EXPORT_MAX_ROWS;
    if (truncated) rows = rows.slice(0, AGENT_RECEIPTS_EXPORT_MAX_ROWS);
    return { csv: toCsv(header, rows), rows: rows.length, truncated };
  }
}
