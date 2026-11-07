import { CORE_SKILLS } from '@lumibase/ai-skills';
import { Counter, Gauge, Histogram } from 'prom-client';
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
    agentEstimatedTokensTotal.inc({ tool: metricTool(toolName) }, tokens);
  }

  const usd = Number(cost['usd'] ?? cost['estimatedUsd'] ?? cost['costUsd']);
  if (Number.isFinite(usd) && usd > 0) {
    agentEstimatedCostUsdTotal.inc({ tool: metricTool(toolName) }, usd);
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

// ── Content OS rollout metrics (content-os task 20.2; Req 9.5) ──────────────

/**
 * Dangerous actions that executed WITHOUT a prior human approval, by
 * autonomy level (L3 = staged into the veto window, L4 = autopilot).
 * Autonomous operation rate = this / lumibase_agent_runs_total.
 */
export const agentAutonomousOpsTotal = new Counter({
  name: 'lumibase_agent_autonomous_operations_total',
  help: 'Dangerous actions executed without pre-approval, by autonomy level',
  labelNames: ['level'] as const,
  registers: [register],
});

export const agentVetoStagingsTotal = new Counter({
  name: 'lumibase_agent_veto_stagings_total',
  help: 'Staged revisions entering the L3 veto window',
  registers: [register],
});

/** Veto rate = lumibase_agent_vetoes_total / lumibase_agent_veto_stagings_total. */
export const agentVetoesTotal = new Counter({
  name: 'lumibase_agent_vetoes_total',
  help: 'Human vetoes of staged revisions before auto-commit',
  registers: [register],
});

/**
 * Coalescing ratio = coalesced / (coalesced + flushes): the share of item
 * writes absorbed by the per-tool-call coalescing window.
 */
export const agentCoalescedWritesTotal = new Counter({
  name: 'lumibase_agent_coalesced_writes_total',
  help: 'Item writes absorbed by the write-coalescing window (no extra invalidation)',
  registers: [register],
});

export const agentWriteFlushesTotal = new Counter({
  name: 'lumibase_agent_write_flushes_total',
  help: 'Tag invalidations flushed at tool-call boundaries (one per collection per window)',
  registers: [register],
});

/** Intent health: open drift backlog per intent at the last reconcile pass. */
export const intentOpenDriftsGauge = new Gauge({
  name: 'lumibase_intent_open_drifts',
  help: 'Open/assigned drifts per content intent at the last reconciliation',
  labelNames: ['intent'] as const,
  registers: [register],
});

export const intentBreakerTripsTotal = new Counter({
  name: 'lumibase_intent_breaker_trips_total',
  help: 'Reconciler circuit-breaker trips (intent moved to error)',
  registers: [register],
});

/** Fixed vocabulary keeps user-controlled agent/tool names out of time series. */
export function metricTool(value: string): string {
  return Object.hasOwn(CORE_SKILLS, value) ? value : 'custom';
}
export function metricAgent(value: string): string {
  return value === 'lumibase-copilot' ? value : 'custom';
}
export function metricReason(value: string): string {
  return ['completed', 'error', 'execution_timeout', 'worker_error', 'cancelled_by_user', 'killed_by_user', 'stale_unverified', 'enqueue_failed', 'queue_timeout', 'overload'].includes(value) ? value : 'other';
}
export function metricKind(value: string): string {
  return ['tool_call', 'artifact', 'schema_validation', 'migration_dry_run', 'api_spec_validation', 'prompt_safety', 'json_schema_validation'].includes(value) ? value : 'other';
}
export function metricStatus(value: string): string {
  return ['approved', 'rejected', 'failed', 'executed', 'pending_approval', 'denied', 'succeeded', 'cancelled', 'pass', 'fail'].includes(value) ? value : 'other';
}
export function observeApprovalDecision(row: { subjectType?: string; status: string; createdAt: Date }): void {
  const labels = { subject_type: metricKind(row.subjectType ?? 'tool_call'), status: metricStatus(row.status) };
  agentApprovalsTotal.inc(labels);
  const latency = (Date.now() - row.createdAt.getTime()) / 1000;
  if (Number.isFinite(latency)) agentApprovalLatency.observe(labels, Math.max(0, latency));
}
