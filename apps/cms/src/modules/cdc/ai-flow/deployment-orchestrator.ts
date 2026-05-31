/**
 * Deployment orchestrator for the AI Flow Engine (ClickHouse CDC —
 * task 11.3; design "AI Flow Engine" §5, "Deployment Topology",
 * Requirements 7.2, 7.3, 7.7).
 *
 * The orchestrator turns a generated {@link EnvironmentConfig} (task 11.1)
 * into a running CDC deployment by provisioning each {@link ServiceDefinition}
 * as an ordered **step**, then running a post-deployment connectivity health
 * check. It owns the deploy flow end-to-end:
 *
 *   - **Step-by-step provisioning** — each service in the config becomes a
 *     {@link DeploymentStep}. Steps are ordered so a service's `dependsOn`
 *     dependencies are provisioned before it (e.g. for the Debezium approach:
 *     Kafka_Broker → Debezium_Connector → ClickHouse_Sink on a shared
 *     network, Req 7.3).
 *   - **Target scoping** (design "Deployment Topology", Req 7.2):
 *       - `docker_compose` (or managed services) provisions the **full
 *         stateful stack** for the approach (Kafka, Debezium, ClickHouse,
 *         Materialized Engine, Airbyte — whichever the approach uses).
 *       - `cloudflare_workers` provisions **ONLY the lightweight edge
 *         components** (the CDC API/control-plane endpoints and the
 *         Cache_Invalidator). The orchestrator MUST NOT attempt to deploy
 *         stateful connectors, the message bus, or replication engines to
 *         Workers — those live in a companion `docker_compose`/managed-services
 *         deployment. Any stateful service is therefore excluded from a
 *         Workers deployment's step sequence.
 *   - **Rollback on failure** (Req 7.6) — if step N fails, every step that
 *     completed before it (steps 1..N-1) is undone in **reverse** completion
 *     order, leaving no partially-provisioned resource behind. This satisfies
 *     Property 19 (task 11.5). The reverse-order rollback is exposed both as
 *     the orchestrator's built-in default and as the standalone
 *     {@link createReverseOrderRollback} factory.
 *   - **Post-deployment health check** (Req 7.7) — once every step completes,
 *     the orchestrator verifies each provisioned service is reachable within a
 *     30-second budget and reports a pass/fail result per service. A health
 *     check failure does NOT roll the deployment back (provisioning already
 *     succeeded); it is reported for the operator to investigate.
 *
 * **Decoupling & testability.** All side-effecting work is abstracted behind
 * small injectable collaborators — a {@link ServiceProvisioner}, a
 * {@link HealthChecker}, a {@link DeploymentRollbackHook}, a clock, an id
 * generator, and timer functions — each with an in-memory default. This lets
 * the step sequencing, target scoping, and rollback-trigger logic be
 * unit/property tested without real infrastructure, matching the style of the
 * sibling CDC connector modules.
 *
 * **Concurrency note (task 11.4).** This module deliberately owns the
 * deployment-step model ({@link DeploymentStep} / {@link DeploymentResult})
 * and the reverse-order rollback trigger, since the orchestrator owns the
 * deploy flow. It does NOT import the rollback manager. Task 11.4 can wire its
 * RollbackManager in by implementing the injectable {@link DeploymentRollbackHook}
 * (a no-op-free reverse-order default is provided), keeping the dependency
 * direction one-way and avoiding a merge race.
 *
 * Validates: Requirements 7.2, 7.3, 7.7
 */

import { nanoid } from 'nanoid';

import type { CdcConnectorType } from '../connectors/types';
import type {
  DeploymentTarget,
  EnvironmentConfig,
  ServiceDefinition,
} from './config-generator';

// ── time budgets (Requirements 7.3, 7.6, 7.7) ───────────────────────────

/**
 * Health-check budget (ms): a successful deployment must verify each service
 * is reachable within 30 seconds (Req 7.7).
 */
export const HEALTH_CHECK_BUDGET_MS = 30_000;

/**
 * Provisioning budget (ms) for the `docker_compose` stateful stack. The
 * Debezium+Kafka stack (Kafka_Broker, Debezium_Connector, ClickHouse_Sink)
 * must be reachable on a shared network within 120 seconds (Req 7.3). Exposed
 * for callers/tests; the in-memory default provisioner completes instantly, so
 * the orchestrator records elapsed time against this budget rather than
 * aborting on it.
 */
export const DOCKER_PROVISION_BUDGET_MS = 120_000;

/**
 * Rollback budget (ms): on a step failure, prior steps are rolled back within
 * 60 seconds (Req 7.6). Enforcement of the budget proper belongs to the
 * rollback manager (task 11.4); exposed here for reference.
 */
export const ROLLBACK_BUDGET_MS = 60_000;

// ── deployment-step model (owned here; consumed by tasks 11.4 & 11.5) ────

/**
 * Overall status of a deployment, mirroring the `cdcDeployments.status` column
 * in the data model (design "Data Models"):
 *
 *   - `'completed'`    — every step provisioned successfully (a health check
 *     was then run; see {@link DeploymentResult.health}).
 *   - `'failed'`       — a step failed and rollback could not undo every prior
 *     step (a partially-provisioned resource may remain).
 *   - `'rolled_back'`  — a step failed and all prior steps were successfully
 *     undone in reverse order.
 */
export type DeploymentStatus = 'completed' | 'failed' | 'rolled_back';

/**
 * Status of a single provisioning step.
 *
 *   - `'pending'`     — not yet attempted.
 *   - `'in_progress'` — currently provisioning.
 *   - `'completed'`   — provisioned successfully.
 *   - `'failed'`      — provisioning threw; carries {@link DeploymentStep.error}.
 *   - `'rolled_back'` — was completed, then undone after a later step failed.
 *   - `'skipped'`     — not attempted because an earlier step failed.
 */
export type DeploymentStepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'rolled_back'
  | 'skipped';

/**
 * Structured error attached to a failed step. `type` is a stable, programmatic
 * classifier (the thrown error's constructor name, falling back to
 * `'Error'`); `description` is the human-readable message. Together they
 * satisfy the Req 7.6 requirement to report "the failed step name, error type,
 * and error description".
 */
export interface DeploymentStepError {
  /** Programmatic error classifier (e.g. the error's constructor name). */
  readonly type: string;
  /** Human-readable error description. */
  readonly description: string;
}

/**
 * One provisioning step in a deployment. Serialisable so it can be persisted to
 * the `cdcDeployments.steps` jsonb column. Status/timestamp fields are mutated
 * by the orchestrator as the step progresses and reflect the final state in the
 * returned {@link DeploymentResult}.
 */
export interface DeploymentStep {
  /** Canonical service identifier this step provisions (e.g. `'kafka_broker'`). */
  readonly name: string;
  /** Human-readable display name (e.g. `'Kafka Broker'`). */
  readonly displayName: string;
  /** Whether the provisioned service is a stateful stack component. */
  readonly stateful: boolean;
  /** Current step status. */
  status: DeploymentStepStatus;
  /** ISO-8601 timestamp the step started provisioning, if it started. */
  startedAt?: string;
  /** ISO-8601 timestamp the step finished (completed/failed), if applicable. */
  completedAt?: string;
  /** Failure detail; present iff {@link status} is `'failed'`. */
  error?: DeploymentStepError;
}

/**
 * Connectivity status of a single service from the post-deployment health
 * check (Req 7.7).
 */
export interface ServiceHealthResult {
  /** Canonical service identifier. */
  readonly service: string;
  /** Whether the service was reachable within the health-check budget. */
  readonly reachable: boolean;
  /** Reason for unreachability; present only when `reachable` is `false`. */
  readonly reason?: string;
  /** Time taken to check this service, in milliseconds. */
  readonly checkedInMs: number;
}

/**
 * Result of the post-deployment connectivity health check (Req 7.7). Reports a
 * pass/fail result per service and whether the whole check completed within the
 * {@link HEALTH_CHECK_BUDGET_MS} budget.
 */
export interface HealthCheckReport {
  /** `true` iff every service was reachable (and the check stayed in budget). */
  readonly passed: boolean;
  /** Per-service reachability results, in step order. */
  readonly services: readonly ServiceHealthResult[];
  /** ISO-8601 timestamp the health check was performed. */
  readonly checkedAt: string;
  /** Whether the whole health check finished within {@link budgetMs}. */
  readonly withinBudget: boolean;
  /** The health-check time budget that applied (ms). */
  readonly budgetMs: number;
}

/**
 * Final outcome of {@link DeploymentOrchestrator.deploy}. Serialisable for the
 * `cdcDeployments` row. On a step failure, `failedStep`/`error` describe the
 * failure and `rolledBackSteps` lists the steps that were undone, in the order
 * they were undone (reverse completion order, Property 19).
 */
export interface DeploymentResult {
  /** Unique identifier for this deployment attempt. */
  readonly deploymentId: string;
  /** The CDC approach that was deployed. */
  readonly approach: CdcConnectorType;
  /** The deployment target the components were provisioned to. */
  readonly target: DeploymentTarget;
  /** Overall deployment status. */
  readonly status: DeploymentStatus;
  /** Every step, in provisioning order, with its final status. */
  readonly steps: readonly DeploymentStep[];
  /** Health-check report; present only when {@link status} is `'completed'`. */
  readonly health?: HealthCheckReport;
  /** Name of the step that failed; present when a step failed. */
  readonly failedStep?: string;
  /** Failure detail; present when a step failed. */
  readonly error?: DeploymentStepError;
  /** Names of steps undone during rollback, in reverse completion order. */
  readonly rolledBackSteps?: readonly string[];
  /** ISO-8601 timestamp the deployment started. */
  readonly startedAt: string;
  /** ISO-8601 timestamp the deployment finished. */
  readonly completedAt: string;
  /** Wall-clock duration of the deployment, in milliseconds. */
  readonly durationMs: number;
}

// ── injectable collaborators ─────────────────────────────────────────────

/**
 * Opaque handle to a resource provisioned for a single service. Returned by
 * {@link ServiceProvisioner.provision} and passed back to
 * {@link ServiceProvisioner.deprovision} during rollback so the same resource
 * can be released.
 */
export interface ProvisionedHandle {
  /** The service this handle belongs to. */
  readonly service: string;
  /** Implementation-defined reference to the provisioned resource. */
  readonly ref: string;
  /** Optional implementation-defined metadata. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Ambient context shared across every step of a single deployment. Passed to
 * the provisioner, health checker, and rollback hook.
 */
export interface DeploymentContext {
  /** The deployment's unique id. */
  readonly deploymentId: string;
  /** The CDC approach being deployed. */
  readonly approach: CdcConnectorType;
  /** The deployment target. */
  readonly target: DeploymentTarget;
  /** Effective environment values (variable defaults from the config). */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Provisions and deprovisions individual services. The default
 * {@link InMemoryServiceProvisioner} records calls in memory; a production
 * implementation would talk to Docker Compose / managed-service APIs / the
 * Cloudflare Workers deploy API.
 */
export interface ServiceProvisioner {
  /**
   * Provision a single service. Resolves with a {@link ProvisionedHandle} on
   * success; rejects (throws) to mark the step failed and trigger rollback.
   */
  provision(service: ServiceDefinition, ctx: DeploymentContext): Promise<ProvisionedHandle>;

  /**
   * Release a previously-provisioned service. Invoked in reverse order during
   * rollback. SHOULD be idempotent. A rejection is recorded as a failed
   * rollback for that step (a resource may remain).
   */
  deprovision(
    handle: ProvisionedHandle,
    service: ServiceDefinition,
    ctx: DeploymentContext,
  ): Promise<void>;
}

/** Reachability of a single service, returned by a {@link HealthChecker}. */
export interface ServiceReachability {
  /** Whether the service is reachable. */
  readonly reachable: boolean;
  /** Reason for unreachability; present only when `reachable` is `false`. */
  readonly reason?: string;
}

/**
 * Verifies connectivity to a provisioned service for the post-deployment
 * health check (Req 7.7). The default {@link InMemoryHealthChecker} reports
 * every service reachable unless told otherwise.
 */
export interface HealthChecker {
  check(service: ServiceDefinition, ctx: DeploymentContext): Promise<ServiceReachability>;
}

/**
 * A step that completed successfully, retained so it can be undone if a later
 * step fails. Passed to the rollback hook in completion order.
 */
export interface CompletedStepRecord {
  /** The completed step. */
  readonly step: DeploymentStep;
  /** The service definition that was provisioned. */
  readonly service: ServiceDefinition;
  /** The handle returned when the service was provisioned. */
  readonly handle: ProvisionedHandle;
}

/** Outcome of undoing a single completed step during rollback. */
export interface RolledBackStep {
  /** The service/step name that was (or could not be) undone. */
  readonly name: string;
  /** `true` if the resource was released; `false` if deprovision threw. */
  readonly undone: boolean;
  /** Reason a rollback failed; present only when `undone` is `false`. */
  readonly reason?: string;
}

/**
 * Injectable rollback collaborator. The deploy flow invokes this when a step
 * fails, passing the steps that completed *before* the failure in completion
 * order. Implementations MUST undo them in **reverse** completion order and
 * leave no partially-provisioned resource behind (Req 7.6 / Property 19).
 *
 * The orchestrator's built-in default ({@link createReverseOrderRollback}) and
 * task 11.4's RollbackManager both satisfy this contract; 11.4 can wire its
 * manager in via this hook without the orchestrator importing it.
 */
export interface DeploymentRollbackHook {
  /**
   * Undo `completed` steps in reverse completion order.
   *
   * @param completed - Steps that completed before the failure, in completion
   *   order (index 0 was provisioned first).
   * @param ctx - The deployment context.
   * @returns One {@link RolledBackStep} per completed step, in the order they
   *   were undone (reverse completion order).
   */
  rollback(
    completed: readonly CompletedStepRecord[],
    ctx: DeploymentContext,
  ): Promise<readonly RolledBackStep[]>;
}

/** Injectable timer functions (defaults to the global timers). */
export interface TimerFns {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

// ── default collaborators ─────────────────────────────────────────────────

/**
 * In-memory {@link ServiceProvisioner}. Records every provision/deprovision in
 * order and tracks which services are currently provisioned, so tests can
 * assert on the step sequence and on rollback completeness (no resource left
 * behind). Optional `failOn` / `failDeprovisionOn` sets inject failures.
 */
export class InMemoryServiceProvisioner implements ServiceProvisioner {
  /** Currently-provisioned services, keyed by service name. */
  readonly provisioned = new Map<string, ProvisionedHandle>();
  /** Service names in the order they were provisioned. */
  readonly provisionLog: string[] = [];
  /** Service names in the order they were deprovisioned (rollback order). */
  readonly deprovisionLog: string[] = [];

  private readonly failOn: ReadonlySet<string>;
  private readonly failDeprovisionOn: ReadonlySet<string>;

  constructor(opts?: {
    /** Service names whose `provision` should throw. */
    failOn?: Iterable<string>;
    /** Service names whose `deprovision` should throw. */
    failDeprovisionOn?: Iterable<string>;
  }) {
    this.failOn = new Set(opts?.failOn ?? []);
    this.failDeprovisionOn = new Set(opts?.failDeprovisionOn ?? []);
  }

  async provision(
    service: ServiceDefinition,
    ctx: DeploymentContext,
  ): Promise<ProvisionedHandle> {
    if (this.failOn.has(service.name)) {
      throw new Error(`simulated provisioning failure for service "${service.name}"`);
    }
    const handle: ProvisionedHandle = {
      service: service.name,
      ref: `${ctx.deploymentId}:${service.name}`,
    };
    this.provisioned.set(service.name, handle);
    this.provisionLog.push(service.name);
    return handle;
  }

  async deprovision(
    handle: ProvisionedHandle,
    service: ServiceDefinition,
  ): Promise<void> {
    if (this.failDeprovisionOn.has(service.name)) {
      throw new Error(`simulated deprovisioning failure for service "${service.name}"`);
    }
    this.provisioned.delete(service.name);
    this.deprovisionLog.push(service.name);
  }
}

/**
 * In-memory {@link HealthChecker}. Reports every service reachable unless its
 * name is listed in `unreachable`.
 */
export class InMemoryHealthChecker implements HealthChecker {
  private readonly unreachable: ReadonlySet<string>;

  constructor(opts?: { unreachable?: Iterable<string> }) {
    this.unreachable = new Set(opts?.unreachable ?? []);
  }

  async check(service: ServiceDefinition): Promise<ServiceReachability> {
    if (this.unreachable.has(service.name)) {
      return { reachable: false, reason: `service "${service.name}" is unreachable` };
    }
    return { reachable: true };
  }
}

/**
 * Build a reverse-order rollback hook backed by a {@link ServiceProvisioner}.
 * Undoes completed steps from last-completed to first-completed, releasing each
 * via {@link ServiceProvisioner.deprovision}. A deprovision failure is recorded
 * (with `undone: false`) but does not stop the remaining steps from being
 * rolled back, so as much as possible is cleaned up (Req 7.6 / Property 19).
 */
export function createReverseOrderRollback(
  provisioner: ServiceProvisioner,
): DeploymentRollbackHook {
  return {
    async rollback(completed, ctx) {
      const out: RolledBackStep[] = [];
      for (let i = completed.length - 1; i >= 0; i -= 1) {
        const record = completed[i]!;
        try {
          await provisioner.deprovision(record.handle, record.service, ctx);
          out.push({ name: record.step.name, undone: true });
        } catch (err) {
          out.push({
            name: record.step.name,
            undone: false,
            reason: errorMessage(err),
          });
        }
      }
      return out;
    },
  };
}

const defaultTimers: TimerFns = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// ── pure step-planning helpers (exposed for task 11.5) ───────────────────

/**
 * Select the services that should be provisioned for a config's target,
 * enforcing the deployment topology (Req 7.2):
 *
 *   - `cloudflare_workers` → **edge components only** (stateless services).
 *     Any stateful service is excluded so the orchestrator never attempts to
 *     deploy stateful connectors, the message bus, or replication engines to
 *     the Workers runtime.
 *   - `docker_compose` (or managed services) → the **full stateful stack** as
 *     listed in the config.
 *
 * Pure and deterministic: preserves the config's service order.
 */
export function selectDeployableServices(
  config: EnvironmentConfig,
): ServiceDefinition[] {
  if (config.target === 'cloudflare_workers') {
    return config.services.filter((service) => !service.stateful);
  }
  return [...config.services];
}

/**
 * Order services so every service's `dependsOn` dependencies precede it
 * (a stable topological sort that falls back to declaration order). This makes
 * the step sequence honour start-ordering — e.g. for Debezium: Kafka_Broker
 * before Debezium_Connector before ClickHouse_Sink (Req 7.3).
 *
 * Dependencies that are not part of the provided set are ignored (e.g. an edge
 * deployment that lists no stateful dependencies). Cyclic dependencies are
 * tolerated: the cycle is broken at the first already-visited node.
 *
 * Pure and deterministic.
 */
export function orderByDeploymentSteps(
  services: readonly ServiceDefinition[],
): ServiceDefinition[] {
  const byName = new Map(services.map((service) => [service.name, service]));
  const visited = new Set<string>();
  const ordered: ServiceDefinition[] = [];

  const visit = (service: ServiceDefinition): void => {
    if (visited.has(service.name)) return;
    visited.add(service.name);
    for (const depName of service.dependsOn ?? []) {
      const dependency = byName.get(depName);
      if (dependency) visit(dependency);
    }
    ordered.push(service);
  };

  for (const service of services) visit(service);
  return ordered;
}

/**
 * Compute the ordered list of services the orchestrator will provision for a
 * config — target scoping ({@link selectDeployableServices}) followed by
 * dependency ordering ({@link orderByDeploymentSteps}). Exposed so task 11.5
 * can drive the step sequence deterministically.
 */
export function planDeploymentSteps(
  config: EnvironmentConfig,
): ServiceDefinition[] {
  return orderByDeploymentSteps(selectDeployableServices(config));
}

// ── orchestrator dependencies ────────────────────────────────────────────

export interface DeploymentOrchestratorDeps {
  /** Provisions/deprovisions services. Default: {@link InMemoryServiceProvisioner}. */
  readonly provisioner?: ServiceProvisioner;
  /** Runs the post-deployment connectivity check. Default: {@link InMemoryHealthChecker}. */
  readonly healthChecker?: HealthChecker;
  /**
   * Rollback collaborator invoked on a step failure. Default: a reverse-order
   * rollback backed by the provisioner ({@link createReverseOrderRollback}).
   * Task 11.4's RollbackManager can be injected here.
   */
  readonly rollbackHook?: DeploymentRollbackHook;
  /** Monotonic clock returning epoch-ms. Default: `Date.now`. */
  readonly now?: () => number;
  /** Unique deployment-id generator. Default: `nanoid`. */
  readonly idGenerator?: () => string;
  /** Timer functions for the health-check timeout. Default: global timers. */
  readonly timers?: TimerFns;
  /** Health-check budget override (ms). Default: {@link HEALTH_CHECK_BUDGET_MS}. */
  readonly healthCheckBudgetMs?: number;
}

// ── orchestrator ───────────────────────────────────────────────────────────

/**
 * Orchestrates step-by-step provisioning of a CDC deployment, rolling back on
 * failure and running a post-deployment health check. Implements the
 * `deploy(config): Promise<DeploymentResult>` half of the AI Flow Engine's
 * `AiFlowEngine` interface (design §5).
 */
export class DeploymentOrchestrator {
  private readonly provisioner: ServiceProvisioner;
  private readonly healthChecker: HealthChecker;
  private readonly rollbackHook: DeploymentRollbackHook;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly timers: TimerFns;
  private readonly healthCheckBudgetMs: number;

  constructor(deps: DeploymentOrchestratorDeps = {}) {
    this.provisioner = deps.provisioner ?? new InMemoryServiceProvisioner();
    this.healthChecker = deps.healthChecker ?? new InMemoryHealthChecker();
    // Default rollback undoes completed steps in reverse order via the same
    // provisioner used to create them.
    this.rollbackHook = deps.rollbackHook ?? createReverseOrderRollback(this.provisioner);
    this.now = deps.now ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => nanoid());
    this.timers = deps.timers ?? defaultTimers;
    this.healthCheckBudgetMs = deps.healthCheckBudgetMs ?? HEALTH_CHECK_BUDGET_MS;
  }

  /**
   * Compute the ordered services the orchestrator would provision for a config,
   * without provisioning anything. Thin instance wrapper over
   * {@link planDeploymentSteps}; useful for previews and tests.
   */
  planSteps(config: EnvironmentConfig): ServiceDefinition[] {
    return planDeploymentSteps(config);
  }

  /**
   * Deploy a CDC {@link EnvironmentConfig}:
   *
   *   1. Scope the services to the target and order them by dependency
   *      ({@link planDeploymentSteps}).
   *   2. Provision each service in order, recording a {@link DeploymentStep}.
   *   3. If a step fails, mark the remaining steps `skipped` and roll back the
   *      completed steps in reverse order (Req 7.6 / Property 19). Returns a
   *      `rolled_back` (or `failed`, if rollback could not undo everything)
   *      result with the failed step name, error type, and description.
   *   4. If every step completes, run the post-deployment connectivity health
   *      check (Req 7.7) and return a `completed` result with the per-service
   *      pass/fail report.
   *
   * @param config - The generated environment config to deploy.
   * @returns The deployment outcome.
   */
  async deploy(config: EnvironmentConfig): Promise<DeploymentResult> {
    const deploymentId = this.idGenerator();
    const startedAtMs = this.now();

    const ctx: DeploymentContext = {
      deploymentId,
      approach: config.approach,
      target: config.target,
      env: buildEnv(config),
    };

    const services = planDeploymentSteps(config);
    const steps: DeploymentStep[] = services.map((service) => ({
      name: service.name,
      displayName: service.displayName,
      stateful: service.stateful,
      status: 'pending',
    }));

    const completed: CompletedStepRecord[] = [];
    let failureIndex = -1;
    let failureError: DeploymentStepError | undefined;

    // ── step-by-step provisioning ──────────────────────────────────────
    for (let i = 0; i < services.length; i += 1) {
      const service = services[i]!;
      const step = steps[i]!;
      step.status = 'in_progress';
      step.startedAt = this.iso(this.now());

      try {
        const handle = await this.provisioner.provision(service, ctx);
        step.status = 'completed';
        step.completedAt = this.iso(this.now());
        completed.push({ step, service, handle });
      } catch (err) {
        failureError = toStepError(err);
        step.status = 'failed';
        step.completedAt = this.iso(this.now());
        step.error = failureError;
        failureIndex = i;
        break;
      }
    }

    // ── failure path → rollback completed steps in reverse order ────────
    if (failureIndex >= 0) {
      for (let j = failureIndex + 1; j < steps.length; j += 1) {
        steps[j]!.status = 'skipped';
      }

      const rolledBack = await this.rollbackHook.rollback(completed, ctx);
      const undoneNames = new Set(
        rolledBack.filter((r) => r.undone).map((r) => r.name),
      );
      for (const record of completed) {
        if (undoneNames.has(record.step.name)) {
          record.step.status = 'rolled_back';
        }
      }

      // If every completed step was undone, the deployment is cleanly
      // rolled back; otherwise a resource may remain → `failed` (Req 7.6).
      const fullyRolledBack = completed.every((record) =>
        undoneNames.has(record.step.name),
      );
      const completedAtMs = this.now();

      return {
        deploymentId,
        approach: config.approach,
        target: config.target,
        status: fullyRolledBack ? 'rolled_back' : 'failed',
        steps,
        failedStep: services[failureIndex]!.name,
        error: failureError,
        rolledBackSteps: rolledBack.filter((r) => r.undone).map((r) => r.name),
        startedAt: this.iso(startedAtMs),
        completedAt: this.iso(completedAtMs),
        durationMs: completedAtMs - startedAtMs,
      };
    }

    // ── success path → post-deployment health check (Req 7.7) ───────────
    const health = await this.runHealthCheck(services, ctx);
    const completedAtMs = this.now();

    return {
      deploymentId,
      approach: config.approach,
      target: config.target,
      status: 'completed',
      steps,
      health,
      startedAt: this.iso(startedAtMs),
      completedAt: this.iso(completedAtMs),
      durationMs: completedAtMs - startedAtMs,
    };
  }

  /**
   * Run the post-deployment connectivity health check (Req 7.7): verify each
   * provisioned service is reachable within the {@link healthCheckBudgetMs}
   * budget and report a pass/fail result per service. A check that exceeds the
   * budget is reported as unreachable for the offending service(s) and marks
   * the whole report out of budget.
   */
  private async runHealthCheck(
    services: readonly ServiceDefinition[],
    ctx: DeploymentContext,
  ): Promise<HealthCheckReport> {
    const start = this.now();

    const results = await Promise.all(
      services.map(async (service): Promise<ServiceHealthResult> => {
        const t0 = this.now();
        try {
          const reachability = await this.raceBudget(
            this.healthChecker.check(service, ctx),
            this.healthCheckBudgetMs,
          );
          return {
            service: service.name,
            reachable: reachability.reachable,
            reason: reachability.reason,
            checkedInMs: this.now() - t0,
          };
        } catch (err) {
          return {
            service: service.name,
            reachable: false,
            reason: errorMessage(err),
            checkedInMs: this.now() - t0,
          };
        }
      }),
    );

    const elapsed = this.now() - start;
    const withinBudget = elapsed <= this.healthCheckBudgetMs;

    return {
      passed: withinBudget && results.every((r) => r.reachable),
      services: results,
      checkedAt: this.iso(start),
      withinBudget,
      budgetMs: this.healthCheckBudgetMs,
    };
  }

  /**
   * Resolve `promise`, rejecting with a {@link HealthCheckTimeoutError} if it
   * does not settle within `budgetMs`. Uses the injectable timers so tests stay
   * deterministic; the timer is always cleared.
   */
  private raceBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const handle = this.timers.setTimeout(() => {
        reject(new HealthCheckTimeoutError(budgetMs));
      }, budgetMs);
      promise.then(
        (value) => {
          this.timers.clearTimeout(handle);
          resolve(value);
        },
        (err) => {
          this.timers.clearTimeout(handle);
          reject(err);
        },
      );
    });
  }

  /** Format an epoch-ms instant as an ISO-8601 string using the clock. */
  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }
}

// ── errors ─────────────────────────────────────────────────────────────────

/** Raised when a health check exceeds its time budget (Req 7.7). */
export class HealthCheckTimeoutError extends Error {
  constructor(budgetMs: number) {
    super(`health check exceeded ${budgetMs}ms budget`);
    this.name = 'HealthCheckTimeoutError';
  }
}

// ── internal helpers ─────────────────────────────────────────────────────

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Convert an unknown thrown value into a structured {@link DeploymentStepError}. */
function toStepError(err: unknown): DeploymentStepError {
  if (err instanceof Error) {
    return { type: err.name || 'Error', description: err.message };
  }
  return { type: 'Error', description: String(err) };
}

/**
 * Build the effective environment map for a deployment from a config's variable
 * defaults. Operator-supplied overrides are validated/applied elsewhere
 * (task 11.2); here we surface the declared defaults so provisioners have a
 * baseline context.
 */
function buildEnv(config: EnvironmentConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const variable of config.variables) {
    if (variable.default !== undefined) {
      env[variable.key] = variable.default;
    }
  }
  return env;
}
