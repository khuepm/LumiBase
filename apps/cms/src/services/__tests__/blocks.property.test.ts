import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { validateItem } from '../validation';
import { resolveBlockTemplates } from '../blocks';
import { ALL, getCompiledFrom, pages } from './blocks-fixtures';

/**
 * Dynamic zones (#748) — property tests.
 *
 *  P1  Any well-formed block list (incl. nested zones) validates and
 *      round-trips unchanged: same order, ids, types and data.
 *  P2  Corrupting exactly one location of a well-formed list is rejected,
 *      and the first issue's path names that exact location.
 */

const id = fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/);
const heroData = fc.record(
  { title: fc.string(), subtitle: fc.option(fc.string(), { nil: null }), height: fc.nat(1000) },
  { requiredKeys: ['title'] },
);
const ctaData = fc.record(
  { label: fc.string(), url: fc.constantFrom('https://example.com', 'https://lumibase.dev/x') },
  { requiredKeys: ['label'] },
);
const leaf = fc.oneof(
  fc.record({ type: fc.constant('hero'), data: heroData }),
  fc.record({ type: fc.constant('cta'), data: ctaData }),
);
const column = fc.record({
  type: fc.constant('columns'),
  data: fc.record({ gap: fc.nat(10), items: fc.array(leaf, { maxLength: 4 }) }, { requiredKeys: ['items'] }),
});
const sectionsArb = fc.array(fc.oneof(leaf, column), { maxLength: 8 });

type Block = { id: string; type: string; data: Record<string, unknown> };

/** Assign unique ids per list (ids must be unique within one zone). */
function withIds(blocks: Array<{ type: string; data: Record<string, unknown> }>, ids: string[]): Block[] {
  return blocks.map((b, i) => {
    const data = Array.isArray(b.data.items)
      ? { ...b.data, items: withIds(b.data.items as Block[], ids.map((x) => `${x}n`)) }
      : b.data;
    return { id: `${ids[i % ids.length]}-${i}`, type: b.type, data };
  });
}

const blockTemplatesPromise = resolveBlockTemplates(pages.fields, (n) => getCompiledFrom(ALL, n));

describe('blocks properties', () => {
  it('P1: valid block lists round-trip unchanged', async () => {
    const blockTemplates = await blockTemplatesPromise;
    fc.assert(
      fc.property(sectionsArb, fc.array(id, { minLength: 1, maxLength: 8 }), (raw, ids) => {
        const sections = withIds(raw, ids);
        const r = validateItem(pages.fields, { sections }, { blockTemplates });
        expect(r).toEqual({ ok: true, data: { sections } });
      }),
      { numRuns: 200 },
    );
  });

  type Corruption = { kind: string; apply: (b: Block) => Block; suffix: Array<string | number> };
  const corruptions: Corruption[] = [
    { kind: 'unknown-type', apply: (b) => ({ ...b, type: 'nope' }), suffix: ['type'] },
    { kind: 'disallowed-type', apply: (b) => ({ ...b, type: 'pages' }), suffix: ['type'] },
    { kind: 'bad-id', apply: (b) => ({ ...b, id: 'bad id!' }), suffix: ['id'] },
    { kind: 'data-not-object', apply: (b) => ({ ...b, data: 42 as unknown as Record<string, unknown> }), suffix: ['data'] },
    { kind: 'unknown-data-key', apply: (b) => ({ ...b, data: { ...b.data, zzz_unknown: 1 } }), suffix: ['data', 'zzz_unknown'] },
    {
      kind: 'wrong-required-type',
      apply: (b) =>
        b.type === 'hero'
          ? { ...b, data: { ...b.data, title: 123 } }
          : b.type === 'cta'
            ? { ...b, data: { ...b.data, label: 123 } }
            : { ...b, data: { ...b.data, gap: 'x' } },
      suffix: [],
    },
  ];
  const requiredKeyFor = (b: Block) => (b.type === 'hero' ? 'title' : b.type === 'cta' ? 'label' : 'gap');

  it('P2: a single corruption is rejected with a path-precise issue', async () => {
    const blockTemplates = await blockTemplatesPromise;
    fc.assert(
      fc.property(
        fc.array(fc.oneof(leaf, column), { minLength: 1, maxLength: 6 }),
        fc.array(id, { minLength: 1, maxLength: 6 }),
        fc.nat(),
        fc.constantFrom(...corruptions),
        (raw, ids, pick, corruption) => {
          const sections = withIds(raw, ids);
          const index = pick % sections.length;
          sections[index] = corruption.apply(sections[index]!);
          const suffix = corruption.suffix.length ? corruption.suffix : ['data', requiredKeyFor(sections[index]!)];

          const r = validateItem(pages.fields, { sections }, { blockTemplates });
          expect(r.ok).toBe(false);
          if (r.ok) return;
          expect(r.issues[0]!.path).toEqual(['sections', index, ...suffix]);
        },
      ),
      { numRuns: 200 },
    );
  });
});
