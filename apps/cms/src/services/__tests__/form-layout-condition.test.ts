import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  conditionSchema,
  conditionStats,
  evaluateCondition,
  isEmptyValue,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  type Condition,
  type ConditionLeaf,
} from '@lumibase/contracts/form-layout';
import { conditionArb, dataArb, leafArb } from './form-layout-arbitraries';

/**
 * Form-layout condition engine (#750): the declarative expression language
 * that drives tab / group / field visibility on the Studio form AND the CMS
 * required-validation skip. One implementation, shared via contracts.
 */

const leaf = (field: string, op: ConditionLeaf['op'], value?: ConditionLeaf['value']): ConditionLeaf =>
  value === undefined ? { field, op } : { field, op, value };

describe('evaluateCondition — operators', () => {
  const data = { type: 'video', count: 3, tags: ['a', 'b'], title: 'Hello world', empty: '', none: null, flag: false, zero: 0 };

  it.each<[Condition, boolean]>([
    [leaf('type', 'eq', 'video'), true],
    [leaf('type', 'eq', 'audio'), false],
    [leaf('type', 'neq', 'audio'), true],
    [leaf('missing', 'eq', null), true], // unset equals null
    [leaf('none', 'eq', null), true],
    [leaf('count', 'eq', '3'), false], // no type coercion
    [leaf('type', 'in', ['audio', 'video']), true],
    [leaf('type', 'nin', ['audio', 'video']), false],
    [leaf('tags', 'in', ['b', 'z']), true], // multi-value: any overlap
    [leaf('tags', 'nin', ['z']), true],
    [leaf('empty', 'empty'), true],
    [leaf('none', 'empty'), true],
    [leaf('missing', 'empty'), true],
    [leaf('flag', 'empty'), false], // false is a value
    [leaf('zero', 'empty'), false], // 0 is a value
    [leaf('tags', 'nempty'), true],
    [leaf('count', 'gt', 2), true],
    [leaf('count', 'lt', 2), false],
    [leaf('count', 'gte', 3), true],
    [leaf('count', 'lte', 2), false],
    [leaf('count', 'gt', '2'), false], // mixed types never order
    [leaf('title', 'gt', 'A'), true], // strings order lexically (ISO dates)
    [leaf('title', 'contains', 'world'), true],
    [leaf('tags', 'contains', 'a'), true],
    [leaf('count', 'contains', 3), false],
    [{ and: [leaf('type', 'eq', 'video'), leaf('count', 'gt', 1)] }, true],
    [{ and: [leaf('type', 'eq', 'video'), leaf('count', 'gt', 9)] }, false],
    [{ or: [leaf('type', 'eq', 'x'), leaf('count', 'gt', 1)] }, true],
    [{ not: leaf('type', 'eq', 'video') }, false],
  ])('%j → %s', (cond, expected) => {
    expect(evaluateCondition(cond, data)).toBe(expected);
  });

  it('reads own keys only — never the prototype chain', () => {
    expect(evaluateCondition(leaf('constructor', 'nempty'), {})).toBe(false);
    expect(evaluateCondition(leaf('toString', 'empty'), {})).toBe(true);
    const polluted = JSON.parse('{"__proto__": {"x": 1}}') as Record<string, unknown>;
    expect(evaluateCondition(leaf('x', 'empty'), polluted)).toBe(true);
  });

  it('treats malformed / over-deep trees as false instead of throwing', () => {
    expect(evaluateCondition({ op: 'eq' } as unknown as Condition, {})).toBe(false);
    expect(evaluateCondition({ and: [] }, {})).toBe(false);
    expect(evaluateCondition({ field: 'a', op: 'bogus' } as unknown as Condition, { a: 1 })).toBe(false);
    let deep: Condition = leaf('a', 'eq', 1);
    for (let i = 0; i < MAX_CONDITION_DEPTH + 2; i++) deep = { and: [deep] };
    expect(evaluateCondition(deep, { a: 1 })).toBe(false);
  });

  it('isEmptyValue: unset / null / "" / [] / {} only', () => {
    for (const v of [undefined, null, '', [], {}]) expect(isEmptyValue(v)).toBe(true);
    for (const v of [0, false, ' ', [0], { a: 1 }]) expect(isEmptyValue(v)).toBe(false);
  });
});

describe('conditionSchema', () => {
  it('accepts well-formed conditions', () => {
    for (const c of [
      leaf('a', 'eq', 1),
      leaf('a', 'in', ['x', 2, null]),
      leaf('a', 'empty'),
      { and: [leaf('a', 'gt', 1), { not: leaf('b', 'nempty') }] },
    ]) {
      expect(conditionSchema.safeParse(c).success).toBe(true);
    }
  });

  it.each([
    [{ field: 'a', op: 'in', value: 'x' }, 'in needs an array'],
    [{ field: 'a', op: 'eq' }, 'eq needs a value'],
    [{ field: 'a', op: 'empty', value: 1 }, 'empty takes no value'],
    [{ field: 'a', op: 'gt', value: true }, 'gt needs number/string'],
    [{ field: 'A-bad', op: 'eq', value: 1 }, 'field key pattern'],
    [{ field: 'a', op: 'regex', value: '.*' }, 'unknown operator'],
    [{ field: 'a', op: 'eq', value: { $where: 'x' } }, 'object values'],
    [{ and: [] }, 'empty and'],
    [{ field: 'a', op: 'eq', value: 1, extra: true }, 'unknown keys'],
  ])('rejects %j (%s)', (input, _why) => {
    expect(conditionSchema.safeParse(input).success).toBe(false);
  });
});

describe('no dynamic code execution', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the engine source contains no eval / Function / dynamic RegExp', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../../packages/contracts/src/form-layout/condition.ts', import.meta.url)),
      'utf8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/\bFunction\s*\(/);
    expect(code).not.toMatch(/new\s+RegExp/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });

  it('code-shaped values are compared as plain data and never executed', () => {
    const evalSpy = vi.spyOn(globalThis, 'eval');
    const payload = "globalThis.__pwned = true; process.exit(1)";
    expect(evaluateCondition(leaf('a', 'eq', payload), { a: 'x' })).toBe(false);
    expect(evaluateCondition(leaf('a', 'eq', payload), { a: payload })).toBe(true);
    expect(evaluateCondition(leaf('a', 'contains', ')'), { a: payload })).toBe(true);
    expect(evalSpy).not.toHaveBeenCalled();
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

// ---------- property tests ----------

describe('condition engine — properties', () => {
  it('generated conditions within the limits are schema-valid (the generator models the stored language)', () => {
    fc.assert(
      fc.property(conditionArb, (cond) => {
        const { depth, nodes } = conditionStats(cond);
        fc.pre(depth <= MAX_CONDITION_DEPTH && nodes <= MAX_CONDITION_NODES);
        return conditionSchema.safeParse(cond).success;
      }),
    );
  });

  it('is total and deterministic (never throws; same input → same answer)', () => {
    fc.assert(
      fc.property(conditionArb, dataArb, (cond, data) => {
        const first = evaluateCondition(cond, data);
        return typeof first === 'boolean' && evaluateCondition(cond, structuredClone(data)) === first;
      }),
    );
  });

  it('negation and De Morgan hold (within the depth limit)', () => {
    fc.assert(
      fc.property(leafArb, leafArb, dataArb, (p, q, data) => {
        const e = (c: Condition) => evaluateCondition(c, data);
        expect(e({ not: p })).toBe(!e(p));
        expect(e({ not: { not: p } })).toBe(e(p));
        expect(e({ not: { and: [p, q] } })).toBe(e({ or: [{ not: p }, { not: q }] }));
        expect(e({ not: { or: [p, q] } })).toBe(e({ and: [{ not: p }, { not: q }] }));
      }),
    );
  });

  it('does not mutate the item data it reads', () => {
    fc.assert(
      fc.property(conditionArb, dataArb, (cond, data) => {
        const before = JSON.stringify(data);
        evaluateCondition(cond, data);
        return JSON.stringify(data) === before;
      }),
    );
  });

  it('a JSON round-trip of the condition (as stored in jsonb) evaluates identically', () => {
    fc.assert(
      fc.property(conditionArb, dataArb, (cond, data) => {
        const stored = JSON.parse(JSON.stringify(cond)) as Condition;
        return evaluateCondition(stored, data) === evaluateCondition(cond, data);
      }),
    );
  });
});
