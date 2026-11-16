import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyHiddenValuePolicy,
  missingRequiredFields,
  validateFormLayout,
  type FormLayout,
} from '@lumibase/contracts/form-layout';
import { validateItem } from '../validation';
import type { CompiledField } from '../schema-service';
import { dataArb, KEYS, layoutArb } from './form-layout-arbitraries';

/**
 * Server-side required validation under a form layout (#750).
 * Acceptance: a field hidden by a condition skips required validation ONLY
 * when it (or an ancestor node) is configured `skipRequiredWhenHidden`.
 */

function field(name: string, overrides: Partial<CompiledField> = {}): CompiledField {
  return {
    id: `f_${name}`,
    name,
    type: 'string',
    interface: 'input',
    display: null,
    label: null,
    note: null,
    defaultValue: null,
    nullable: true,
    unique: false,
    indexed: false,
    searchable: true,
    length: null,
    precision: null,
    scale: null,
    special: [],
    translations: {},
    options: {},
    displayOptions: {},
    validation: { rules: [] },
    conditions: [],
    required: false,
    readonly: false,
    hidden: false,
    encrypted: false,
    classification: 'none',
    versioned: false,
    rawEnabled: true,
    width: 'full',
    group: null,
    sortOrder: 0,
    ...overrides,
  };
}

/** `url` lives in a group shown only when `kind` = 'link'. */
function layoutFor(opts: { skip?: boolean; on?: 'field' | 'group'; hiddenValue?: 'keep' | 'clear' }): FormLayout {
  const flags = {
    ...(opts.skip !== undefined ? { skipRequiredWhenHidden: opts.skip } : {}),
    ...(opts.hiddenValue ? { hiddenValue: opts.hiddenValue } : {}),
  };
  return {
    version: 1,
    nodes: [
      { type: 'field', field: 'kind' },
      {
        type: 'group',
        id: 'link',
        visibleWhen: { field: 'kind', op: 'eq', value: 'link' },
        ...(opts.on === 'group' ? flags : {}),
        children: [{ type: 'field', field: 'url', ...(opts.on !== 'group' ? flags : {}) }],
      },
    ],
  };
}

const fields = [field('kind'), field('url', { required: true })];
const issueFields = (r: ReturnType<typeof validateItem>) => (r.ok ? [] : r.issues.map((i) => i.field));

describe('validateItem — required × hidden × skip matrix (create)', () => {
  // [description, data, layout, url required error expected]
  const cases: Array<[string, Record<string, unknown>, FormLayout | null, boolean]> = [
    ['no layout, url missing → required', { kind: 'text' }, null, true],
    ['visible, skip=false, missing → required', { kind: 'link' }, layoutFor({ skip: false }), true],
    ['visible, skip=true, missing → still required (only hidden skips)', { kind: 'link' }, layoutFor({ skip: true }), true],
    ['hidden, flag unset (default false) → required', { kind: 'text' }, layoutFor({}), true],
    ['hidden, skip=false → required', { kind: 'text' }, layoutFor({ skip: false }), true],
    ['hidden, skip=true on field → skipped', { kind: 'text' }, layoutFor({ skip: true }), false],
    ['hidden, skip=true on ancestor group → skipped', { kind: 'text' }, layoutFor({ skip: true, on: 'group' }), false],
    ['hidden, skip=true, null value → skipped', { kind: 'text', url: null }, layoutFor({ skip: true }), false],
    ['visible, value present → ok', { kind: 'link', url: 'https://x' }, layoutFor({ skip: false }), false],
  ];

  it.each(cases)('%s', (_name, data, layout, expectError) => {
    const result = validateItem(fields, data, { layout });
    expect(issueFields(result).includes('url')).toBe(expectError);
  });

  it('a nearer explicit false overrides an ancestor true', () => {
    const layout = layoutFor({ skip: true, on: 'group' });
    const group = layout.nodes[1] as Extract<FormLayout['nodes'][number], { type: 'group' }>;
    group.children = [{ type: 'field', field: 'url', skipRequiredWhenHidden: false }];
    expect(issueFields(validateItem(fields, { kind: 'text' }, { layout }))).toContain('url');
  });

  it('hidden + skipped still type-checks a stale value', () => {
    const result = validateItem(fields, { kind: 'text', url: 42 }, { layout: layoutFor({ skip: true }) });
    expect(issueFields(result)).toContain('url');
  });
});

describe('validateItem — PATCH (partial) uses the merged record for conditions', () => {
  it('patching kind away from link lets url=null pass only with skip', () => {
    const merged = { kind: 'text', url: null };
    expect(issueFields(validateItem(fields, { url: null }, { partial: true, layout: layoutFor({ skip: true }), context: merged }))).toEqual([]);
    expect(issueFields(validateItem(fields, { url: null }, { partial: true, layout: layoutFor({ skip: false }), context: merged }))).toContain('url');
  });

  it('the stored record (not just the patch) decides visibility', () => {
    // Patch only clears url; stored kind=link keeps the group visible → required.
    const merged = { kind: 'link', url: null };
    expect(issueFields(validateItem(fields, { url: null }, { partial: true, layout: layoutFor({ skip: true }), context: merged }))).toContain('url');
  });
});

describe('hidden value policy on save', () => {
  const optional = [field('kind'), field('url')];

  it('defaults to keep — the stale value is stored untouched', () => {
    const out = applyHiddenValuePolicy(optional, { kind: 'text', url: 'stale' }, layoutFor({}));
    expect(out.data).toEqual({ kind: 'text', url: 'stale' });
    expect(out.cleared).toEqual([]);
  });

  it('clear drops a hidden field value (inherited from the group)', () => {
    const layout = layoutFor({ on: 'group', hiddenValue: 'clear' });
    expect(applyHiddenValuePolicy(optional, { kind: 'text', url: 'stale' }, layout)).toEqual({
      data: { kind: 'text' },
      cleared: ['url'],
    });
    // Visible → untouched.
    expect(applyHiddenValuePolicy(optional, { kind: 'link', url: 'x' }, layout).data).toEqual({ kind: 'link', url: 'x' });
  });

  it('never clears a value the required rule still demands', () => {
    const layout = layoutFor({ hiddenValue: 'clear', skip: false });
    expect(applyHiddenValuePolicy(fields, { kind: 'text', url: 'v' }, layout).cleared).toEqual([]);
    const skipping = layoutFor({ hiddenValue: 'clear', skip: true });
    expect(applyHiddenValuePolicy(fields, { kind: 'text', url: 'v' }, skipping).cleared).toEqual(['url']);
  });
});

describe('client and server agree (property)', () => {
  const requiredArb = fc.array(fc.boolean(), { minLength: KEYS.length, maxLength: KEYS.length });
  // Values restricted to what a string field can carry so type errors never mix in.
  const stringDataArb = dataArb.map((d) =>
    Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'string' || v === null || v === undefined ? v : String(v)])),
  );

  it('generated layouts pass schema validation', () => {
    fc.assert(fc.property(layoutArb, (layout) => validateFormLayout(layout, KEYS).ok));
  });

  it('Studio missingRequiredFields ≡ CMS validateItem required issues (create and patch)', () => {
    fc.assert(
      fc.property(layoutArb, requiredArb, stringDataArb, fc.boolean(), (layout, required, data, partial) => {
        const compiled = KEYS.map((k, i) => field(k, { required: required[i]! }));
        const server = new Set(issueFields(validateItem(compiled, data, { layout, partial })));
        const client = new Set(missingRequiredFields(compiled, data, layout, { partial }));
        expect([...client].sort()).toEqual([...server].sort());
      }),
      { numRuns: 300 },
    );
  });

  it('without skip flags a layout never relaxes required (fail closed)', () => {
    fc.assert(
      fc.property(layoutArb, stringDataArb, (layout, data) => {
        const strip = JSON.parse(JSON.stringify(layout).replace(/"skipRequiredWhenHidden":true/g, '"skipRequiredWhenHidden":false')) as FormLayout;
        const compiled = KEYS.map((k) => field(k, { required: true }));
        const withLayout = issueFields(validateItem(compiled, data, { layout: strip })).sort();
        const without = issueFields(validateItem(compiled, data, {})).sort();
        expect(withLayout).toEqual(without);
      }),
    );
  });
});
