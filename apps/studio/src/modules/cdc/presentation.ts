/**
 * Pure presentation helpers shared across the CDC panel components
 * (ClickHouse CDC — task 13.3; design "Studio CDC Panel" §6).
 *
 * Keeping these as plain functions (no React) lets the list, wizard, and
 * detail views render consistent labels/badges and lets tests assert the
 * copy without rendering. They also back two requirement-specific behaviours:
 *   - {@link deletionResources} — the resource list shown in the delete
 *     confirmation dialog, which MUST include PostgreSQL replication slots for
 *     slot-based approaches (Req 6.5);
 *   - {@link remediationSteps} — at least one actionable remediation step for
 *     an errored pipeline (Req 6.4).
 */

import type { CdcConnectorType, PipelineStatus, PipelineSummary } from './types';

/** Human-readable label for each connector approach. */
export const CONNECTOR_LABELS: Readonly<Record<CdcConnectorType, string>> = {
  debezium_kafka: 'Debezium + Kafka',
  materialized_engine: 'Materialized Engine',
  airbyte: 'Airbyte',
};

/** Tailwind badge classes per pipeline status (matches existing studio badges). */
export const STATUS_BADGE_CLASSES: Readonly<Record<PipelineStatus, string>> = {
  active: 'bg-emerald-100 text-emerald-800',
  paused: 'bg-amber-100 text-amber-800',
  error: 'bg-red-100 text-red-800',
  provisioning: 'bg-blue-100 text-blue-800',
};

/**
 * The CDC approaches that own a PostgreSQL replication slot. Deleting one of
 * these tears down the slot on the Source_Database (Req 1.8), which the delete
 * confirmation dialog must disclose (Req 6.5).
 */
const SLOT_BASED_APPROACHES: ReadonlySet<CdcConnectorType> = new Set([
  'debezium_kafka',
  'materialized_engine',
]);

/** Whether a connector approach is replication-slot-based (Req 1.8 / 6.5). */
export function isSlotBasedApproach(connectorType: CdcConnectorType): boolean {
  return SLOT_BASED_APPROACHES.has(connectorType);
}

/** Format an ISO timestamp for display, or an em dash when absent. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/**
 * The list of resources that deleting a pipeline will remove, surfaced in the
 * confirmation dialog (Req 6.5). For slot-based approaches the PostgreSQL
 * replication slot(s) on the Source_Database are listed explicitly so the
 * operator understands WAL retention is being released (Req 1.8).
 */
export function deletionResources(pipeline: PipelineSummary): string[] {
  const resources: string[] = [
    `Pipeline configuration "${pipeline.pipelineName}"`,
    'Replication connector and its provisioned resources',
    'Retained health metrics history',
  ];

  if (isSlotBasedApproach(pipeline.connectorType)) {
    resources.push(
      'PostgreSQL replication slot(s) on the source database (releases retained WAL)',
    );
  }
  if (pipeline.connectorType === 'debezium_kafka') {
    resources.push('Kafka topics provisioned for this pipeline');
  }
  if (pipeline.connectorType === 'airbyte') {
    resources.push('Airbyte source, destination, and connection');
  }

  return resources;
}

/**
 * At least one actionable remediation step for an errored pipeline (Req 6.4),
 * keyed off the connector type and (loosely) the status message. These are
 * placeholder, human-readable hints — the authoritative diagnostics come from
 * the Health Monitor; the panel just needs to always offer a next action.
 */
export function remediationSteps(pipeline: PipelineSummary): string[] {
  const message = (pipeline.statusMessage ?? '').toLowerCase();
  const steps: string[] = [];

  if (message.includes('replication slot') || message.includes('slot')) {
    steps.push(
      'Verify the PostgreSQL replication slot exists and has not been dropped on the source database.',
    );
  }
  if (message.includes('timeout') || message.includes('unreachable') || message.includes('connect')) {
    steps.push(
      'Check network connectivity and credentials for the source database and ClickHouse sink.',
    );
  }
  if (message.includes('schema')) {
    steps.push(
      'Reconcile the schema drift on the affected table, then restart the pipeline.',
    );
  }

  if (pipeline.connectorType === 'debezium_kafka') {
    steps.push('Confirm the Kafka broker is reachable and the Debezium connector is registered.');
  } else if (pipeline.connectorType === 'airbyte') {
    steps.push('Open the Airbyte connection and review the latest failed sync job logs.');
  }

  // Always provide a fallback action so Req 6.4 ("at least one remediation
  // step") holds even when the status message is empty/unrecognised.
  if (steps.length === 0) {
    steps.push('Run a health check to identify the unreachable service, then restart the pipeline.');
  }

  return steps;
}
