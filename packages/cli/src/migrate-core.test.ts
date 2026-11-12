import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildMigrationPlan,
  ContentfulExportError,
  formatMigrationPlan,
  parseContentfulExport,
  toSnakeName,
  transformContext,
  transformEntry,
  type SourceExport,
} from '@lumibase/contracts/migrate';
import {
  isRichTextDocument,
  richTextToHtml,
  richTextToMarkdown,
  richTextToPlainText,
  safeHref,
  type RichTextDocument,
} from '@lumibase/contracts/richtext';

/**
 * Unit tests for the migration core and rich-text model in
 * `@lumibase/contracts` (#728). The CLI is their main consumer, so they live
 * with it.
 */

const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, '../test/fixtures/contentful-space.json'), 'utf8')) as unknown;

describe('rich text', () => {
  const doc: RichTextDocument = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', level: 2, content: [{ type: 'text', text: 'Hi <there>' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'bold', marks: ['bold'] },
          { type: 'text', text: ' ' },
          { type: 'link', href: 'javascript:alert(1)', content: [{ type: 'text', text: 'evil' }] },
          { type: 'link', href: 'https://example.com/?a=1&b="2"', content: [{ type: 'text', text: 'ok' }] },
          { type: 'ref', ref: { kind: 'item', collection: 'authors', id: 'a1' }, content: [{ type: 'text', text: 'Lan' }] },
        ],
      },
      { type: 'list', ordered: true, items: [[{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }]] },
      { type: 'embed', ref: { kind: 'file', id: 'key/hero.jpg' } },
      { type: 'code', language: 'ts', text: 'a < b' },
      { type: 'table', rows: [{ header: true, cells: [[{ type: 'paragraph', content: [{ type: 'text', text: 'H' }] }]] }] },
    ],
  };

  it('validates the document shape', () => {
    expect(isRichTextDocument(doc)).toBe(true);
    expect(isRichTextDocument({ type: 'doc', version: 1, content: [{ type: 'script' }] })).toBe(false);
    expect(isRichTextDocument({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: ['blink'] }] }] })).toBe(false);
    expect(isRichTextDocument({ type: 'doc', version: 1, content: [{ type: 'embed', ref: { kind: 'item', id: 'x' } }] })).toBe(false);
  });

  it('renders escaped HTML and drops unsafe link schemes', () => {
    const html = richTextToHtml(doc, { resolveRef: (r) => (r.kind === 'file' ? `/assets/${r.id}` : `/items/${r.collection}/${r.id}`) });
    expect(html).toContain('<h2>Hi &lt;there&gt;</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('javascript');
    expect(html).toContain('evil'); // text kept, link dropped
    expect(html).toContain('href="https://example.com/?a=1&amp;b=&quot;2&quot;"');
    expect(html).toContain('<a href="/items/authors/a1" data-ref-kind="item" data-ref-collection="authors" data-ref-id="a1">Lan</a>');
    expect(html).toContain('<img src="/assets/key/hero.jpg"');
    expect(html).toContain('<pre><code class="language-ts">a &lt; b</code></pre>');
    expect(html).toContain('<th><p>H</p></th>');
  });

  it('renders Markdown and plain text', () => {
    const md = richTextToMarkdown(doc);
    expect(md).toContain('## Hi \\<there\\>');
    expect(md).toContain('**bold**');
    expect(md).toContain('[Lan](lumibase://item/authors/a1)');
    expect(md).toContain('1. one');
    expect(md).toContain('```ts\na < b\n```');
    expect(richTextToPlainText(doc)).toBe('Hi <there>\nbold evilokLan\none\na < b\nH');
  });

  it('safeHref allows web, mail, tel and relative URLs only', () => {
    for (const ok of ['https://a.b', 'http://a', 'mailto:x@y', 'tel:+84', '/p', '#h', '?q', 'page.html']) expect(safeHref(ok)).not.toBeNull();
    for (const bad of ['javascript:x', 'JaVaScRiPt:x', 'java\tscript:x', ' javascript:x', 'data:text/html,x', 'vbscript:x', '']) {
      expect(safeHref(bad)).toBeNull();
    }
  });
});

describe('parseContentfulExport', () => {
  const src = parseContentfulExport(FIXTURE);

  it('reads locales, content types, entries and assets', () => {
    expect(src.source).toBe('contentful');
    expect(src.locales).toEqual([
      { code: 'en-US', name: 'English (United States)', default: true },
      { code: 'vi', name: 'Vietnamese', default: false },
    ]);
    expect(src.contentTypes.map((c) => c.id)).toEqual(['author', 'category', 'blogPost', 'product', 'page']);
    expect(src.entries).toHaveLength(7);
    expect(src.assets.map((a) => a.file['en-US']!.url)).toEqual([
      'https://images.ctfassets.net/space/asset-hero/hero.jpg',
      'https://images.ctfassets.net/space/asset-avatar/lan.png',
    ]);
  });

  it('maps every Contentful field type to a kind', () => {
    const post = src.contentTypes.find((c) => c.id === 'blogPost')!;
    expect(Object.fromEntries(post.fields.map((f) => [f.id, f.kind]))).toEqual({
      title: 'shortText',
      slug: 'shortText',
      body: 'richText',
      author: 'entryLink',
      categories: 'entryLinks',
      tags: 'shortTextList',
      heroImage: 'assetLink',
      publishDate: 'date',
      featured: 'boolean',
      status: 'shortText',
    });
    expect(post.fields.find((f) => f.id === 'status')!.choices).toEqual(['news', 'guide']);
    expect(post.fields.find((f) => f.id === 'categories')!.linkContentTypes).toEqual(['category']);
  });

  it('derives status from sys versions', () => {
    const byId = Object.fromEntries(src.entries.map((e) => [e.id, e.status]));
    expect(byId).toMatchObject({ 'post-brew': 'published', 'cat-news': 'draft', 'post-old': 'archived' });
  });

  it('converts rich text, keeping marks, links, lists, tables and embeds', () => {
    const body = src.entries.find((e) => e.id === 'post-brew')!.fields.body!['en-US'] as RichTextDocument;
    expect(isRichTextDocument(body)).toBe(true);
    expect(body.content.map((b) => b.type)).toEqual(['heading', 'paragraph', 'paragraph', 'list', 'quote', 'embed', 'embed', 'table', 'rule', 'paragraph']);
    const para = body.content[1]!;
    expect(para.type === 'paragraph' && para.content).toEqual([
      { type: 'text', text: 'Use ' },
      { type: 'text', text: 'fresh', marks: ['bold'] },
      { type: 'text', text: ' beans and ' },
      { type: 'text', text: 'filtered', marks: ['italic', 'underline'] },
      { type: 'text', text: ' water.' },
      { type: 'break' },
      { type: 'text', text: 'Then wait.' },
    ]);
    expect(body.content[5]).toEqual({ type: 'embed', ref: { kind: 'file', id: 'asset-hero' } });
    expect(body.content[6]).toEqual({ type: 'embed', ref: { kind: 'item', collection: 'product', id: 'product-beans' } });
    const table = body.content[7]!;
    expect(table.type === 'table' && table.rows[0]!.header).toBe(true);
    expect(src.warnings.some((w) => w.includes('missing-entry'))).toBe(true);
  });

  it('rejects files that are not space exports', () => {
    expect(() => parseContentfulExport({ items: [] })).toThrow(ContentfulExportError);
  });
});

describe('buildMigrationPlan', () => {
  const src = parseContentfulExport(FIXTURE);

  it('plans new collections with LumiBase field types', () => {
    const plan = buildMigrationPlan(src, [], { localeMap: { 'en-US': 'en' } });
    expect(plan.collections.map((c) => [c.name, c.action])).toEqual([
      ['author', 'create'],
      ['category', 'create'],
      ['blog_post', 'create'],
      ['product', 'create'],
      ['page', 'create'],
    ]);
    const post = plan.collections.find((c) => c.source === 'blogPost')!;
    const shape = Object.fromEntries(post.fields.map((f) => [f.name, `${f.type}/${f.interface}`]));
    expect(shape).toEqual({
      title: 'json/translatable-text',
      slug: 'string/input',
      body: 'json/richtext',
      author: 'string/relation-m2o',
      categories: 'json/json-raw',
      tags: 'json/tags',
      hero_image: 'string/file',
      publish_date: 'datetime/datetime',
      featured: 'boolean/toggle',
      status_field: 'string/select-dropdown',
    });
    expect(post.relations).toEqual([{ manyCollection: 'blog_post', manyField: 'author', oneCollection: 'author', type: 'm2o' }]);
    expect(post.displayTemplate).toBe('{{title}}');
    const page = plan.collections.find((c) => c.source === 'page')!;
    expect(page.fields.find((f) => f.name === 'location')).toMatchObject({ type: 'geometry', interface: 'map' });
    expect(page.fields.find((f) => f.name === 'featured_item')).toMatchObject({ type: 'json', storage: 'polyLink' });
    expect(page.fields.find((f) => f.name === 'seo_score')).toMatchObject({ storage: 'localeMap', itemStorage: 'value' });
    expect(plan.defaultLocale).toEqual({ source: 'en-US', target: 'en' });
  });

  it('never changes existing fields: compatible ones are kept, conflicting ones get a new name', () => {
    const plan = buildMigrationPlan(src, [
      { name: 'author', fields: [{ name: 'name', type: 'string' }, { name: 'bio', type: 'integer' }] },
    ]);
    const author = plan.collections.find((c) => c.source === 'author')!;
    expect(author.action).toBe('update');
    expect(author.fields.find((f) => f.source === 'name')).toMatchObject({ name: 'name', action: 'existing' });
    expect(author.fields.find((f) => f.source === 'bio')).toMatchObject({ name: 'bio_contentful', action: 'create' });
    expect(plan.conflicts).toEqual(['author.bio exists as integer; author.bio (json) goes to bio_contentful.']);
  });

  it('prefixes collection names and keeps them valid', () => {
    const plan = buildMigrationPlan(src, [], { collectionPrefix: 'cf_' });
    expect(plan.collections.map((c) => c.name)).toEqual(['cf_author', 'cf_category', 'cf_blog_post', 'cf_product', 'cf_page']);
    expect(toSnakeName('heroImageURL')).toBe('hero_image_url');
    expect(toSnakeName('2col')).toBe('f_2col');
  });

  it('formats a readable dry-run report', () => {
    const text = formatMigrationPlan(buildMigrationPlan(src, []));
    expect(text).toContain('+ create collection blog_post  (blogPost)');
    expect(text).toContain('+ relation blog_post.author → author (m2o)');
    expect(text).toContain('Source: contentful · 5 content types · 7 entries · 2 assets');
  });
});

describe('transformEntry', () => {
  const src: SourceExport = parseContentfulExport(FIXTURE);
  const plan = buildMigrationPlan(src, [], { localeMap: { 'en-US': 'en' } });
  const assets = new Map([
    ['asset-hero', 'k/hero.jpg'],
    ['asset-avatar', 'k/lan.png'],
  ]);
  const ctx = transformContext(src, plan, assets);
  const item = (id: string) => transformEntry(src.entries.find((e) => e.id === id)!, ctx)!;

  it('builds item data with locale maps, links, files and typed values', () => {
    const post = item('post-brew');
    expect(post.collection).toBe('blog_post');
    expect(post.item.id).toBe('post-brew');
    expect(post.item.status).toBe('published');
    expect(post.item.data).toMatchObject({
      title: { en: 'How to brew', vi: 'Cách pha' },
      slug: 'how-to-brew',
      author: 'author-lan',
      categories: ['cat-guides', 'cat-news'],
      tags: ['coffee', 'howto'],
      hero_image: 'k/hero.jpg',
      publish_date: '2026-03-01T09:00:00.000Z',
      featured: true,
      status_field: 'guide',
    });
    const body = (post.item.data.body as Record<string, RichTextDocument>).en!;
    expect(body.content[5]).toEqual({ type: 'embed', ref: { kind: 'file', id: 'k/hero.jpg' } });
    expect(body.content[6]).toEqual({ type: 'embed', ref: { kind: 'item', collection: 'product', id: 'product-beans' } });
  });

  it('converts locations, polymorphic links and localized numbers', () => {
    expect(item('page-home').item.data).toMatchObject({
      location: { type: 'Point', coordinates: [106.7009, 10.7769] },
      featured_item: { collection: 'blog_post', id: 'post-brew' },
      seo_score: { en: 90, vi: 85 },
    });
    expect(item('product-beans').item.data).toMatchObject({
      price: 12.5,
      stock: 40,
      gallery: ['k/hero.jpg', 'k/lan.png'],
      specs: { origin: 'Đà Lạt', roast: 'medium' },
      related: [
        { collection: 'blog_post', id: 'post-brew' },
        { collection: 'author', id: 'author-lan' },
      ],
    });
  });

  it('leaves un-uploaded assets empty with a warning', () => {
    const noAssets = transformContext(src, plan);
    const author = transformEntry(src.entries.find((e) => e.id === 'author-lan')!, noAssets)!;
    expect(author.item.data.avatar).toBeNull();
    expect(author.warnings[0]).toContain('asset asset-avatar was not uploaded');
  });
});

describe('importEntries — 409 handling', () => {
  const run = async (createError: unknown) => {
    const { importEntries } = await import('./commands/migrate');
    const { LumiError } = await import('@lumibase/sdk');
    const exported = parseContentfulExport(JSON.parse(readFileSync(resolve(__dirname, '../test/fixtures/contentful-space.json'), 'utf8')));
    const plan = buildMigrationPlan(exported, []);
    const patched: string[] = [];
    const client = {
      items: () => ({
        create: async () => {
          throw new LumiError(409, createError);
        },
        patch: async (id: string) => {
          patched.push(id);
          return {};
        },
      }),
    };
    const result = await importEntries(exported, plan, new Map(), client as never, (fn) => fn());
    return { result, patched };
  };

  it('updates in place when the id already exists', async () => {
    const { result, patched } = await run({ errors: [{ code: 'ITEM_ID_EXISTS', message: 'exists' }] });
    expect(result.updated).toBe(7);
    expect(patched).toHaveLength(7);
  });

  it('reports any other 409 as a failure instead of patching', async () => {
    const { result, patched } = await run({ errors: [{ code: 'EDITORIAL_GATE_REQUIRED', message: 'Item must be approved' }] });
    expect(patched).toHaveLength(0);
    expect(result.failed).toHaveLength(7);
    expect(result.failed[0]).toMatch(/Item must be approved/);
  });
});
