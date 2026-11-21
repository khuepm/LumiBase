import {
  isComposerLayout,
  PageLayoutSchema,
  PreviewSettingsSchema,
  selectPageSections,
} from '@lumibase/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

/** Page layout v1 contract (epic #667, V06 #684). Pure — no database. */

const base = { version: 1 as const, sections: [] };

describe('PageLayoutSchema', () => {
  it('accepts a minimal layout and fills section defaults', () => {
    const parsed = PageLayoutSchema.parse({ ...base, sections: [{ id: 'a', component: 'hero' }] });
    expect(parsed.sections[0]).toEqual({ id: 'a', component: 'hero', data: {}, styleConfig: {} });
  });

  it('rejects duplicate ids, duplicate or unknown regions, unknown keys and draft sources', () => {
    const bad = [
      { ...base, sections: [{ id: 'a', component: 'hero' }, { id: 'a', component: 'hero' }] },
      { ...base, regions: [{ key: 'main' }, { key: 'main' }] },
      { ...base, sections: [{ id: 'a', component: 'hero', styleConfig: { region: 'footer' } }] },
      { ...base, sections: [{ id: 'a', component: 'hero', children: [] }] },
      { ...base, extra: true },
      { ...base, sections: [{ id: 'a', component: 'hero', source: { collection: 'posts', status: 'draft' } }] },
      { ...base, sections: [{ id: 'a', component: 'hero', source: { collection: 'posts', limit: 500 } }] },
      { ...base, sections: [{ id: 'a', component: 'Hero!' }] },
      { ...base, sections: [{ id: 'a', component: 'hero', styleConfig: { locales: ['../x'] } }] },
      { version: 2, sections: [] },
    ];
    for (const layout of bad) expect(PageLayoutSchema.safeParse(layout).success, JSON.stringify(layout)).toBe(false);
  });

  it('keeps free style keys next to region/locales', () => {
    const parsed = PageLayoutSchema.parse({
      ...base,
      regions: [{ key: 'main' }, { key: 'sidebar' }],
      sections: [{ id: 'a', component: 'hero', styleConfig: { region: 'sidebar', locales: ['vi'], theme: 'dark' } }],
    });
    expect(parsed.sections[0]!.styleConfig).toEqual({ region: 'sidebar', locales: ['vi'], theme: 'dark' });
  });

  it('only version 1 layouts are composer layouts', () => {
    expect(isComposerLayout({ version: 1 })).toBe(true);
    expect(isComposerLayout({ sections: [] })).toBe(false);
    expect(isComposerLayout(null)).toBe(false);
  });
});

describe('selectPageSections', () => {
  const sections = [
    { id: '1', component: 'hero' },
    { id: '2', component: 'hero', styleConfig: { region: 'sidebar' } },
    { id: '3', component: 'hero', styleConfig: { locales: ['vi'] } },
    { id: '4', component: 'hero', styleConfig: { locales: ['en', 'vi'] } },
  ];

  it('filters by region (default main) and locale, keeping order', () => {
    expect(selectPageSections(sections).map((s) => s.id)).toEqual(['1', '3', '4']);
    expect(selectPageSections(sections, { locale: 'en' }).map((s) => s.id)).toEqual(['1', '4']);
    expect(selectPageSections(sections, { region: 'sidebar', locale: 'vi' }).map((s) => s.id)).toEqual(['2']);
  });

  it('never invents or reorders sections (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string(),
            component: fc.constant('x'),
            styleConfig: fc.option(fc.record({ region: fc.constantFrom('main', 'sidebar'), locales: fc.option(fc.subarray(['en', 'vi', 'fr'])) }), { nil: undefined }),
          }),
        ),
        fc.constantFrom('main', 'sidebar'),
        fc.option(fc.constantFrom('en', 'vi', 'fr')),
        (list, region, locale) => {
          const out = selectPageSections(list as never[], { region, locale });
          let cursor = 0;
          for (const s of out) {
            const found = list.indexOf(s as never, cursor);
            expect(found).toBeGreaterThanOrEqual(cursor);
            cursor = found + 1;
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('preview settings pageUrl', () => {
  it('accepts an http(s) page template and rejects javascript:', () => {
    expect(PreviewSettingsSchema.safeParse({ pageUrl: 'https://www.example.com/{slug}' }).success).toBe(true);
    expect(PreviewSettingsSchema.safeParse({ pageUrl: null }).success).toBe(true);
    expect(PreviewSettingsSchema.safeParse({ pageUrl: 'javascript:alert(1)//{slug}' }).success).toBe(false);
  });
});

describe('collection meta.pageBlock', () => {
  it('must be a boolean', async () => {
    const { collectionPatchSchema } = await import('../../routes/collections');
    expect(collectionPatchSchema.safeParse({ meta: { pageBlock: true } }).success).toBe(true);
    expect(collectionPatchSchema.safeParse({ meta: { pageBlock: 'yes' } }).success).toBe(false);
  });
});
