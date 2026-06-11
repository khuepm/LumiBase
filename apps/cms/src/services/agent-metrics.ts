import { Counter, Histogram } from 'prom-client';
import { register } from '../routes/metrics';

export const agentRunsTotal = new Counter({
  name: 'lumibase_agent_runs_total',
  help: 'Agent runs finished by status and stop reason',
  labelNames: ['agent', 'status', 'stop_reason'] as const,
  registers: [register],
});

export const agentToolLatency = new Histogram({
  name: 'lumibase_agent_tool_latency_seconds',
  help: 'Agent tool call latency in seconds',
  labelNames: ['tool', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

export const agentApprovalsTotal = new Counter({
  name: 'lumibase_agent_approvals_total',
  help: 'Agent approval decisions by subject type and status',
  labelNames: ['subject_type', 'status'] as const,
  registers: [register],
});

export const agentApprovalLatency = new Histogram({
  name: 'lumibase_agent_approval_latency_seconds',
  help: 'Time between agent approval request and decision',
  labelNames: ['subject_type', 'status'] as const,
  buckets: [1, 5, 15, 30, 60, 300, 900, 1800, 3600, 21600, 86400],
  registers: [register],
});

export const agentEvaluationsTotal = new Counter({
  name: 'lumibase_agent_evaluations_total',
  help: 'Agent artifact evaluations by kind and status',
  labelNames: ['kind', 'status'] as const,
  registers: [register],
});

export const agentEstimatedTokensTotal = new Counter({
  name: 'lumibase_agent_estimated_tokens_total',
  help: 'Estimated tokens used by agent tool calls',
  labelNames: ['tool'] as const,
  registers: [register],
});

export const agentEstimatedCostUsdTotal = new Counter({
  name: 'lumibase_agent_estimated_cost_usd_total',
  help: 'Estimated agent cost in USD',
  labelNames: ['tool'] as const,
  registers: [register],
});

export const agentDeadLettersTotal = new Counter({
  name: 'lumibase_agent_dead_letters_total',
  help: 'Agent runs enqueued to the dead-letter queue after repeated failure',
  labelNames: ['agent', 'reason'] as const,
  registers: [register],
});

export function observeAgentCost(toolName: string, cost: Record<string, unknown> | undefined): void {
  if (!cost) return;
  const tokens = Number(cost['tokens'] ?? cost['totalTokens'] ?? cost['estimatedTokens']);
  if (Number.isFinite(tokens) && tokens > 0) {
    agentEstimatedTokensTotal.inc({ tool: toolName }, tokens);
  }

  const usd = Number(cost['usd'] ?? cost['estimatedUsd'] ?? cost['costUsd']);
  if (Number.isFinite(usd) && usd > 0) {
    agentEstimatedCostUsdTotal.inc({ tool: toolName }, usd);
  }
}

export const agentBackpressureActivationsTotal = new Counter({
  name: 'lumibase_agent_backpressure_activations_total',
  help: 'Times the load guard paused reconciler autonomy due to runtime load',
  labelNames: ['reason'] as const,
  registers: [register],
});

export const agentWriteBudgetDenialsTotal = new Counter({
  name: 'lumibase_agent_write_budget_denials_total',
  help: 'Tool calls deferred at the boundary by the per-intent write rate budget',
  registers: [register],
});
