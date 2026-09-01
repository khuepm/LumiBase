/**
 * CDC module barrel — public entry point for the ClickHouse CDC system
 * (ClickHouse CDC — task 12.2; design "CDC API Routes" §7, Requirement 1.1).
 *
 * This file re-exports the CDC module's public surface so the rest of the app
 * (and tests) can import from `modules/cdc` instead of reaching into
 * individual files. The main app entry (`apps/cms/src/index.ts`) mounts
 * {@link cdcRouter} on the AUTHENTICATED `api` Hono at `/cdc`, yielding the
 * `/api/v1/cdc/*` control-plane surface (see the security note in
 * `routes.ts`).
 *
 * ── Why the router is exported flat, but everything else is namespaced ────
 *
 * The CDC control-plane router is the module's primary public artifact, so it
 * (and its injectable-services contract, used by task 12.3) is re-exported as
 * flat named bindings for ergonomic `import { cdcRouter } from '.../cdc'`.
 *
 * The remaining sub-modules are re-exported as NAMESPACES (`export * as …`).
 * Several of them deliberately export overlapping names — e.g.
 * `EnvVarDefinition` (config-generator + env-validator), `PipelineStatus`
 * (pipeline-registry + health-monitor), `CdcConnectorType` (connectors/types +
 * pipeline-registry), `slotNameFor` (debezium-kafka + materialized-engine),
 * and `ROLLBACK_BUDGET_MS` (deployment-orchestrator + rollback-manager).
 * Namespacing keeps each module's exports collision-free and the barrel
 * unambiguous (e.g. `registry.PipelineStatus` vs `healthMonitor.PipelineStatus`).
 */

// ── primary public surface: the CDC control-plane router ──────────────────
// Mounted under `/api/v1/cdc` on the authenticated `api` Hono (task 12.2).
export {
  cdcRouter,
  createCdcRouter,
  defaultCdcServicesFactory,
  type CdcRouteServices,
  type CdcServicesFactory,
} from './routes';

// ── pipeline registry + connection-parameter encryption ───────────────────
export * as registry from './registry/pipeline-registry';
export * as encryption from './registry/encryption';

// ── CDC connectors (interface + the three strategies) ─────────────────────
export * as connectorTypes from './connectors/types';
export * as debeziumKafkaConnector from './connectors/debezium-kafka';
export * as materializedEngineConnector from './connectors/materialized-engine';
export * as airbyteConnector from './connectors/airbyte';

// ── pipeline health monitoring ────────────────────────────────────────────
export * as healthMonitor from './health-monitor';

// ── Studio approach-recommendation engine ─────────────────────────────────
export * as recommender from './recommender';

// ── AI deployment-flow engine (config gen, env validation, deploy/rollback)
export * as configGenerator from './ai-flow/config-generator';
export * as envValidator from './ai-flow/env-validator';
export * as deploymentOrchestrator from './ai-flow/deployment-orchestrator';
export * as rollbackManager from './ai-flow/rollback-manager';
