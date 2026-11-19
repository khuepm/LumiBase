import { describe, expect, it } from 'vitest';
import {
  TemplatePlanInputSchema,
  selectedSeedPack,
  applyNamespace,
  canonicalTemplateJson,
  namespaceMap,
  satisfiesVersionRange,
  validateBackendTemplate,
  type BackendTemplate,
} from '../index';

/** #903 (BT03) — pure planning pieces. */

const wordpress: BackendTemplate = (() => {
  const doc = {
    formatVersion: 'lumibase.template@v1',
    slug: 'wordpress-alike',
    displayName: 'WordPress alike',
    templateVersion: '1.0.0',
    description: 'A wordpress-style model; wordpress_posts is only text here.',
    compatibility: { cmsVersionRange: '>=2.2.0', storageModes: ['jsonb'] },
    config: {
      version: 'lumibase.config@v1',
      collections: [
        { name: 'wordpress_authors', note: 'Authors as in wordpress' },
        { name: 'wordpress_posts', displayTemplate: '{{title}} (wordpress)' },
        { name: 'wordpress_tags' },
        { name: 'wordpress_post_tags' },
      ],
      fields: [
        { collection: 'wordpress_authors', field: 'name', type: 'string', interface: 'input', required: true, note: 'wordpress_authors.name' },
        { collection: 'wordpress_posts', field: 'title', type: 'string', interface: 'input', required: true, options: { placeholder: 'wordpress_posts title' } },
        { collection: 'wordpress_posts', field: 'author', type: 'string', interface: 'input' },
        { collection: 'wordpress_tags', field: 'name', type: 'string', interface: 'input' },
        { collection: 'wordpress_post_tags', field: 'post', type: 'string', interface: 'input' },
        { collection: 'wordpress_post_tags', field: 'tag', type: 'string', interface: 'input' },
        { collection: 'wordpress_posts', field: 'tags', type: 'alias', interface: 'list-m2m' },
      ],
      relations: [
        { manyCollection: 'wordpress_posts', manyField: 'author', oneCollection: 'wordpress_authors', type: 'm2o' },
        { manyCollection: 'wordpress_post_tags', manyField: 'post', oneCollection: 'wordpress_posts', type: 'm2o' },
        { manyCollection: 'wordpress_post_tags', manyField: 'tag', oneCollection: 'wordpress_tags', type: 'm2o' },
        {
          manyCollection: 'wordpress_posts', manyField: 'tags', oneCollection: 'wordpress_tags', type: 'm2m',
          junctionCollection: 'wordpress_post_tags', junctionManyField: 'post', junctionOneField: 'tag',
        },
      ],
    },
    seedPacks: {
      demo: {
        records: [
          { key: 'a1', collection: 'wordpress_authors', values: { name: 'Ann from wordpress' } },
          { key: 'p1', collection: 'wordpress_posts', values: { title: 'Moving off wordpress_posts' }, references: { author: 'a1' } },
        ],
      },
    },
  };
  const result = validateBackendTemplate(doc);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.template;
})();

describe('BT03-AC04 — namespace rewrites every structural reference, never text', () => {
  const rename = Object.fromEntries(wordpress.config.collections.map((c) => [c.name, c.name.replace(/^wordpress_/, 'blog_')]));

  it('wordpress → blog', () => {
    const { map, errors } = namespaceMap(wordpress, { map: rename });
    expect(errors).toEqual([]);
    const mapped = applyNamespace(wordpress, map);
    expect(mapped.config.collections.map((c) => c.name)).toEqual(['blog_authors', 'blog_posts', 'blog_tags', 'blog_post_tags']);
    expect(new Set(mapped.config.fields.map((f) => f.collection))).toEqual(new Set(['blog_authors', 'blog_posts', 'blog_tags', 'blog_post_tags']));
    expect(mapped.config.relations).toContainEqual(expect.objectContaining({
      manyCollection: 'blog_posts', oneCollection: 'blog_tags', junctionCollection: 'blog_post_tags',
    }));
    expect(mapped.config.relations.map((r) => [r.manyCollection, r.oneCollection].join('>'))).not.toContainEqual(expect.stringContaining('wordpress'));
    expect(mapped.seedPacks!['demo']!.records.map((r) => r.collection)).toEqual(['blog_authors', 'blog_posts']);
    // Text that merely mentions the old names is untouched.
    expect(mapped.description).toBe(wordpress.description);
    expect(mapped.config.collections[0]!.note).toBe('Authors as in wordpress');
    expect(mapped.config.collections[1]!.displayTemplate).toBe('{{title}} (wordpress)');
    expect(mapped.config.fields[0]!.note).toBe('wordpress_authors.name');
    expect(mapped.config.fields[1]!.options).toEqual({ placeholder: 'wordpress_posts title' });
    expect(mapped.seedPacks!['demo']!.records[1]!.values).toEqual({ title: 'Moving off wordpress_posts' });
    // Field names, seed keys and references are unchanged.
    expect(mapped.config.fields.map((f) => f.field)).toEqual(wordpress.config.fields.map((f) => f.field));
    expect(mapped.seedPacks!['demo']!.records[1]!.references).toEqual({ author: 'a1' });
    // The renamed template is still a valid template, and the input is not mutated.
    expect(validateBackendTemplate(mapped).ok).toBe(true);
    expect(canonicalTemplateJson(wordpress)).toContain('"wordpress_posts"');
    // A structural string search finds no old name outside text properties.
    const structural = JSON.stringify({ c: mapped.config.collections.map((c) => c.name), f: mapped.config.fields.map((f) => f.collection), r: mapped.config.relations, s: mapped.seedPacks!['demo']!.records.map((r) => r.collection) });
    expect(structural).not.toContain('wordpress');
  });

  it('prefix applies to every collection not in the map', () => {
    const { map } = namespaceMap(wordpress, { prefix: 'x_', map: { wordpress_tags: 'labels' } });
    expect(map).toEqual({
      wordpress_authors: 'x_wordpress_authors',
      wordpress_posts: 'x_wordpress_posts',
      wordpress_tags: 'labels',
      wordpress_post_tags: 'x_wordpress_post_tags',
    });
  });

  it('refuses unknown sources, clashes, bad and reserved targets', () => {
    expect(namespaceMap(wordpress, { map: { ghosts: 'x' } }).errors[0]!.path).toBe('$.namespace.map["ghosts"]');
    expect(namespaceMap(wordpress, { map: { wordpress_tags: 'wordpress_posts' } }).errors.some((e) => /both become/.test(e.message))).toBe(true);
    expect(namespaceMap(wordpress, { map: { wordpress_tags: 'Tags' } }).errors).toHaveLength(1);
    expect(namespaceMap(wordpress, { prefix: 'lumibase_' }).errors.length).toBeGreaterThan(0);
  });
});

describe('plan input contract', () => {
  it('requires an explicit target and exactly one of slug / displayName', () => {
    const base = { template: { source: 'site', slug: 'blog', version: '1.0.0' }, targetSiteId: 'site_b' };
    expect(TemplatePlanInputSchema.safeParse(base).success).toBe(true);
    expect(TemplatePlanInputSchema.safeParse({ template: base.template }).success).toBe(false);
    expect(TemplatePlanInputSchema.safeParse({ ...base, template: { ...base.template, displayName: 'Blog' } }).success).toBe(false);
    expect(TemplatePlanInputSchema.safeParse({ ...base, template: { source: 'site', version: '1.0.0' } }).success).toBe(false);
    expect(TemplatePlanInputSchema.safeParse({ ...base, seedPack: null }).success).toBe(true);
    expect(TemplatePlanInputSchema.safeParse({ ...base, siteId: 'x' }).success).toBe(false);
  });
});

describe('BT05-W1 — seedMode none|pack, default none', () => {
  const base = { template: { source: 'site', slug: 'blog', version: '1.0.0' }, targetSiteId: 'site_b' };
  it('defaults to none and refuses contradictions', () => {
    expect(selectedSeedPack(TemplatePlanInputSchema.parse(base))).toBeNull();
    expect(selectedSeedPack(TemplatePlanInputSchema.parse({ ...base, seedMode: 'none' }))).toBeNull();
    expect(selectedSeedPack(TemplatePlanInputSchema.parse({ ...base, seedMode: 'pack', seedPack: 'demo' }))).toBe('demo');
    expect(selectedSeedPack(TemplatePlanInputSchema.parse({ ...base, seedPack: 'demo' }))).toBe('demo');
    expect(TemplatePlanInputSchema.safeParse({ ...base, seedMode: 'none', seedPack: 'demo' }).success).toBe(false);
    expect(TemplatePlanInputSchema.safeParse({ ...base, seedMode: 'pack' }).success).toBe(false);
    expect(TemplatePlanInputSchema.safeParse({ ...base, seedMode: 'all' }).success).toBe(false);
  });
});

describe('CMS version ranges', () => {
  it.each([
    ['2.3.1', '>=2.2.0', true],
    ['2.1.9', '>=2.2.0', false],
    ['2.3.1', '>=2.2.0 <3.0.0', true],
    ['3.0.0', '>=2.2.0 <3.0.0', false],
    ['3.0.0-beta.1', '>=2.2.0 <3.0.0', true],
    ['2.9.0', '^2.2.0', true],
    ['3.0.0', '^2.2.0', false],
    ['0.2.5', '^0.2.1', true],
    ['0.3.0', '^0.2.1', false],
    ['2.2.9', '~2.2.0', true],
    ['2.3.0', '~2.2.0', false],
    ['2.4.7', '2.x', true],
    ['3.0.0', '2.x', false],
    ['1.0.0', '*', true],
    ['1.5.0', '<1.0.0 || >=1.4.0', true],
    ['1.2.0', '<1.0.0 || >=1.4.0', false],
    ['2.2.0', '= 2.2.0', true],
  ])('%s in %s → %s', (version, range, expected) => {
    expect(satisfiesVersionRange(version, range)).toBe(expected);
  });

  it('is undecided (null) for an unknown version or a garbled range', () => {
    expect(satisfiesVersionRange('unknown', '>=2.0.0')).toBeNull();
    expect(satisfiesVersionRange('2.0.0', 'TBD_AT_IMPLEMENTATION')).toBeNull();
  });
});
