import fc from 'fast-check';
import type { Condition, FormLayout, LayoutNode } from '@lumibase/contracts/form-layout';

/** fast-check generators for the form-layout property tests (#750). */

export const KEYS = ['a', 'b', 'c', 'd', 'e'] as const;

export const scalarArb = fc.oneof(
  fc.constantFrom('x', 'y', '', 'video'),
  fc.integer({ min: -3, max: 3 }),
  fc.boolean(),
  fc.constant(null),
);
export const valueArb = fc.oneof(scalarArb, fc.array(scalarArb, { maxLength: 3 }), fc.constant(undefined));
export const dataArb = fc.dictionary(fc.constantFrom(...KEYS), valueArb, { maxKeys: KEYS.length });

export const leafArb: fc.Arbitrary<Condition> = fc.oneof(
  fc.record({ field: fc.constantFrom(...KEYS), op: fc.constantFrom('eq', 'neq', 'contains'), value: scalarArb }),
  fc.record({ field: fc.constantFrom(...KEYS), op: fc.constantFrom('in', 'nin'), value: fc.array(scalarArb, { maxLength: 3 }) }),
  fc.record({ field: fc.constantFrom(...KEYS), op: fc.constantFrom('empty', 'nempty') }),
  fc.record({
    field: fc.constantFrom(...KEYS),
    op: fc.constantFrom('gt', 'lt', 'gte', 'lte'),
    value: fc.oneof(fc.integer({ min: -3, max: 3 }), fc.constantFrom('x', 'y')),
  }),
) as fc.Arbitrary<Condition>;

export const conditionArb: fc.Arbitrary<Condition> = fc.letrec<{ cond: Condition }>((tie) => ({
  cond: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leafArb,
    fc.record({ and: fc.array(tie('cond'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ or: fc.array(tie('cond'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ not: tie('cond') }),
  ),
})).cond;

const visibilityArb = fc.record(
  {
    visibleWhen: leafArb,
    skipRequiredWhenHidden: fc.boolean(),
    hiddenValue: fc.constantFrom('keep' as const, 'clear' as const),
  },
  { requiredKeys: [] },
);

/**
 * A layout placing a random subset of KEYS (each at most once) under random
 * tabs / groups with random conditions and flags.
 */
export const layoutArb: fc.Arbitrary<FormLayout> = fc
  .tuple(
    fc.shuffledSubarray([...KEYS]),
    fc.array(fc.tuple(fc.constantFrom('tab' as const, 'group' as const, 'top' as const), visibilityArb), {
      minLength: 1,
      maxLength: 3,
    }),
    fc.array(fc.tuple(fc.nat(10), visibilityArb), { minLength: KEYS.length, maxLength: KEYS.length }),
  )
  .map(([placed, containers, fieldOpts]) => {
    const buckets: LayoutNode[][] = containers.map(() => []);
    placed.forEach((key, i) => {
      const [slot, opts] = fieldOpts[i]!;
      // A field never conditions on itself (the schema rejects that).
      const own = opts.visibleWhen && 'field' in opts.visibleWhen && opts.visibleWhen.field === key ? { ...opts, visibleWhen: undefined } : opts;
      const node = { type: 'field' as const, field: key, ...stripUndefined(own) };
      buckets[slot % buckets.length]!.push(node);
    });
    const nodes: LayoutNode[] = [];
    containers.forEach(([kind, opts], i) => {
      const children = buckets[i]!;
      if (kind === 'top') nodes.push(...children);
      else if (kind === 'tab') nodes.push({ type: 'tab', id: `t${i}`, label: `Tab ${i}`, children, ...stripUndefined(opts) });
      else nodes.push({ type: 'group', id: `g${i}`, children, ...stripUndefined(opts) });
    });
    return { version: 1, nodes } as FormLayout;
  });

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
