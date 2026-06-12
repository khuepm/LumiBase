import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  diffDrifts,
  driftFingerprint,
  evaluateRules,
  type DriftItemView,
} from '../drift-service';
import { planReconciliation, routeRole, type ReconcilableDrift } from '../reconciler-service';
import type { IntentRule } from '../intent-service';

/**
 * Feature: content-os, Properties 4, 5 and 11.
 *
 * - Property 5: a pinned field never produces a field-scoped drift, for any
 *   rule set and item state (a human pin removes the field from the
 *   reconciler's jurisdiction).
 * - Property 4: fingerprints are deterministic and diffDrifts never re-opens
 *   a drift that is already open/assigned — the same (intent, item, rule)
 *   can never spawn two concurrent goals.
 * - Property 11: the reconciler plan never exceeds maxGoalsPerCycle and only
 *   selects open, unassigned drifts with unique fingerprints.
 *
 * **Validates: Requirements 6.3, 6.4, 7.1, 7.5**
 */

const fieldArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/);

const ruleArb: fc.Arbitrary<IntentRule> = fc.oneof(
  fc.record({ type: fc.constant('required_fields' as const), fields: fc.uniqueArray(fieldArb, { minLength: 1, maxLength: 5 }) }),
  fc.record({ type: fc.constant('freshness' as const), maxAgeDays: fc.integer({ min: 1, max: 365 }) }),
  fc.record({
    type: fc.constant('translations' as const),
    locales: fc.uniqueArray(fc.constantFrom('vi', 'en', 'ja', 'fr'), { minLength: 1, maxLength: 3 }),
    fields: fc.uniqueArray(fieldArb, { minLength: 1, maxLength: 3 }),
  }),
  fc.record({ type: fc.constant('link_health' as const), fields: fc.uniqueArray(fieldArb, { minLength: 1, maxLength: 3 }) }),
  fc.record({
    type: fc.constant('field_constraint' as const),
    field: fieldArb,
    minLength: fc.integer({ min: 1, max: 50 }),
  }),
  fc.record({ type: fc.constant('glossary_compliance' as const), fields: fc.uniqueArray(fieldArb, { minLength: 1, maxLength: 3 }) }),
);

const valueArb = fc.oneof(
  fc.string({ maxLength: 30 }),
  fc.constant(''),
  fc.constant(null),
  fc.constant('see http://[broken url here'),
  fc.dictionary(fc.constantFrom('vi', 'en'), fc.string({ maxLength: 10 }), { maxKeys: 2 }),
);

const itemArb: fc.Arbitrary<DriftItemView> = fc
  .record({
    id: fc.stringMatching(/^item_[a-z0-9]{4}$/),
    data: fc.dictionary(fieldArb, valueArb, { maxKeys: 8 }),
    ageDays: fc.integer({ min: 0, max: 1000 }),
  })
  .map(({ id, data, ageDays }) => ({
    id,
    data,
    updatedAt: new Date(Date.now() - ageDays * 86_400_000),
    pinnedFields: [],
  }));

describe('Feature: content-os, Property 5: pinned fields never produce drift', () => {
  it('field-scoped violations never reference a pinned field', () => {
    fc.assert(
      fc.property(
        fc.array(ruleArb, { minLength: 1, maxLength: 6 }),
        itemArb,
        fc.func(fc.boolean()),
        (rules, item, pinChooser) => {
          // Pin an arbitrary subset of the item's fields.
          const pinned = Object.keys(item.data).filter((field) => pinChooser(field));
          const violations = evaluateRules(rules, { ...item, pinnedFields: pinned }, {
            forbiddenTerms: ['forbidden'],
          });
          for (const violation of violations) {
            if (violation.field) {
              expect(pinned).not.toContain(violation.field);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('pinning every rule-referenced field suppresses all field-scoped violations', () => {
    fc.assert(
      fc.property(fc.array(ruleArb, { minLength: 1, maxLength: 6 }), itemArb, (rules, item) => {
        // Pin both the item's data fields and every field a rule references
        // (a required field can be absent from data yet still rule-scoped).
        const ruleFields = rules.flatMap((rule) =>
          'fields' in rule && rule.fields ? rule.fields : 'field' in rule ? [rule.field] : [],
        );
        const allPinned = [...Object.keys(item.data), ...ruleFields, 'translations'];
        const violations = evaluateRules(rules, { ...item, pinnedFields: allPinned }, {
          forbiddenTerms: ['forbidden'],
        });
        // Only item-level rules (freshness) may still fire.
        for (const violation of violations) {
          expect(violation.field).toBeUndefined();
          expect(violation.ruleType).toBe('freshness');
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('Feature: content-os, Property 4: fingerprint dedupe', () => {
  const statusArb = fc.constantFrom('open', 'assigned', 'resolved', 'stale');
  const fpArb = fc.stringMatching(/^fp_[a-z0-9]{6}$/);

  it('fingerprints are deterministic and injective over their inputs', () => {
    fc.assert(
      fc.property(fpArb, fpArb, (a, b) => {
        expect(driftFingerprint('i', a, 'rt', 'rk')).toBe(driftFingerprint('i', a, 'rt', 'rk'));
        if (a !== b) {
          expect(driftFingerprint('i', a, 'rt', 'rk')).not.toBe(driftFingerprint('i', b, 'rt', 'rk'));
        }
      }),
      { numRuns: 100 },
    );
  });

  it('never opens a fingerprint that is already open/assigned; resolves only vanished ones', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fpArb, statusArb, { maxKeys: 20 }),
        fc.uniqueArray(fpArb, { maxLength: 20 }),
        (existingDict, detectedList) => {
          const existing = new Map(Object.entries(existingDict).map(([fp, status]) => [fp, { status }]));
          const detected = new Set(detectedList);
          const { toOpen, toReopen, toResolve } = diffDrifts(existing, detected);

          for (const fp of toOpen) {
            expect(existing.has(fp)).toBe(false);
            expect(detected.has(fp)).toBe(true);
          }
          for (const fp of toReopen) {
            expect(['resolved', 'stale']).toContain(existing.get(fp)!.status);
          }
          for (const fp of toResolve) {
            expect(detected.has(fp)).toBe(false);
            expect(['open', 'assigned']).toContain(existing.get(fp)!.status);
          }
          // Disjoint outcomes — a fingerprint never lands in two buckets.
          const all = [...toOpen, ...toReopen, ...toResolve];
          expect(new Set(all).size).toBe(all.length);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('Feature: content-os, Property 11: reconciler budget per cycle', () => {
  const driftRowArb: fc.Arbitrary<ReconcilableDrift> = fc.record({
    id: fc.stringMatching(/^drift_[a-z0-9]{4}$/),
    fingerprint: fc.stringMatching(/^fp_[a-z0-9]{5}$/),
    ruleType: fc.constantFrom(
      'required_fields',
      'freshness',
      'translations',
      'link_health',
      'field_constraint',
      'glossary_compliance',
    ),
    ruleKey: fieldArb,
    itemId: fc.stringMatching(/^item_[a-z0-9]{4}$/),
    status: fc.constantFrom('open', 'assigned', 'resolved'),
    goalId: fc.option(fc.constant('goal_1'), { nil: null }),
  });

  it('never selects more than maxGoalsPerCycle, only open unassigned drifts, unique fingerprints', () => {
    fc.assert(
      fc.property(
        fc.array(driftRowArb, { maxLength: 50 }),
        fc.integer({ min: 0, max: 20 }),
        (drifts, maxGoalsPerCycle) => {
          const plan = planReconciliation(drifts, maxGoalsPerCycle);
          expect(plan.selected.length).toBeLessThanOrEqual(maxGoalsPerCycle);
          const fingerprints = new Set<string>();
          for (const drift of plan.selected) {
            expect(drift.status).toBe('open');
            expect(drift.goalId).toBeNull();
            expect(fingerprints.has(drift.fingerprint)).toBe(false);
            fingerprints.add(drift.fingerprint);
          }
          // Accounting: selected + deferred covers every eligible drift.
          const eligible = new Set(
            drifts.filter((d) => d.status === 'open' && !d.goalId).map((d) => d.fingerprint),
          ).size;
          expect(plan.selected.length + plan.deferred).toBe(eligible);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('routes every rule type to a role', () => {
    for (const ruleType of ['required_fields', 'freshness', 'translations', 'link_health', 'field_constraint', 'glossary_compliance', 'unknown']) {
      expect(routeRole(ruleType)).toBeTruthy();
    }
    expect(routeRole('translations')).toBe('translator');
    expect(routeRole('schema:*' as never)).toBe('writer');
  });
});
