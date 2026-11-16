import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  activity,
  agentApprovals,
  agentAutonomyGrants,
  agentGoals,
  agentIncidents,
  agentRuns,
  agentToolCalls,
  contentDrifts,
  contentIntents,
  settings,
  sites,
  type Database,
} from '@lumibase/database';
import { AGENT_RECEIPTS_ALERTS_SETTING_KEY } from '@lumibase/contracts';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { AgentReceiptsError, AgentReceiptsService, resolveReceiptsWindow } from '../agent-receipts-service';

/**
 * Agent receipts (#713) against REAL PostgreSQL: every figure is computed by
 * the production SQL from rows the harness would have written. Site B carries
 * a full copy of the fixture, so any figure that leaks across tenants doubles.
 */

const SITE = 'site_receipts_a';
const OTHER = 'site_receipts_b';
const NOW = new Date('2026-11-10T12:00:00Z');
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000);
const WINDOW = { since: new Date('2026-11-01T00:00:00Z'), until: NOW };

describe.skipIf(!hasDbIntegrationUrl)('AgentReceiptsService — DB integration', () => {
  let db: Database;

  async function seed(siteId: string) {
    const [goal] = await db.insert(agentGoals).values({ siteId, title: 'g' }).returning();
    const run = async (agentName: string, status: string, createdAt: Date) => {
      const [row] = await db
        .insert(agentRuns)
        .values({ siteId, goalId: goal!.id, agentName, status, createdAt, startedAt: createdAt })
        .returning();
      return row!;
    };
    const r1 = await run('copilot', 'succeeded', at(48));
    const r2 = await run('copilot', 'failed', at(47));
    const r3 = await run('translator', 'succeeded', at(2));
    await run('translator', 'awaiting_approval', at(1));
    // Outside the window: must not count.
    await run('copilot', 'failed', new Date('2026-10-01T00:00:00Z'));

    await db.insert(agentToolCalls).values([
      { siteId, runId: r1.id, toolName: 'updateItem', status: 'executed', latencyMs: 100, cost: { tokens: 1000, usd: 0.01 }, createdAt: at(48) },
      { siteId, runId: r2.id, toolName: 'updateItem', status: 'failed', latencyMs: 300, cost: {}, createdAt: at(47) },
      { siteId, runId: r3.id, toolName: 'translateItem', status: 'executed', latencyMs: 50, cost: { estimatedTokens: 500, usd: 0.02 }, createdAt: at(2) },
      // A non-numeric cost value is ignored, not a crash.
      { siteId, runId: r3.id, toolName: 'translateItem', status: 'denied', cost: { tokens: 'lots' }, createdAt: at(2) },
    ]);

    const approval = (values: Partial<typeof agentApprovals.$inferInsert>) => ({
      siteId, runId: r1.id, subjectType: 'tool_call', subjectId: 'x', ...values,
    });
    await db.insert(agentApprovals).values([
      approval({ status: 'approved', createdAt: at(10), decidedAt: at(9) }), // 60 min
      approval({ status: 'rejected', createdAt: at(10), decidedAt: at(7) }), // 180 min, human override
      approval({ status: 'approved', approverType: 'agent', createdAt: at(5), decidedAt: at(4.5) }), // 30 min
      approval({ status: 'pending', createdAt: at(1) }),
      approval({ kind: 'veto', status: 'rejected', createdAt: at(6), decidedAt: at(5) }),
      approval({ kind: 'veto', status: 'approved', createdAt: at(6), decidedAt: at(3) }),
      approval({ kind: 'veto', status: 'pending', createdAt: at(1) }),
      approval({ kind: 'question', status: 'answered', createdAt: at(3), decidedAt: at(2) }),
      approval({ kind: 'question', status: 'expired', createdAt: at(30), decidedAt: at(6) }),
    ]);

    await db.insert(agentIncidents).values([
      { siteId, agentRole: 'translator', capability: 'items:write', source: 'veto', severity: 'medium', createdAt: at(5) },
      { siteId, agentRole: 'translator', source: 'runtime_error', severity: 'low', createdAt: at(4) },
    ]);

    const [intent] = await db
      .insert(contentIntents)
      .values({ siteId, name: 'fresh', collection: 'posts', schedule: '0 * * * *' })
      .returning();
    const drift = (fingerprint: string, values: Partial<typeof contentDrifts.$inferInsert>) => ({
      siteId, intentId: intent!.id, itemId: 'i', ruleType: 'freshness', ruleKey: fingerprint, fingerprint, ...values,
    });
    await db.insert(contentDrifts).values([
      drift('d1', { status: 'open', createdAt: at(20) }),
      drift('d2', { status: 'resolved', createdAt: at(20), resolvedAt: at(10) }),
      drift('d3', { status: 'assigned', ruleType: 'required_field', createdAt: new Date('2026-10-01T00:00:00Z') }),
    ]);

    await db.insert(agentAutonomyGrants).values([
      { siteId, agentRole: 'translator', capability: 'items:write', level: 3 },
      { siteId, agentRole: 'copilot', capability: 'schema:write', level: 1 },
    ]);
    await db.insert(activity).values({
      siteId,
      action: 'trust_ledger.promotion_applied',
      payload: { agentRole: 'translator', capability: 'items:write', targetLevel: 3 },
      createdAt: at(8),
    });
  }

  beforeAll(async () => {
    db = await connectDbIntegration('agent-receipts');
  });

  const cleanup = () => db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER})`);
  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
  });

  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId: org, id: SITE, name: 'Receipts A' },
      { organizationId: org, id: OTHER, name: 'Receipts B' },
    ]);
    await seed(SITE);
    await seed(OTHER);
  });

  it('aggregates one site, one window — nothing from the other tenant, nothing outside the window', async () => {
    const report = await new AgentReceiptsService({ db, siteId: SITE }).report(WINDOW);

    expect(report.runs).toEqual({
      total: 4,
      byStatus: { succeeded: 2, failed: 1, awaiting_approval: 1 },
      byAgent: [
        { agent: 'copilot', total: 2, succeeded: 1, failed: 1 },
        { agent: 'translator', total: 2, succeeded: 1, failed: 0 },
      ],
      failureRate: 0.3333,
    });
    expect(report.toolCalls.total).toBe(4);
    expect(report.toolCalls.byTool).toEqual([
      { tool: 'translateItem', total: 2, byStatus: { executed: 1, denied: 1 }, p50LatencyMs: 50 },
      { tool: 'updateItem', total: 2, byStatus: { executed: 1, failed: 1 }, p50LatencyMs: 200 },
    ]);
    expect(report.cost).toEqual({
      tokens: 1500,
      usd: 0.03,
      byTool: [
        { tool: 'translateItem', tokens: 500, usd: 0.02 },
        { tool: 'updateItem', tokens: 1000, usd: 0.01 },
      ],
    });

    expect(report.approvals.total).toBe(4);
    expect(report.approvals.byStatus).toEqual({ approved: 2, rejected: 1, pending: 1 });
    expect(report.approvals.byApprover).toEqual({ human: 2, agent: 1 });
    expect(report.approvals.latency).toEqual({ count: 3, p50Minutes: 60, p90Minutes: 156, avgMinutes: 90 });
    expect(report.vetoes).toEqual({ total: 3, vetoed: 1, committed: 1, pending: 1, vetoRate: 0.5 });
    expect(report.questions).toEqual({ asked: 2, answered: 1, expired: 1, cancelled: 0, pending: 0 });
    // 1 human rejection + 1 veto, over 3 decided approvals + 2 closed vetoes.
    expect(report.overrides).toEqual({ rejectedApprovals: 1, vetoed: 1, total: 2, overrideRate: 0.4 });

    expect(report.drift).toEqual({ opened: 2, resolved: 1, openNow: 2, byRule: [{ ruleType: 'freshness', count: 2 }] });
    expect(report.incidents).toEqual({
      total: 2,
      bySource: { veto: 1, runtime_error: 1 },
      bySeverity: { medium: 1, low: 1 },
    });
    expect(report.autonomy.levelDistribution).toEqual({ L0: 0, L1: 1, L2: 0, L3: 1, L4: 0 });
    expect(report.autonomy.promotions).toEqual([
      expect.objectContaining({ agentRole: 'translator', capability: 'items:write', toLevel: 3 }),
    ]);
    expect(report.autonomy.demotions).toBe(1);

    // Nov 9 only has a question (not an approval) — no entry.
    expect(report.daily.map((entry) => entry.date)).toEqual(['2026-11-08', '2026-11-10']);
    const nov8 = report.daily.find((entry) => entry.date === '2026-11-08')!;
    expect(nov8).toMatchObject({ runs: 2, succeeded: 1, failed: 1, tokens: 1000, usd: 0.01 });
  });

  it('raises the default alerts it crosses and honours stored thresholds', async () => {
    const service = new AgentReceiptsService({ db, siteId: SITE });
    const defaults = await service.report(WINDOW);
    expect(defaults.alerts.map((alert) => alert.metric).sort()).toEqual(['maxOverrideRate', 'maxRunFailureRate', 'maxVetoRate']);

    await service.setThresholds({ maxCostUsd: 0.01, maxIncidents: 5 });
    const custom = await service.report(WINDOW);
    expect(custom.thresholds).toEqual({ maxCostUsd: 0.01, maxIncidents: 5 });
    expect(custom.alerts).toEqual([
      expect.objectContaining({ metric: 'maxCostUsd', value: 0.03, threshold: 0.01 }),
    ]);
    // Thresholds are per site.
    expect((await new AgentReceiptsService({ db, siteId: OTHER }).getThresholds()).maxRunFailureRate).toBe(0.2);

    await expect(service.setThresholds({ maxVetoRate: 2 })).rejects.toBeInstanceOf(AgentReceiptsError);
    await expect(service.setThresholds({ unknown: 1 })).rejects.toBeInstanceOf(AgentReceiptsError);

    // A corrupt stored row falls back to the defaults instead of silencing alerts.
    await db.update(settings).set({ value: { maxVetoRate: 'x' } }).where(eq(settings.key, AGENT_RECEIPTS_ALERTS_SETTING_KEY));
    expect((await service.getThresholds()).maxRunFailureRate).toBe(0.2);
  });

  it('exports CSV for runs, tool calls and approvals, site-scoped, without tool inputs', async () => {
    const service = new AgentReceiptsService({ db, siteId: SITE });
    const runs = await service.exportCsv('runs', WINDOW);
    const lines = runs.csv.trim().split('\n');
    expect(lines[0]).toBe('run_id,goal_id,agent,status,risk,started_at,finished_at,stop_reason,retry_of,tool_calls,tokens,usd');
    expect(lines).toHaveLength(5);
    expect(runs).toMatchObject({ rows: 4, truncated: false });
    expect(lines[1]).toContain(',copilot,succeeded,');
    expect(lines[1]!.endsWith(',1,1000,0.01')).toBe(true);

    const calls = await service.exportCsv('tool_calls', WINDOW);
    expect(calls.rows).toBe(4);
    expect(calls.csv).not.toContain('input');

    const approvals = await service.exportCsv('approvals', WINDOW);
    expect(approvals.rows).toBe(9);
    expect(approvals.csv.split('\n')[0]).toContain('latency_minutes');
  });

  it('refuses inverted and over-wide windows', () => {
    expect(() => resolveReceiptsWindow({ since: '2026-11-10T00:00:00Z', until: '2026-11-01T00:00:00Z' })).toThrow(AgentReceiptsError);
    expect(() => resolveReceiptsWindow({ since: '2025-01-01T00:00:00Z', until: '2026-11-01T00:00:00Z' })).toThrow(/180 days/);
    const window = resolveReceiptsWindow({}, NOW);
    expect(window.until).toEqual(NOW);
    expect(NOW.getTime() - window.since.getTime()).toBe(30 * 86_400_000);
  });
});
