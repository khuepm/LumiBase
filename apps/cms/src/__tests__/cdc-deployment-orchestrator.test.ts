import { describe, it, expect } from 'vitest';

import { generateConfig } from '../modules/cdc/ai-flow/config-generator';
import {
  DeploymentOrchestrator,
  InMemoryServiceProvisioner,
  InMemoryHealthChecker,
  createReverseOrderRollback,
  selectDeployableServices,
  orderByDeploymentSteps,
  planDeploymentSteps,
  HealthCheckTimeoutError,
  HEALTH_CHECK_BUDGET_MS,
  type DeploymentContext,
  type CompletedStepRecord,
  type DeploymentRollbackHook,
  type ProvisionedHandle,
  type RolledBackStep,
} from '../modules/cdc/ai-flow/deployment-orchestrator';
import type { ServiceDefinition } from '../modules/cdc/ai-flow/config-generator';

// ── deterministic helpers ─────────────────────────────────────────────────

/** A monotonically-advancing clock so timestamps/durations are deterministic. */
function fakeClock(startMs = 0, stepMs = 1): () => number {
  let t = startMs;
  return () => {
    const now = t;
    t += stepMs;
    return now;
  };
}

function makeOrchestrator(
  overrides: ConstructorParameters<typeof DeploymentOrchestrator>[0] = {},
): DeploymentOrchestrator {
  let counter = 0;
  return new DeploymentOrchestrator({
    now: fakeClock(),
    idGenerator: () => `dep_${(counter += 1)}`,
    ...overrides,
  });
}

// ── step planning: target scoping (Req 7.2) ───────────────────────────────

describe('selectDeployableServices (Req 7.2 — target scoping)', () => {
  it('returns the full stateful stack for docker_compose', () => {
    const config = generateConfig('debezium_kafka', 'docker_compose');
    const selected = selectDeployableServices(config);

    expect(selected.map((s) => s.name)).toEqual(
      config.services.map((s) => s.name),
    );
    // Every Debezium docker_compose service is stateful.
    expect(selected.every((s) => s.stateful)).toBe(true);
  });

  it('excludes ALL stateful services for cloudflare_workers (edge components only)', () => {
    const config = generateConfig('debezium_kafka', 'cloudflare_workers');
    const selected = selectDeployableServices(config);

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((s) => !s.stateful)).toBe(true);
    // Edge deployment must never include the message bus / connectors.
    expect(selected.map((s) => s.name)).not.toContain('kafka_broker');
    expect(selected.map((s) => s.name)).not.toContain('debezium_connector');
    expect(selected.map((s) => s.name)).toContain('cache_invalidator');
  });
});

// ── step planning: dependency ordering (Req 7.3) ───────────────────────────

describe('orderByDeploymentSteps (Req 7.3 — dependency ordering)', () => {
  it('orders Debezium so Kafka precedes Debezium connector', () => {
    const config = generateConfig('debezium_kafka', 'docker_compose');
    const ordered = orderByDeploymentSteps(config.services).map((s) => s.name);

    expect(ordered.indexOf('kafka_broker')).toBeLessThan(
      ordered.indexOf('debezium_connector'),
    );
  });

  it('orders materialized engine after the clickhouse sink it depends on', () => {
    const config = generateConfig('materialized_engine', 'docker_compose');
    const ordered = orderByDeploymentSteps(config.services).map((s) => s.name);

    expect(ordered.indexOf('clickhouse_sink')).toBeLessThan(
      ordered.indexOf('materialized_engine'),
    );
  });

  it('is stable / deterministic for inputs without dependencies', () => {
    const services: ServiceDefinition[] = [
      { name: 'a', displayName: 'A', description: '', stateful: false },
      { name: 'b', displayName: 'B', description: '', stateful: false },
    ];
    expect(orderByDeploymentSteps(services).map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('tolerates a dependency cycle without infinite recursion', () => {
    const services: ServiceDefinition[] = [
      { name: 'a', displayName: 'A', description: '', stateful: true, dependsOn: ['b'] },
      { name: 'b', displayName: 'B', description: '', stateful: true, dependsOn: ['a'] },
    ];
    const ordered = orderByDeploymentSteps(services).map((s) => s.name);
    expect(ordered.sort()).toEqual(['a', 'b']);
  });
});

// ── happy-path deploy + health check (Req 7.3, 7.7) ────────────────────────

describe('DeploymentOrchestrator.deploy — success path', () => {
  it('provisions every stateful service in dependency order and passes health check', async () => {
    const provisioner = new InMemoryServiceProvisioner();
    const orchestrator = makeOrchestrator({ provisioner });
    const config = generateConfig('debezium_kafka', 'docker_compose');

    const result = await orchestrator.deploy(config);

    expect(result.status).toBe('completed');
    expect(result.steps.every((s) => s.status === 'completed')).toBe(true);

    // Provision order honours dependencies (Kafka before Debezium).
    expect(provisioner.provisionLog.indexOf('kafka_broker')).toBeLessThan(
      provisioner.provisionLog.indexOf('debezium_connector'),
    );

    // Post-deploy health check ran and passed per service (Req 7.7).
    expect(result.health?.passed).toBe(true);
    expect(result.health?.withinBudget).toBe(true);
    expect(result.health?.services.map((s) => s.service)).toEqual(
      planDeploymentSteps(config).map((s) => s.name),
    );
    expect(result.health?.services.every((s) => s.reachable)).toBe(true);
  });

  it('deploys ONLY edge components for cloudflare_workers', async () => {
    const provisioner = new InMemoryServiceProvisioner();
    const orchestrator = makeOrchestrator({ provisioner });
    const config = generateConfig('debezium_kafka', 'cloudflare_workers');

    const result = await orchestrator.deploy(config);

    expect(result.status).toBe('completed');
    expect(provisioner.provisionLog).not.toContain('kafka_broker');
    expect(provisioner.provisionLog).not.toContain('debezium_connector');
    expect(provisioner.provisionLog).toContain('cache_invalidator');
    expect(result.steps.every((s) => !s.stateful)).toBe(true);
  });

  it('reports per-service pass/fail when a service is unreachable (Req 7.7)', async () => {
    const orchestrator = makeOrchestrator({
      healthChecker: new InMemoryHealthChecker({ unreachable: ['clickhouse_sink'] }),
    });
    const config = generateConfig('debezium_kafka', 'docker_compose');

    const result = await orchestrator.deploy(config);

    // Provisioning still completed — a health-check failure does not roll back.
    expect(result.status).toBe('completed');
    expect(result.health?.passed).toBe(false);
    const sink = result.health?.services.find((s) => s.service === 'clickhouse_sink');
    expect(sink?.reachable).toBe(false);
    expect(sink?.reason).toContain('clickhouse_sink');
  });
});

// ── failure path → reverse-order rollback (Req 7.6 / Property 19) ──────────

describe('DeploymentOrchestrator.deploy — failure path & rollback', () => {
  it('rolls back completed steps in reverse order when a step fails', async () => {
    const config = generateConfig('debezium_kafka', 'docker_compose');
    const ordered = planDeploymentSteps(config).map((s) => s.name);
    // Fail the 2nd step so step 1 must be rolled back.
    const failing = ordered[1]!;
    const provisioner = new InMemoryServiceProvisioner({ failOn: [failing] });
    const orchestrator = makeOrchestrator({ provisioner });

    const result = await orchestrator.deploy(config);

    expect(result.status).toBe('rolled_back');
    expect(result.failedStep).toBe(failing);
    expect(result.error?.type).toBe('Error');

    // The single completed step (step 1) was undone.
    expect(result.rolledBackSteps).toEqual([ordered[0]]);
    // Reverse completion order: provisioned [step0], deprovisioned [step0].
    expect(provisioner.deprovisionLog).toEqual([ordered[0]]);
    // No resource left behind.
    expect(provisioner.provisioned.size).toBe(0);

    // Steps after the failure are skipped.
    expect(result.steps[1]!.status).toBe('failed');
    for (let i = 2; i < result.steps.length; i += 1) {
      expect(result.steps[i]!.status).toBe('skipped');
    }
    expect(result.steps[0]!.status).toBe('rolled_back');
  });

  it('undoes multiple completed steps last-in-first-out', async () => {
    const config = generateConfig('debezium_kafka', 'docker_compose');
    const ordered = planDeploymentSteps(config).map((s) => s.name);
    expect(ordered.length).toBeGreaterThanOrEqual(3);

    // Fail the LAST step → steps 1..N-1 must be rolled back in reverse.
    const failing = ordered[ordered.length - 1]!;
    const provisioner = new InMemoryServiceProvisioner({ failOn: [failing] });
    const orchestrator = makeOrchestrator({ provisioner });

    const result = await orchestrator.deploy(config);

    const completedBeforeFailure = ordered.slice(0, ordered.length - 1);
    expect(result.status).toBe('rolled_back');
    expect(provisioner.deprovisionLog).toEqual([...completedBeforeFailure].reverse());
    expect(provisioner.provisioned.size).toBe(0);
  });

  it('marks status "failed" (not "rolled_back") when a deprovision leaves a resource', async () => {
    const config = generateConfig('debezium_kafka', 'docker_compose');
    const ordered = planDeploymentSteps(config).map((s) => s.name);
    const failing = ordered[ordered.length - 1]!;
    // Step 0 cannot be deprovisioned → a resource remains.
    const provisioner = new InMemoryServiceProvisioner({
      failOn: [failing],
      failDeprovisionOn: [ordered[0]!],
    });
    const orchestrator = makeOrchestrator({ provisioner });

    const result = await orchestrator.deploy(config);

    expect(result.status).toBe('failed');
    expect(result.rolledBackSteps).not.toContain(ordered[0]);
    // The un-undoable resource is still tracked as provisioned.
    expect(provisioner.provisioned.has(ordered[0]!)).toBe(true);
  });

  it('invokes an injected rollback hook (task 11.4 wiring point)', async () => {
    const config = generateConfig('debezium_kafka', 'docker_compose');
    const ordered = planDeploymentSteps(config).map((s) => s.name);
    const failing = ordered[1]!;

    const seen: { completed: string[]; ctx: DeploymentContext | null } = {
      completed: [],
      ctx: null,
    };
    const hook: DeploymentRollbackHook = {
      async rollback(completed: readonly CompletedStepRecord[], ctx) {
        seen.completed = completed.map((c) => c.step.name);
        seen.ctx = ctx;
        // Undo in reverse order, mirroring the contract.
        return [...completed]
          .reverse()
          .map<RolledBackStep>((c) => ({ name: c.step.name, undone: true }));
      },
    };

    const provisioner = new InMemoryServiceProvisioner({ failOn: [failing] });
    const orchestrator = makeOrchestrator({ provisioner, rollbackHook: hook });

    const result = await orchestrator.deploy(config);

    expect(seen.completed).toEqual([ordered[0]]);
    expect(seen.ctx?.target).toBe('docker_compose');
    expect(result.status).toBe('rolled_back');
  });
});

// ── createReverseOrderRollback ─────────────────────────────────────────────

describe('createReverseOrderRollback', () => {
  it('deprovisions completed records in reverse completion order', async () => {
    const provisioner = new InMemoryServiceProvisioner();
    const ctx: DeploymentContext = {
      deploymentId: 'dep_x',
      approach: 'debezium_kafka',
      target: 'docker_compose',
      env: {},
    };
    const mk = (name: string): CompletedStepRecord => {
      const handle: ProvisionedHandle = { service: name, ref: name };
      provisioner.provisioned.set(name, handle);
      return {
        step: { name, displayName: name, stateful: true, status: 'completed' },
        service: { name, displayName: name, description: '', stateful: true },
        handle,
      };
    };
    const completed = [mk('first'), mk('second'), mk('third')];

    const hook = createReverseOrderRollback(provisioner);
    const result = await hook.rollback(completed, ctx);

    expect(result.map((r) => r.name)).toEqual(['third', 'second', 'first']);
    expect(result.every((r) => r.undone)).toBe(true);
    expect(provisioner.deprovisionLog).toEqual(['third', 'second', 'first']);
    expect(provisioner.provisioned.size).toBe(0);
  });
});

// ── health-check timeout (Req 7.7 — 30s budget) ────────────────────────────

describe('health-check budget', () => {
  it('exposes the 30s budget constant', () => {
    expect(HEALTH_CHECK_BUDGET_MS).toBe(30_000);
  });

  it('reports a service unreachable when its check exceeds the budget', async () => {
    // Timer fires synchronously so the budget "elapses" immediately.
    const timers = {
      setTimeout: (cb: () => void) => {
        cb();
        return 0;
      },
      clearTimeout: () => {},
    };
    const neverResolves = {
      async check() {
        return new Promise<{ reachable: boolean }>(() => {
          /* never settles */
        });
      },
    };
    const orchestrator = makeOrchestrator({
      healthChecker: neverResolves,
      timers,
    });
    const config = generateConfig('materialized_engine', 'docker_compose');

    const result = await orchestrator.deploy(config);

    expect(result.status).toBe('completed');
    expect(result.health?.passed).toBe(false);
    expect(result.health?.services.every((s) => !s.reachable)).toBe(true);
    expect(
      result.health?.services.every((s) =>
        s.reason?.includes('budget'),
      ),
    ).toBe(true);
    expect(HealthCheckTimeoutError).toBeDefined();
  });
});
