/**
 * Deployment rollback manager for the AI Flow Engine (ClickHouse CDC —
 * task 11.4; design "AI Flow Engine" §5, "AI Flow Engine Errors" table,
 * Requirement 7.6).
 *
 * When a deployment step fails, the AI Flow Engine MUST roll back all
 * previously completed steps within 60 seconds, in **reverse order**, leave
 * **no partially-provisioned resources** behind, and report the **failed
 * step name, error type, and error description** (Req 7.6).
 *
 * This module owns that teardown logic. Like its sibling
 * {@link file://./env-validator.ts | env-validator} it is intentionally
 * **decoupled** from the concurrently-developed Deployment Orchestrator
 * (task 11.3):
 *
 *   - It does NOT import `deployment-orchestrator.ts`. Doing so would create
 *     a merge race (the orchestrator owns the `DeploymentStep` /
 *     `DeploymentResult` model) and a circular import.
 *   - Instead it defines a minimal, structural {@link RollbackableStep}
 *     shape — a `name`, the `resources` the step provisioned, and an
 *     optional self-contained `undo` hook. The orchestrator's richer step
 *     type remains assignable to this shape by structural typing, so the two
 *     reconcile without a hard dependency. The orchestrator resolves a
 *     `deploymentId` to its ordered list of completed steps and calls
 *     {@link RollbackManager.rollback}.
 *
 * The actual teardown of each step is delegated to an injectable
 * {@link StepUndoer} collaborator (an {@link InMemoryStepUndoer} by default),
 * mirroring how `pipeline-registry.ts` injects a `ConnectivityChecker` and
 * `health-monitor.ts` injects its metrics/notification collaborators. The
 * 60-second budget is enforced through an injectable clock and timers
 * (matching `health-monitor.ts`), so the reverse-order teardown,
 * partial-resource accounting, and budget enforcement can all be
 * unit/property tested (task 11.5, Property 19) without live infrastructure.
 *
 * Validates: Requirements 7.6
 */

// ── constants ───────────────────────────────────────────────────────────

/**
 * Wall-clock budget for a complete rollback: 60 seconds (Req 7.6). The
 * rollback of all previously completed steps must finish within this window.
 */
export const ROLLBACK_BUDGET_MS = 60_000;

// ── resource model (decoupled subset of connectors' ProvisionedResource) ──

/**
 * Reference to a single resource that a deployment step provisioned (e.g. a
 * Kafka topic, a PostgreSQL replication slot, an Airbyte connection).
 *
 * This is the minimal shape the rollback manager needs to account for
 * "no partially-provisioned resources remain" (Req 7.6). It is a structural
 * subset of the connectors' `ProvisionedResource`
 * (`apps/cms/src/modules/cdc/connectors/types.ts`), so a richer resource
 * descriptor remains assignable here without an import-level dependency.
 */
export interface ProvisionedResourceRef {
  /** Resource type identifier (e.g. `'kafka_topic'`, `'replication_slot'`). */
  readonly type: string;

  /** Unique identifier of the provisioned resource. */
  readonly id: string;
}

/** Stable identity key for a {@link ProvisionedResourceRef} (`type:id`). */
function resourceKey(resource: ProvisionedResourceRef): string {
  return `${resource.type}:${resource.id}`;
}

// ── step model (decoupled from the orchestrator's DeploymentStep) ─────────

/**
 * A completed deployment step that can be undone during rollback. This is the
 * minimal, structural shape the rollback manager operates on; the Deployment
 * Orchestrator's `DeploymentStep` (task 11.3) is assignable to it.
 */
export interface RollbackableStep {
  /** Human-readable step name (e.g. `'provision_kafka_broker'`). */
  readonly name: string;

  /**
   * Resources this step provisioned, if any. Used for partial-resource
   * accounting: when a step is successfully undone its resources are
   * considered released; resources of steps that could not be undone are
   * reported in {@link RollbackResult.remainingResources}.
   */
  readonly resources?: readonly ProvisionedResourceRef[];

  /**
   * Optional self-contained teardown for this step. Invoked by the default
   * {@link InMemoryStepUndoer}. A custom {@link StepUndoer} may ignore this
   * and tear the step down by other means (e.g. by calling the matching
   * connector's `destroy`). May be synchronous or asynchronous; a thrown
   * error (or rejection) marks the step as failed to undo.
   */
  readonly undo?: () => Promise<void> | void;
}

/**
 * Description of the step that failed and triggered the rollback. Carries the
 * triggering `error` (so its type and description can be reported, Req 7.6)
 * and any resources the failed step **partially** provisioned before failing,
 * so they too can be cleaned up ("no partially-provisioned resources remain").
 */
export interface FailedStep {
  /** Name of the step that failed (reported as {@link RollbackFailure.stepName}). */
  readonly name: string;

  /** The error that caused the step to fail. Used to classify type + description. */
  readonly error: unknown;

  /** Resources the failed step provisioned before failing, if any. */
  readonly resources?: readonly ProvisionedResourceRef[];

  /**
   * Optional teardown for the failed step's partial resources. Invoked the
   * same way as {@link RollbackableStep.undo}.
   */
  readonly undo?: () => Promise<void> | void;
}

/** Input to {@link RollbackManager.rollback}. */
export interface RollbackInput {
  /**
   * Steps that completed successfully, in **completion order** (the first
   * step that ran is first). The manager rolls these back in reverse order.
   */
  readonly completedSteps: readonly RollbackableStep[];

  /** The step that failed, triggering the rollback. */
  readonly failedStep: FailedStep;
}

// ── undo collaborator ─────────────────────────────────────────────────────

/**
 * Collaborator that knows how to tear down a single step. Injected into the
 * {@link RollbackManager} so production code can delegate to real connector
 * teardown (e.g. `connector.destroy(pipelineId)`) while tests use the
 * in-memory default.
 *
 * `undo` resolves when the step's resources have been released and rejects
 * (throws) if teardown fails — the manager then reports that step as failed
 * and keeps its resources in {@link RollbackResult.remainingResources}.
 */
export interface StepUndoer {
  /**
   * Tear down a single step's provisioned resources.
   *
   * @param step - The step to undo.
   * @throws If teardown fails (the step's resources are then treated as not
   *   released).
   */
  undo(step: RollbackableStep): Promise<void>;
}

/**
 * Default in-memory {@link StepUndoer}. Invokes a step's own
 * {@link RollbackableStep.undo} hook (if present) and **records the
 * reverse-order teardown** so tests can assert that steps were undone in the
 * correct order (Property 19). Holds no external state — suitable as a
 * deterministic default for unit/property tests.
 */
export class InMemoryStepUndoer implements StepUndoer {
  private readonly _teardownOrder: string[] = [];

  /** Names of the steps that were successfully torn down, in teardown order. */
  get teardownOrder(): readonly string[] {
    return [...this._teardownOrder];
  }

  async undo(step: RollbackableStep): Promise<void> {
    // Delegate to the step's self-contained teardown when provided. A thrown
    // error propagates so the manager can record the step as failed (and the
    // step name is NOT recorded as torn down).
    if (step.undo) {
      await step.undo();
    }
    this._teardownOrder.push(step.name);
  }

  /** Clear the recorded teardown order (useful between test cases). */
  reset(): void {
    this._teardownOrder.length = 0;
  }
}

// ── timer abstraction (matches health-monitor.ts) ─────────────────────────

/** One-shot timer abstraction used to bound each step's teardown latency. */
export interface RollbackTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Default {@link RollbackTimers} backed by `setTimeout`/`clearTimeout`. */
const defaultRollbackTimers: RollbackTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    // Don't keep the event loop alive solely for a rollback timeout.
    if (typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

// ── result model ──────────────────────────────────────────────────────────

/**
 * The failure that triggered the rollback, classified for reporting
 * (Req 7.6): failed step name, error type, and error description.
 */
export interface RollbackFailure {
  /** Name of the deployment step that failed. */
  readonly stepName: string;

  /**
   * Error type — the error's class/constructor name (e.g. `'Error'`,
   * `'TypeError'`) or a primitive type tag for non-`Error` throwables.
   */
  readonly errorType: string;

  /** Human-readable error description (e.g. the `Error.message`). */
  readonly description: string;
}

/** Outcome of undoing a single step during rollback. */
export interface RollbackStepOutcome {
  /** The step's name. */
  readonly stepName: string;

  /**
   * - `'undone'`   — the step was successfully torn down.
   * - `'failed'`   — teardown threw or timed out; resources may remain.
   * - `'skipped'`  — not attempted because the 60s budget was exhausted.
   */
  readonly status: 'undone' | 'failed' | 'skipped';

  /** Error type, present when `status` is `'failed'`. */
  readonly errorType?: string;

  /** Reason, present when `status` is `'failed'` or `'skipped'`. */
  readonly description?: string;

  /** Resources released by this step (non-empty only when `status` is `'undone'`). */
  readonly releasedResources: readonly ProvisionedResourceRef[];
}

/**
 * Result of a {@link RollbackManager.rollback} call. Reports the triggering
 * failure (Req 7.6), the per-step teardown outcomes in reverse order, any
 * resources that could not be released, and whether the rollback finished
 * within the 60-second budget.
 */
export interface RollbackResult {
  /**
   * `true` iff the failed step's partial resources and every completed step
   * were torn down within budget, leaving no partially-provisioned resources.
   */
  readonly success: boolean;

  /** The failure that triggered the rollback (failed step + error type + description). */
  readonly failure: RollbackFailure;

  /**
   * Cleanup outcome for the **failed step's** partial resources. `null` when
   * the failed step provisioned nothing to clean up. Processed first, since
   * the failed step is the most recently attempted (full reverse order).
   */
  readonly failedStepCleanup: RollbackStepOutcome | null;

  /**
   * Outcomes for the previously **completed** steps, in **teardown (reverse)
   * order** — the last-completed step first, the first-completed step last
   * (Req 7.6 / Property 19).
   */
  readonly rolledBackSteps: readonly RollbackStepOutcome[];

  /**
   * Resources that could NOT be released (from steps that failed to undo or
   * were skipped). An **empty** array means no partially-provisioned
   * resources remain (Req 7.6 / Property 19).
   */
  readonly remainingResources: readonly ProvisionedResourceRef[];

  /** Whether the rollback finished within {@link ROLLBACK_BUDGET_MS} (Req 7.6). */
  readonly withinBudget: boolean;

  /** Total elapsed time in ms, per the injectable clock. */
  readonly durationMs: number;
}

// ── error classification ───────────────────────────────────────────────────

/**
 * Classify an arbitrary thrown value into a stable `errorType` and a
 * human-readable `description` (Req 7.6). Handles `Error` instances
 * (preferring the constructor `name`), plain strings, and any other value.
 *
 * @param error - The thrown value to classify.
 * @returns The error type tag and description.
 */
export function classifyError(error: unknown): { errorType: string; description: string } {
  if (error instanceof Error) {
    return {
      // Prefer the constructor name over the (settable) `name` property when
      // they diverge, so subclasses report their real type.
      errorType: error.name || error.constructor?.name || 'Error',
      description: error.message || error.name || 'Unknown error',
    };
  }
  if (typeof error === 'string') {
    return { errorType: 'string', description: error };
  }
  if (error === null) {
    return { errorType: 'null', description: 'null' };
  }
  if (error === undefined) {
    return { errorType: 'undefined', description: 'undefined' };
  }
  return { errorType: typeof error, description: safeStringify(error) };
}

/** Best-effort string form of a non-`Error` throwable for the description. */
function safeStringify(value: unknown): string {
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}

// ── dependencies ────────────────────────────────────────────────────────────

/** Injectable collaborators for {@link RollbackManager}. */
export interface RollbackManagerDeps {
  /**
   * Teardown collaborator. Defaults to a fresh {@link InMemoryStepUndoer}.
   * In production the orchestrator injects an undoer that delegates to the
   * matching connector's `destroy`.
   */
  readonly undoer?: StepUndoer;

  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  readonly clock?: () => number;

  /** One-shot timers used to bound each step's teardown. Defaults to `setTimeout`. */
  readonly timers?: RollbackTimers;

  /**
   * Total rollback budget in ms (Req 7.6). Defaults to
   * {@link ROLLBACK_BUDGET_MS} (60 000 ms).
   */
  readonly budgetMs?: number;
}

// ── rollback manager ────────────────────────────────────────────────────────

/**
 * Rolls back the completed steps of a failed deployment in reverse order,
 * within a 60-second budget, ensuring no partially-provisioned resources
 * remain and reporting the failed step name, error type, and description
 * (Req 7.6).
 *
 * The class is decoupled from the Deployment Orchestrator: the orchestrator
 * resolves a `deploymentId` to its ordered completed steps and the failed
 * step, then calls {@link rollback}. All teardown is delegated to the
 * injected {@link StepUndoer}.
 */
export class RollbackManager {
  private readonly undoer: StepUndoer;
  private readonly clock: () => number;
  private readonly timers: RollbackTimers;
  private readonly budgetMs: number;

  constructor(deps: RollbackManagerDeps = {}) {
    this.undoer = deps.undoer ?? new InMemoryStepUndoer();
    this.clock = deps.clock ?? (() => Date.now());
    this.timers = deps.timers ?? defaultRollbackTimers;
    this.budgetMs = deps.budgetMs ?? ROLLBACK_BUDGET_MS;
  }

  /**
   * Roll back a failed deployment.
   *
   * Teardown proceeds in strict reverse order of provisioning:
   *
   *   1. The **failed step's** partial resources are cleaned up first (it was
   *      the most recently attempted step).
   *   2. The previously **completed** steps are undone in reverse completion
   *      order (last-completed first).
   *
   * The whole operation is bounded by the 60-second budget (Req 7.6): once the
   * budget is exhausted, any remaining steps are reported as `'skipped'` and
   * their resources are listed in {@link RollbackResult.remainingResources}.
   * Each individual teardown is additionally bounded by the remaining budget,
   * so a single hung teardown cannot exceed the window.
   *
   * The method never throws for an ordinary teardown failure — such failures
   * are captured per-step in the returned {@link RollbackResult} so the caller
   * (and Property 19) can inspect exactly what remains.
   *
   * @param input - The completed steps (in completion order) and the failed step.
   * @returns A {@link RollbackResult} describing the teardown.
   */
  async rollback(input: RollbackInput): Promise<RollbackResult> {
    const startedAt = this.clock();
    const deadline = startedAt + this.budgetMs;

    const failure: RollbackFailure = {
      stepName: input.failedStep.name,
      ...classifyError(input.failedStep.error),
    };

    const remaining: ProvisionedResourceRef[] = [];
    const remainingKeys = new Set<string>();
    const recordRemaining = (resources: readonly ProvisionedResourceRef[] | undefined): void => {
      for (const resource of resources ?? []) {
        const key = resourceKey(resource);
        if (!remainingKeys.has(key)) {
          remainingKeys.add(key);
          remaining.push(resource);
        }
      }
    };

    let budgetExhausted = false;

    /**
     * Attempt to undo one step within the remaining budget. Returns the
     * outcome; mutates `budgetExhausted` / `remaining` as a side effect.
     */
    const undoOne = async (step: RollbackableStep): Promise<RollbackStepOutcome> => {
      const remainingMs = deadline - this.clock();

      if (budgetExhausted || remainingMs <= 0) {
        budgetExhausted = true;
        recordRemaining(step.resources);
        return {
          stepName: step.name,
          status: 'skipped',
          description: `rollback budget of ${this.budgetMs}ms exhausted before this step`,
          releasedResources: [],
        };
      }

      try {
        await this.withTimeout(
          Promise.resolve(this.undoer.undo(step)),
          remainingMs,
        );
        return {
          stepName: step.name,
          status: 'undone',
          releasedResources: step.resources ?? [],
        };
      } catch (err) {
        const { errorType, description } = classifyError(err);
        // A timeout consumes the remaining budget; subsequent steps are skipped.
        if (this.clock() >= deadline) {
          budgetExhausted = true;
        }
        recordRemaining(step.resources);
        return {
          stepName: step.name,
          status: 'failed',
          errorType,
          description,
          releasedResources: [],
        };
      }
    };

    // 1. Clean up the failed step's partial resources first (full reverse order).
    let failedStepCleanup: RollbackStepOutcome | null = null;
    const failedHasWork =
      input.failedStep.undo !== undefined ||
      (input.failedStep.resources?.length ?? 0) > 0;
    if (failedHasWork) {
      failedStepCleanup = await undoOne({
        name: input.failedStep.name,
        resources: input.failedStep.resources,
        undo: input.failedStep.undo,
      });
    }

    // 2. Undo the completed steps in reverse completion order.
    const rolledBackSteps: RollbackStepOutcome[] = [];
    for (let i = input.completedSteps.length - 1; i >= 0; i--) {
      rolledBackSteps.push(await undoOne(input.completedSteps[i]));
    }

    const durationMs = this.clock() - startedAt;
    const withinBudget = !budgetExhausted && durationMs <= this.budgetMs;

    const allUndone =
      (failedStepCleanup === null || failedStepCleanup.status === 'undone') &&
      rolledBackSteps.every((s) => s.status === 'undone');

    return {
      success: allUndone && withinBudget && remaining.length === 0,
      failure,
      failedStepCleanup,
      rolledBackSteps,
      remainingResources: remaining,
      withinBudget,
      durationMs,
    };
  }

  /**
   * Resolve a promise within `ms`, rejecting with a timeout error otherwise.
   * Uses the injectable {@link RollbackTimers} so tests can drive timeouts
   * deterministically (mirrors `health-monitor.ts`).
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const handle = this.timers.setTimeout(() => {
        reject(new Error(`step teardown timed out after ${ms}ms`));
      }, ms);
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
}
