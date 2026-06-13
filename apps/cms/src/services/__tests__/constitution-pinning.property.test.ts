import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { agentRuns } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import {
  ConstitutionService,
  canonicalize,
  computeConstitutionHash,
  evaluateRuleEvaluator,
  type ConstitutionEvaluator,
  type RuleEvaluator,
} from '../constitution-service';

/**
 * Feature: content-os, Property 12: constitution pinning.
 *
 * Every evaluation of a run uses exactly the constitutionHash pinned at run
 * start — even when the active version changes mid-run. The pin is
 * first-write-wins and idempotent.
 *
 * Also covers hash identity: the hash is deterministic and invariant under
 * object-key ordering (canonicalization), so "same evaluators" always means
 * "same hash" regardless of JSON serialization order.
 *
 * **Validates: Requirements 15.3**
 */

interface FakeState {
  runMetrics: Record<string, unknown>;
  activeHash: string | null;
}

/** Minimal drizzle-shaped fake covering exactly pinToRun's query patterns. */
function makeDb(state: FakeState): Database {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === agentRuns) return [{ metrics: state.runMetrics }];
            // constitutions table — the active row lookup.
            return state.activeHash
              ? [{ id: 'const_1', hash: state.activeHash, evaluators: [], version: 1, status: 'active' }]
              : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: { metrics?: Record<string, unknown> }) => ({
        where: async () => {
          if (values.metrics) state.runMetrics = values.metrics;
          return [];
        },
      }),
    }),
  } as unknown as Database;
}

const hashArb = fc.hexaString({ minLength: 8, maxLength: 16 }).map((h) => `sha256:${h}`);

describe('Feature: content-os, Property 12: constitution pinning', () => {
  it('the hash pinned at run start survives any later activation', async () => {
    await fc.assert(
      fc.asyncProperty(hashArb, fc.array(hashArb, { minLength: 1, maxLength: 5 }), async (first, later) => {
        const state: FakeState = { runMetrics: {}, activeHash: first };
        const service = new ConstitutionService({ db: makeDb(state), siteId: 'site_a' });

        const pinned = await service.pinToRun('run_1');
        expect(pinned).toBe(first);
        expect(state.runMetrics['constitutionHash']).toBe(first);

        // The active version changes mid-run — possibly several times.
        for (const next of later) {
          state.activeHash = next;
          const repinned = await service.pinToRun('run_1');
          expect(repinned).toBe(first);
          expect(state.runMetrics['constitutionHash']).toBe(first);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('no active constitution pins nothing and returns null', async () => {
    const state: FakeState = { runMetrics: {}, activeHash: null };
    const service = new ConstitutionService({ db: makeDb(state), siteId: 'site_a' });
    expect(await service.pinToRun('run_1')).toBeNull();
    expect(state.runMetrics['constitutionHash']).toBeUndefined();
  });
});

const evaluatorArb: fc.Arbitrary<ConstitutionEvaluator> = fc.oneof(
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    type: fc.constant<'rule'>('rule'),
    blocking: fc.boolean(),
    rule: fc.record({
      field: fc.string({ minLength: 1, maxLength: 12 }),
      op: fc.constantFrom<RuleEvaluator['rule']['op']>('required', 'max_length', 'contains'),
      value: fc.oneof(fc.string(), fc.integer()),
    }),
  }),
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    type: fc.constant<'llm_judge'>('llm_judge'),
    blocking: fc.boolean(),
    prompt: fc.string({ minLength: 1, maxLength: 60 }),
  }),
);

describe('Feature: content-os, constitution hash identity', () => {
  it('hashing is deterministic and key-order invariant', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(evaluatorArb, { minLength: 1, maxLength: 5 }), async (evaluators) => {
        const reordered = evaluators.map(
          (e) =>
            Object.fromEntries(Object.entries(e).reverse()) as unknown as ConstitutionEvaluator,
        );
        const a = await computeConstitutionHash(evaluators);
        const b = await computeConstitutionHash(reordered);
        expect(a).toBe(b);
        expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(canonicalize(evaluators)).toBe(canonicalize(reordered));
      }),
      { numRuns: 100 },
    );
  });

  it('changing any evaluator changes the canonical form', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(evaluatorArb, { minLength: 1, maxLength: 5 }), async (evaluators) => {
        const mutated = [...evaluators];
        mutated[0] = { ...mutated[0]!, id: `${mutated[0]!.id}_x` };
        expect(canonicalize(mutated)).not.toBe(canonicalize(evaluators));
      }),
      { numRuns: 100 },
    );
  });
});

describe('Feature: content-os, rule DSL evaluation (Req 15.2)', () => {
  const make = (op: RuleEvaluator['rule']['op'], value?: unknown): RuleEvaluator => ({
    id: 'e1',
    type: 'rule',
    rule: { field: 'title', op, value },
  });

  it('covers every operator', () => {
    expect(evaluateRuleEvaluator(make('required'), { title: 'x' }).status).toBe('pass');
    expect(evaluateRuleEvaluator(make('required'), { title: '' }).status).toBe('fail');
    expect(evaluateRuleEvaluator(make('required'), {}).status).toBe('fail');
    expect(evaluateRuleEvaluator(make('equals', 'a'), { title: 'a' }).status).toBe('pass');
    expect(evaluateRuleEvaluator(make('equals', 'a'), { title: 'b' }).status).toBe('fail');
    expect(evaluateRuleEvaluator(make('max_length', 3), { title: 'abc' }).status).toBe('pass');
    expect(evaluateRuleEvaluator(make('max_length', 3), { title: 'abcd' }).status).toBe('fail');
    expect(evaluateRuleEvaluator(make('min_length', 3), { title: 'abc' }).status).toBe('pass');
    expect(evaluateRuleEvaluator(make('min_length', 3), { title: 'ab' }).status).toBe('fail');
    expect(evaluateRuleEvaluator(make('regex', '^a'), { title: 'abc' }).status).toBe('pass');
    expect(evaluateRuleEvaluator(make('regex', '^z'), { title: 'abc' }).status).toBe('fail');
    expect(evaluateRuleEvaluator(make('regex', '('), { title: 'abc' }).status).toBe('error');
    expect(evaluateRuleEvaluator(make('contains', 'b'), { title: 'abc' }).status).toBe('pass');
    expect(evaluateRuleEvaluator(make('contains', 'z'), { title: 'abc' }).status).toBe('fail');
    expect(evaluateRuleEvaluator(make('not_contains', 'z'), { title: 'abc' }).status).toBe('pass');
    expect(evaluateRuleEvaluator(make('not_contains', 'b'), { title: 'abc' }).status).toBe('fail');
  });

  it('blocking defaults to true and is preserved when set false', () => {
    fc.assert(
      fc.property(fc.boolean(), (blocking) => {
        const result = evaluateRuleEvaluator(
          { id: 'e', type: 'rule', blocking, rule: { field: 'f', op: 'required' } },
          {},
        );
        expect(result.blocking).toBe(blocking);
      }),
      { numRuns: 20 },
    );
    const defaulted = evaluateRuleEvaluator({ id: 'e', type: 'rule', rule: { field: 'f', op: 'required' } }, {});
    expect(defaulted.blocking).toBe(true);
  });
});
