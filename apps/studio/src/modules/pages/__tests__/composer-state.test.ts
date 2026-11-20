// @vitest-environment jsdom
import { PageLayoutSchema } from '@lumibase/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addRegion,
  addSection,
  duplicateSection,
  issuesBySection,
  moveToRegion,
  regionOf,
  removeRegion,
  removeSection,
  reorderWithinRegion,
  sectionsIn,
  setLocales,
  stepSection,
  toComposerLayout,
} from '../composer-state';

/** Page composer state (epic #667, V06 #684). */

const empty = () => toComposerLayout({ version: 1, regions: [{ key: 'main' }, { key: 'sidebar' }], sections: [] }).layout;

describe('toComposerLayout', () => {
  it('keeps a v1 layout and adds the default region', () => {
    const { layout, converted } = toComposerLayout({ version: 1, sections: [] });
    expect(converted).toBe(false);
    expect(layout.regions).toEqual([{ key: 'main' }]);
  });

  it('converts a free-form layout without losing sections, and declares their regions', () => {
    const { layout, converted } = toComposerLayout({
      sections: [
        { id: 'a', component: 'hero', data: { title: 'x' }, styleConfig: { region: 'footer', theme: 'dark' }, source: { collection: 'posts' } },
        { component: 'cta' },
        'garbage',
      ],
    });
    expect(converted).toBe(true);
    expect(layout.version).toBe(1);
    expect(layout.sections).toHaveLength(2);
    expect(layout.sections[0]).toMatchObject({ id: 'a', data: { title: 'x' }, styleConfig: { region: 'footer', theme: 'dark' } });
    expect(layout.sections[1]!.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(layout.regions!.map((r) => r.key)).toEqual(['main', 'footer']);
  });

  it('never throws on arbitrary stored JSON (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (stored) => {
        expect(() => toComposerLayout(stored)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});

describe('editing', () => {
  it('adds, moves between regions, reorders within a region, duplicates and removes', () => {
    let layout = empty();
    const a = addSection(layout, 'hero', 'main');
    layout = a.layout;
    const b = addSection(layout, 'cta', 'main');
    layout = b.layout;
    const c = addSection(layout, 'promo', 'sidebar');
    layout = c.layout;
    expect(sectionsIn(layout, 'main').map((s) => s.component)).toEqual(['hero', 'cta']);
    expect(regionOf(layout.sections.find((s) => s.id === c.id)!)).toBe('sidebar');
    // The default region is not written explicitly.
    expect(layout.sections[0]!.styleConfig).toEqual({});

    layout = stepSection(layout, b.id, -1);
    expect(sectionsIn(layout, 'main').map((s) => s.component)).toEqual(['cta', 'hero']);
    expect(stepSection(layout, b.id, -1)).toBe(layout);
    // Cross-region "reorder" is refused; moving is explicit.
    expect(reorderWithinRegion(layout, b.id, c.id)).toBe(layout);
    layout = moveToRegion(layout, b.id, 'sidebar');
    expect(sectionsIn(layout, 'sidebar').map((s) => s.component)).toEqual(['promo', 'cta']);

    const dup = duplicateSection(layout, a.id);
    layout = dup.layout;
    expect(dup.id).not.toBe(a.id);
    expect(sectionsIn(layout, 'main').map((s) => s.component)).toEqual(['hero', 'hero']);
    layout = removeSection(layout, dup.id);
    expect(layout.sections).toHaveLength(3);
    expect(PageLayoutSchema.safeParse(layout).success).toBe(true);
  });

  it('sets and clears locale visibility', () => {
    let layout = empty();
    const a = addSection(layout, 'hero', 'main');
    layout = setLocales(a.layout, a.id, ['vi', 'vi', 'en']);
    expect(layout.sections[0]!.styleConfig.locales).toEqual(['vi', 'en']);
    layout = setLocales(layout, a.id, []);
    expect(layout.sections[0]!.styleConfig).not.toHaveProperty('locales');
  });

  it('manages regions: valid unique keys only; only empty non-default regions can be removed', () => {
    const layout = empty();
    expect(addRegion(layout, 'Footer')).toBe('invalid');
    expect(addRegion(layout, 'sidebar')).toBe('duplicate');
    const withFooter = addRegion(layout, 'footer');
    expect(typeof withFooter).toBe('object');
    expect(removeRegion(layout, 'main')).toBeNull();
    const filled = addSection(layout, 'hero', 'sidebar').layout;
    expect(removeRegion(filled, 'sidebar')).toBeNull();
    expect(removeRegion(layout, 'sidebar')!.regions!.map((r) => r.key)).toEqual(['main']);
  });

  it('keeps the layout schema-valid under any sequence of edits (property)', () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('add' as const), component: fc.constantFrom('hero', 'cta'), region: fc.constantFrom('main', 'sidebar') }),
      fc.record({ kind: fc.constant('step' as const), index: fc.nat(10), delta: fc.constantFrom(-1 as const, 1 as const) }),
      fc.record({ kind: fc.constant('move' as const), index: fc.nat(10), region: fc.constantFrom('main', 'sidebar') }),
      fc.record({ kind: fc.constant('dup' as const), index: fc.nat(10) }),
      fc.record({ kind: fc.constant('remove' as const), index: fc.nat(10) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
        let layout = empty();
        for (const o of ops) {
          const target = layout.sections[o.kind === 'add' ? 0 : o.index % Math.max(layout.sections.length, 1)];
          if (o.kind === 'add') layout = addSection(layout, o.component, o.region).layout;
          else if (!target) continue;
          else if (o.kind === 'step') layout = stepSection(layout, target.id, o.delta);
          else if (o.kind === 'move') layout = moveToRegion(layout, target.id, o.region);
          else if (o.kind === 'dup') layout = duplicateSection(layout, target.id).layout;
          else layout = removeSection(layout, target.id);
        }
        expect(PageLayoutSchema.safeParse(layout).success).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('issuesBySection', () => {
  it('maps server error paths onto section ids', () => {
    const layout = toComposerLayout({ version: 1, sections: [{ id: 'a', component: 'hero' }, { id: 'b', component: 'cta' }] }).layout;
    const mapped = issuesBySection(layout, [
      { code: 'VALIDATION', message: 'Required', field: 'sections.1.data.title' },
      { code: 'UNKNOWN_BLOCK', message: 'nope', field: 'sections.0.component' },
      { code: 'VALIDATION', message: 'Region keys must be unique.', field: 'regions' },
      { code: 'X', message: 'out of range', field: 'sections.9.data' },
    ]);
    expect(mapped.bySection.get('b')).toEqual([{ code: 'VALIDATION', message: 'Required', field: 'data.title' }]);
    expect(mapped.bySection.get('a')![0]!.field).toBe('component');
    expect(mapped.general.map((i) => i.field)).toEqual(['regions', 'sections.9.data']);
  });
});

describe('#684 review fixes', () => {
  it('lists the keys a v1 layout cannot carry', () => {
    const { dropped, converted } = toComposerLayout({ theme: 'dark', seo: {}, sections: [{ id: 'a', component: 'hero', analyticsKey: 'x' }] });
    expect(converted).toBe(true);
    expect(dropped).toEqual(['theme', 'seo', 'sections.0.analyticsKey']);
    expect(toComposerLayout({ version: 1, sections: [] }).dropped).toEqual([]);
  });

  it('adds to the default region when the target region is not declared', () => {
    const layout = toComposerLayout({ version: 1, regions: [{ key: 'main' }], sections: [] }).layout;
    const added = addSection(layout, 'hero', 'gone');
    expect(added.layout.sections[0]!.styleConfig.region).toBeUndefined();
  });
});
