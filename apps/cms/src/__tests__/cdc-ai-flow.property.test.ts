import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  generateConfig,
  requiredEnvVarKeys,
  ENV_VAR_KEY_PATTERN,
  type DeploymentTarget,
} from '../modules/cdc/ai-flow/config-generator';
import {
  validateEnvVars,
  ENV_VALIDATION_RULES,
  type EnvVarDefinition,
  type EnvVarValidationRule,
} from '../modules/cdc/ai-flow/env-validator';
import {
  DeploymentOrchestrator,
  InMemoryServiceProvisioner,
  planDeploymentSteps,
} from '../modules/cdc/ai-flow/deployment-orchestrator';
import {
  RollbackManager,
  InMemoryStepUndoer,
  type RollbackableStep,
  type FailedStep,
} from '../modules/cdc/ai-flow/rollback-manager';
import type { CdcConnectorType } from '../modules/cdc/connectors/types';

/**
 * Property tests for the AI Flow Engine (ClickHouse CDC — task 11.5).
 *
 * Covers three correctness properties from the design's "Correctness
 * Properties" section:
 *
 *   - Property 17 — Environment config generation completeness (Req 7.1)
 *   - Property 18 — Environment variable schema validation       (Req 7.4, 7.5)
 *   - Property 19 — Deployment rollback completeness             (Req 7.6)
 *
 * Each property runs a minimum of 100 iterations via fast-check.
 *
 * **Validates: Requirements 7.1, 7.4, 7.5, 7.6**
 */

// ── shared fixtures ────────────────────────────────────────────────────────

const APPROACHES: readonly CdcConnectorType[] = [
  'debezium_kafka',
  'materialized_engine',
  'airbyte',
];

const TARGETS: readonly DeploymentTarget[] = ['docker_compose', 'cloudflare_workers'];

/** A monotonically-advancing clock so deployment timestamps are deterministic. */
function fakeClock(startMs = 0, stepMs = 1): () => number {
  let t = startMs;
  return () => {
    const now = t;
    t += stepMs;
    return now;
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Property 17: Environment config generation completeness
// ════════════════════════════════════════════════════════════════════════════

/**
 * Independent re-statement of the required environment variables every
 * (approach, target) combination MUST surface. Keeping this oracle separate
 * from the production generator is what gives the property its value: it
 * detects both *missing* required keys and accidentally-promoted extras.
 */
function expectedRequiredKeys(
  approach: CdcConnectorType,
  target: DeploymentTarget,
): Set<string> {
  // Always present so split deployments can be correlated.
  const universal = ['CDC_PIPELINE_NAME', 'CDC_APPROACH', 'CDC_DEPLOYMENT_TARGET'];

  if (target === 'cloudflare_workers') {
    // Edge components only — HTTPS link to the stateful stack + Redis.
    return new Set([
      ...universal,
      'CDC_STATEFUL_STACK_URL',
      'CDC_API_AUTH_TOKEN',
      'REDIS_URL',
    ]);
  }

  // docker_compose → full stateful stack: shared connection vars + the
  // approach-specific required vars.
  const common = ['SOURCE_DATABASE_URL', 'CLICKHOUSE_SINK_URL', 'CDC_REPLICATION_TABLES'];
  const byApproach: Record<CdcConnectorType, string[]> = {
    debezium_kafka: ['KAFKA_BOOTSTRAP_SERVERS', 'DEBEZIUM_CONNECT_URL'],
    materialized_engine: [],
    airbyte: ['AIRBYTE_API_URL', 'AIRBYTE_WORKSPACE_ID'],
  };

  return new Set([...universal, ...common, ...byApproach[approach]]);
}

describe('Feature: clickhouse-cdc, Property 17: Environment config generation completeness', () => {
  it('generates all required vars for every approach + target combination', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...APPROACHES),
        fc.constantFrom(...TARGETS),
        (approach, target) => {
          const config = generateConfig(approach, target);

          // The config reflects the requested combination.
          expect(config.approach).toBe(approach);
          expect(config.target).toBe(target);

          // Every variable definition has a well-formed, non-empty key.
          for (const def of config.variables) {
            expect(def.key.length).toBeGreaterThan(0);
            expect(ENV_VAR_KEY_PATTERN.test(def.key)).toBe(true);
          }

          // No duplicate variable keys.
          const allKeys = config.variables.map((v) => v.key);
          expect(new Set(allKeys).size).toBe(allKeys.length);

          // Required keys are non-empty and exactly the expected set
          // (no missing required key, no surprise extras).
          const required = requiredEnvVarKeys(config);
          expect(required.length).toBeGreaterThan(0);
          expect(new Set(required)).toEqual(expectedRequiredKeys(approach, target));

          // Every required key resolves back to a definition flagged required.
          for (const key of required) {
            const def = config.variables.find((v) => v.key === key);
            expect(def).toBeDefined();
            expect(def?.required).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('scopes services by target (stateful stack vs edge-only)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...APPROACHES),
        fc.constantFrom(...TARGETS),
        (approach, target) => {
          const config = generateConfig(approach, target);
          expect(config.services.length).toBeGreaterThan(0);

          if (target === 'cloudflare_workers') {
            // Edge deployment never includes stateful components.
            expect(config.services.every((s) => !s.stateful)).toBe(true);
            // ...nor the stateful connection variables.
            const keys = new Set(config.variables.map((v) => v.key));
            expect(keys.has('SOURCE_DATABASE_URL')).toBe(false);
            expect(keys.has('CLICKHOUSE_SINK_URL')).toBe(false);
          } else {
            // The stateful stack is exclusively stateful services.
            expect(config.services.every((s) => s.stateful)).toBe(true);
            // ...and excludes edge-only variables.
            const keys = new Set(config.variables.map((v) => v.key));
            expect(keys.has('REDIS_URL')).toBe(false);
            expect(keys.has('CDC_STATEFUL_STACK_URL')).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Property 18: Environment variable schema validation
// ════════════════════════════════════════════════════════════════════════════

const R = ENV_VALIDATION_RULES;

/**
 * A single generated field: either a schema-defined variable (with a known
 * expected outcome) or an unknown supplied key. `expected` is the rule id the
 * validator MUST report, or `null` when the field must NOT be flagged.
 */
type Scenario =
  | {
      readonly kind: 'defined';
      readonly required: boolean;
      readonly validation?: EnvVarValidationRule;
      readonly present: boolean;
      readonly value: string;
      readonly expected: string | null;
    }
  | { readonly kind: 'unknown'; readonly value: string; readonly expected: string };

// ── valid scenarios (must NOT be flagged) ──────────────────────────────────

const validString = fc
  .tuple(fc.string({ minLength: 1, maxLength: 8 }), fc.boolean())
  .map(([value, required]): Scenario => ({
    kind: 'defined',
    required,
    validation: { type: 'string', minLength: 1 },
    present: true,
    value,
    expected: null,
  }));

const validNumber = fc
  .tuple(fc.integer({ min: 0, max: 1000 }), fc.boolean())
  .map(([n, required]): Scenario => ({
    kind: 'defined',
    required,
    validation: { type: 'number', integer: true, min: 0, max: 1000 },
    present: true,
    value: String(n),
    expected: null,
  }));

const validBoolean = fc
  .tuple(fc.constantFrom('true', 'false'), fc.boolean())
  .map(([value, required]): Scenario => ({
    kind: 'defined',
    required,
    validation: { type: 'boolean' },
    present: true,
    value,
    expected: null,
  }));

const validEnum = fc
  .uniqueArray(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'), { minLength: 2, maxLength: 5 })
  .chain((values) =>
    fc.tuple(fc.constantFrom(...values), fc.boolean()).map(
      ([value, required]): Scenario => ({
        kind: 'defined',
        required,
        validation: { type: 'enum', values },
        present: true,
        value,
        expected: null,
      }),
    ),
  );

const validUrl = fc
  .tuple(fc.constantFrom('example.com', 'host.local', 'a.b.co', '10.0.0.1'), fc.boolean())
  .map(([host, required]): Scenario => ({
    kind: 'defined',
    required,
    validation: { type: 'url', protocols: ['https:'] },
    present: true,
    value: `https://${host}`,
    expected: null,
  }));

const noValidationValid = fc
  .tuple(fc.string({ minLength: 1, maxLength: 8 }), fc.boolean())
  .map(([value, required]): Scenario => ({
    kind: 'defined',
    required,
    validation: undefined,
    present: true,
    value,
    expected: null,
  }));

const optionalAbsent = fc.boolean().map(
  (hasVal): Scenario => ({
    kind: 'defined',
    required: false,
    validation: hasVal ? { type: 'string', minLength: 1 } : undefined,
    present: false,
    value: '',
    expected: null,
  }),
);

// ── invalid scenarios (must be flagged with the specific rule) ─────────────

const minLengthViolation = fc.integer({ min: 2, max: 6 }).chain((m) =>
  fc.tuple(fc.integer({ min: 1, max: m - 1 }), fc.boolean()).map(
    ([len, required]): Scenario => ({
      kind: 'defined',
      required,
      validation: { type: 'string', minLength: m },
      present: true,
      value: 'a'.repeat(len),
      expected: R.MIN_LENGTH,
    }),
  ),
);

const maxLengthViolation = fc.integer({ min: 1, max: 5 }).chain((x) =>
  fc.tuple(fc.integer({ min: 1, max: 5 }), fc.boolean()).map(
    ([extra, required]): Scenario => ({
      kind: 'defined',
      required,
      validation: { type: 'string', maxLength: x },
      present: true,
      value: 'a'.repeat(x + extra),
      expected: R.MAX_LENGTH,
    }),
  ),
);

const patternViolation = fc
  .tuple(fc.string({ minLength: 1, maxLength: 5 }), fc.boolean())
  .map(([s, required]): Scenario => ({
    kind: 'defined',
    required,
    validation: { type: 'string', pattern: '^[a-z]+$' },
    present: true,
    // Uppercase + a guaranteed digit ⇒ never matches ^[a-z]+$.
    value: `${s.toUpperCase()}1`,
    expected: R.PATTERN,
  }));

const numberTypeViolation = fc
  .tuple(
    fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'f', 'g'), { minLength: 1, maxLength: 5 }),
    fc.boolean(),
  )
  .map(([letters, required]): Scenario => ({
    kind: 'defined',
    required,
    validation: { type: 'number' },
    present: true,
    value: letters.join(''),
    expected: R.TYPE,
  }));

const numberNonInteger = fc
  .tuple(fc.integer({ min: 0, max: 500 }), fc.boolean())
  .map(([n, required]): Scenario => ({
    kind: 'defined',
    required,
    validation: { type: 'number', integer: true },
    present: true,
    value: `${n}.5`,
    expected: R.TYPE,
  }));

const numberMinViolation = fc.integer({ min: 10, max: 100 }).chain((lo) =>
  fc.tuple(fc.integer({ min: 0, max: lo - 1 }), fc.boolean()).map(
    ([v, required]): Scenario => ({
      kind: 'defined',
      required,
      validation: { type: 'number', min: lo },
      present: true,
      value: String(v),
      expected: R.MIN,
    }),
  ),
);

const numberMaxViolation = fc.integer({ min: 10, max: 100 }).chain((hi) =>
  fc.tuple(fc.integer({ min: 1, max: 100 }), fc.boolean()).map(
    ([d, required]): Scenario => ({
      kind: 'defined',
      required,
      validation: { type: 'number', max: hi },
      present: true,
      value: String(hi + d),
      expected: R.MAX,
    }),
  ),
);

const booleanTypeViolation = fc
  .tuple(fc.constantFrom('yes', 'no', '1', '0', 'True', 'FALSE', 'maybe', 'TRUE'), fc.boolean())
  .map(([value, required]): Scenario => ({
    kind: 'defined',
    required,
    validation: { type: 'boolean' },
    present: true,
    value,
    expected: R.TYPE,
  }));

const enumViolation = fc
  .uniqueArray(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'), { minLength: 2, maxLength: 5 })
  .chain((values) =>
    fc.tuple(fc.constantFrom('zzz', 'qqq', 'not_here', 'x_y'), fc.boolean()).map(
      ([value, required]): Scenario => ({
        kind: 'defined',
        required,
        validation: { type: 'enum', values },
        present: true,
        value,
        expected: R.ENUM,
      }),
    ),
  );

const urlViolation = fc
  .tuple(fc.constantFrom('not a url', 'justtext', '???', 'foo bar', 'http//missing'), fc.boolean())
  .map(([value, required]): Scenario => ({
    kind: 'defined',
    required,
    validation: { type: 'url' },
    present: true,
    value,
    expected: R.URL,
  }));

const protocolViolation = fc
  .tuple(fc.constantFrom('http://h', 'ftp://h', 'postgres://h', 'redis://h'), fc.boolean())
  .map(([value, required]): Scenario => ({
    kind: 'defined',
    required,
    validation: { type: 'url', protocols: ['https:'] },
    present: true,
    value,
    expected: R.PROTOCOL,
  }));

const requiredOmitted = fc.boolean().map(
  (hasVal): Scenario => ({
    kind: 'defined',
    required: true,
    validation: hasVal ? { type: 'string', minLength: 1 } : undefined,
    present: false,
    value: '',
    expected: R.REQUIRED,
  }),
);

const requiredEmpty = fc.boolean().map(
  (hasVal): Scenario => ({
    kind: 'defined',
    required: true,
    validation: hasVal ? { type: 'number', min: 0 } : undefined,
    present: true,
    value: '',
    expected: R.REQUIRED,
  }),
);

const unknownKey = fc.string({ minLength: 1, maxLength: 8 }).map(
  (value): Scenario => ({ kind: 'unknown', value, expected: R.UNKNOWN_KEY }),
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.oneof(
  validString,
  validNumber,
  validBoolean,
  validEnum,
  validUrl,
  noValidationValid,
  optionalAbsent,
  minLengthViolation,
  maxLengthViolation,
  patternViolation,
  numberTypeViolation,
  numberNonInteger,
  numberMinViolation,
  numberMaxViolation,
  booleanTypeViolation,
  enumViolation,
  urlViolation,
  protocolViolation,
  requiredOmitted,
  requiredEmpty,
  unknownKey,
);

describe('Feature: clickhouse-cdc, Property 18: Environment variable schema validation', () => {
  it('flags exactly the invalid vars, each with the specific violated rule', () => {
    fc.assert(
      fc.property(fc.array(scenarioArb, { minLength: 1, maxLength: 14 }), (scenarios) => {
        const definitions: EnvVarDefinition[] = [];
        const vars: Record<string, string> = {};
        const expectedMap: Record<string, string> = {};

        scenarios.forEach((scenario, i) => {
          if (scenario.kind === 'defined') {
            const key = `VAR_${i}`;
            definitions.push({
              key,
              required: scenario.required,
              validation: scenario.validation,
            });
            if (scenario.present) vars[key] = scenario.value;
            if (scenario.expected !== null) expectedMap[key] = scenario.expected;
          } else {
            // Unknown supplied key — well-formed but absent from the schema.
            const key = `UNKNOWN_${i}`;
            vars[key] = scenario.value;
            expectedMap[key] = scenario.expected;
          }
        });

        const result = validateEnvVars(definitions, vars);

        // Each reported field carries exactly one rule; build a key→rule map.
        const actualMap = Object.fromEntries(
          result.invalidFields.map((f) => [f.key, f.rule]),
        );

        // Exactly the invalid fields are reported, each with the right rule;
        // every valid field is absent.
        expect(actualMap).toEqual(expectedMap);
        // No key reported twice.
        expect(result.invalidFields.length).toBe(Object.keys(expectedMap).length);
        // `valid` is true iff there are no violations.
        expect(result.valid).toBe(Object.keys(expectedMap).length === 0);
        // Every reported rule is one of the documented identifiers.
        const ruleIds = new Set<string>(Object.values(ENV_VALIDATION_RULES));
        for (const field of result.invalidFields) {
          expect(ruleIds.has(field.rule)).toBe(true);
          expect(field.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Property 19: Deployment rollback completeness
// ════════════════════════════════════════════════════════════════════════════

describe('Feature: clickhouse-cdc, Property 19: Deployment rollback completeness', () => {
  // (a) End-to-end: drive the real orchestrator with a provisioner that fails
  //     a chosen step, and assert the prior steps are undone in reverse order
  //     leaving no partially-provisioned resource (Req 7.6).
  it('(a) rolls back steps 1..N-1 in reverse order on a step-N failure (end-to-end)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...APPROACHES),
        // docker_compose yields a multi-step stateful stack to roll back.
        fc.nat(),
        async (approach, seed) => {
          const config = generateConfig(approach, 'docker_compose');
          const ordered = planDeploymentSteps(config).map((s) => s.name);
          const total = ordered.length;
          const failingIndex = seed % total; // 0 ≤ index ≤ total-1
          const failing = ordered[failingIndex]!;

          const provisioner = new InMemoryServiceProvisioner({ failOn: [failing] });
          let counter = 0;
          const orchestrator = new DeploymentOrchestrator({
            provisioner,
            now: fakeClock(),
            idGenerator: () => `dep_${(counter += 1)}`,
          });

          const result = await orchestrator.deploy(config);
          const completedBefore = ordered.slice(0, failingIndex);
          const reversed = [...completedBefore].reverse();

          // Steps 1..N-1 deprovisioned in REVERSE completion order.
          expect(provisioner.deprovisionLog).toEqual(reversed);
          // No partially-provisioned resource remains.
          expect(provisioner.provisioned.size).toBe(0);

          // Outcome is a clean rollback identifying the failed step.
          expect(result.status).toBe('rolled_back');
          expect(result.failedStep).toBe(failing);
          expect(result.error?.type).toBe('Error');
          expect(result.rolledBackSteps).toEqual(reversed);

          // Per-step statuses: before = rolled_back, at = failed, after = skipped.
          ordered.forEach((name, i) => {
            const step = result.steps.find((s) => s.name === name)!;
            if (i < failingIndex) expect(step.status).toBe('rolled_back');
            else if (i === failingIndex) expect(step.status).toBe('failed');
            else expect(step.status).toBe('skipped');
          });
        },
      ),
      { numRuns: 150 },
    );
  });

  // (b) Direct: drive RollbackManager with N completed steps + a failed step,
  //     asserting reverse-order teardown and zero remaining resources.
  it('(b) RollbackManager undoes completed steps in reverse order with no resources left', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 8 }), async (n) => {
        const undoer = new InMemoryStepUndoer();
        const manager = new RollbackManager({ undoer, clock: fakeClock() });

        const completedNames = Array.from({ length: n }, (_, i) => `s${i}`);
        const completedSteps: RollbackableStep[] = completedNames.map((name) => ({
          name,
          resources: [{ type: 'resource', id: name }],
        }));
        const failedStep: FailedStep = {
          name: 'failed_step',
          error: new Error('step failed'),
          resources: [{ type: 'resource', id: 'failed_partial' }],
        };

        const result = await manager.rollback({ completedSteps, failedStep });

        const reversed = [...completedNames].reverse();

        // Completed steps reported in reverse completion order, all undone.
        expect(result.rolledBackSteps.map((s) => s.stepName)).toEqual(reversed);
        expect(result.rolledBackSteps.every((s) => s.status === 'undone')).toBe(true);

        // The failed step's partial resources are cleaned up first.
        expect(result.failedStepCleanup?.status).toBe('undone');

        // Undoer saw the failed step first, then completed steps in reverse.
        expect(undoer.teardownOrder).toEqual(['failed_step', ...reversed]);

        // No partially-provisioned resource remains; clean success.
        expect(result.remainingResources).toEqual([]);
        expect(result.success).toBe(true);
        expect(result.withinBudget).toBe(true);

        // The triggering failure is reported with name, type, and description.
        expect(result.failure.stepName).toBe('failed_step');
        expect(result.failure.errorType).toBe('Error');
        expect(result.failure.description).toBe('step failed');
      }),
      { numRuns: 150 },
    );
  });
});
