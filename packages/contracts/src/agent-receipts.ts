import { z } from 'zod';

/**
 * Agent receipts (#713): what governed agents did on a site over a window —
 * runs, tool calls by skill and outcome, approvals and their latency, vetoes
 * and human overrides, token cost, drift, incidents and autonomy changes.
 *
 * Read-only by construction: computed from the trust ledger and audit tables
 * (`agent_runs`, `agent_tool_calls`, `agent_approvals`, `agent_incidents`,
 * `agent_autonomy_grants`, `content_drifts`, `activity`). Nothing on the
 * agent hot path writes anything for it.
 */

/** Widest window one request may aggregate. */
export const AGENT_RECEIPTS_MAX_WINDOW_DAYS = 180;
export const AGENT_RECEIPTS_DEFAULT_WINDOW_DAYS = 30;
/** Rows one CSV export returns at most. */
export const AGENT_RECEIPTS_EXPORT_MAX_ROWS = 10_000;

export const AGENT_RECEIPTS_ALERTS_SETTING_KEY = 'agent.receipts.alerts';

const rate = z.number().min(0).max(1);

/** Thresholds; an absent one is not checked. */
export const agentReceiptsAlertThresholdsSchema = z
  .object({
    /** failed / finished runs. */
    maxRunFailureRate: rate.optional(),
    /** vetoed / closed veto windows. */
    maxVetoRate: rate.optional(),
    /** human-rejected / decided approvals. */
    maxOverrideRate: rate.optional(),
    /** p90 time from park to decision, minutes. */
    maxApprovalLatencyP90Minutes: z.number().positive().max(43_200).optional(),
    /** Summed `usd` of tool calls in the window. */
    maxCostUsd: z.number().nonnegative().optional(),
    /** Summed tokens of tool calls in the window. */
    maxTokens: z.number().int().nonnegative().optional(),
    /** Drift rows open right now. */
    maxOpenDrift: z.number().int().nonnegative().optional(),
    /** Incidents recorded in the window. */
    maxIncidents: z.number().int().nonnegative().optional(),
  })
  .strict();
export type AgentReceiptsAlertThresholds = z.infer<typeof agentReceiptsAlertThresholdsSchema>;

export const DEFAULT_AGENT_RECEIPTS_ALERT_THRESHOLDS: AgentReceiptsAlertThresholds = {
  maxRunFailureRate: 0.2,
  maxVetoRate: 0.25,
  maxOverrideRate: 0.3,
  maxApprovalLatencyP90Minutes: 1440,
};

export const AGENT_RECEIPTS_EXPORT_KINDS = ['runs', 'tool_calls', 'approvals'] as const;
export type AgentReceiptsExportKind = (typeof AGENT_RECEIPTS_EXPORT_KINDS)[number];

export const agentReceiptsQuerySchema = z.object({
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
});

export interface AgentReceiptsLatency {
  /** Decided approvals the figures are computed from. */
  count: number;
  p50Minutes: number | null;
  p90Minutes: number | null;
  avgMinutes: number | null;
}

export interface AgentReceiptsAlert {
  metric: keyof AgentReceiptsAlertThresholds;
  value: number;
  threshold: number;
  message: string;
}

export interface AgentReceipts {
  window: { since: string; until: string };
  runs: {
    total: number;
    byStatus: Record<string, number>;
    byAgent: Array<{ agent: string; total: number; succeeded: number; failed: number }>;
    /** failed / (succeeded + failed); null when none finished. */
    failureRate: number | null;
  };
  toolCalls: {
    total: number;
    /** Skill × outcome. */
    byTool: Array<{ tool: string; total: number; byStatus: Record<string, number>; p50LatencyMs: number | null }>;
  };
  approvals: {
    total: number;
    byStatus: Record<string, number>;
    byApprover: Record<string, number>;
    latency: AgentReceiptsLatency;
  };
  vetoes: { total: number; vetoed: number; committed: number; pending: number; vetoRate: number | null };
  questions: { asked: number; answered: number; expired: number; cancelled: number; pending: number };
  /** A human said no to something an agent proposed or staged. */
  overrides: { rejectedApprovals: number; vetoed: number; total: number; overrideRate: number | null };
  cost: {
    tokens: number;
    usd: number;
    byTool: Array<{ tool: string; tokens: number; usd: number }>;
  };
  drift: { opened: number; resolved: number; openNow: number; byRule: Array<{ ruleType: string; count: number }> };
  incidents: { total: number; bySource: Record<string, number>; bySeverity: Record<string, number> };
  autonomy: {
    grants: Array<{ agentRole: string; capability: string; level: number; updatedAt: string }>;
    levelDistribution: Record<string, number>;
    promotions: Array<{ at: string; agentRole: string; capability: string; toLevel: number | null }>;
    demotions: number;
  };
  daily: Array<{
    date: string;
    runs: number;
    succeeded: number;
    failed: number;
    approvals: number;
    incidents: number;
    tokens: number;
    usd: number;
  }>;
  alerts: AgentReceiptsAlert[];
  thresholds: AgentReceiptsAlertThresholds;
}
