import { describe, expect, it, vi } from 'vitest';
import { graphql, printSchema } from 'graphql';
import { buildSiteSchema } from '../schema-builder';
import type { GraphQLContext } from '../context';
import type { CompiledCollection, CompiledField } from '../../services/schema-service';

/** richtext fields surface as a shared `RichText { json html markdown text }` type (#695 / #700). */

/** Minimal compiled field factory. */
function field(name: string, type: string): CompiledField {
  return {
    id: `f-${name}`,
    name,
    type,
    interface: 'input',
    display: null,
    label: null,
    note: null,
    defaultValue: null,
    nullable: true,
    unique: false,
    indexed: false,
    searchable: false,
    length: null,
    precision: null,
    scale: null,
    special: [],
    translations: {},
    options: {},
    displayOptions: {},
    validation: {},
    conditions: [],
    required: false,
    readonly: false,
    hidden: false,
    encrypted: false,
    classification: 'none',
    versioned: false,
    rawEnabled: false,
    width: 'full',
    group: null,
    sortOrder: 0,
  };
}

function collection(name: string, fields: CompiledField[]): CompiledCollection {
  return {
    id: `c-${name}`,
    name,
    label: null,
    pluralLabel: null,
    hidden: false,
    system: false,
    singleton: false,
    icon: null,
    color: null,
    note: null,
    primaryKeyField: 'id',
    primaryKeyType: 'nanoid',
    storageMode: 'jsonb',
    displayTemplate: null,
    sortField: null,
    archiveField: null,
    archiveValue: null,
    unarchiveValue: null,
    itemDuplicationFields: [],
    translations: {},
    accountability: 'all',
    versioning: false,
    meta: {},
    systemFields: [],
    fields,
  };
}

function fakeSchemaService(collections: CompiledCollection[], relations: unknown[] = []) {
  return {
    listCollections: vi.fn(async () => collections.map((c) => ({ name: c.name }))),
    getCompiled: vi.fn(async (name: string) => collections.find((c) => c.name === name) ?? null),
    listRelations: vi.fn(async () => relations),
  } as unknown as Parameters<typeof buildSiteSchema>[0];
}

const doc = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'heading', level: 2, content: [{ type: 'text', text: 'Hi <there>' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'bold', marks: ['bold'] },
        { type: 'link', href: 'javascript:alert(1)', content: [{ type: 'text', text: ' evil' }] },
      ],
    },
    { type: 'embed', ref: { kind: 'file', id: 'file_1234' }, alt: 'A cat' },
    { type: 'table', caption: 'T', rows: [{ header: true, cells: [[{ type: 'paragraph', content: [{ type: 'text', text: 'H' }] }]] }, { cells: [[{ type: 'paragraph', content: [{ type: 'text', text: 'v' }] }]] }] },
  ],
};

const posts = collection('posts', [field('title', 'string'), field('body', 'richtext')]);

describe('richtext in GraphQL', () => {
  it('maps richtext to one shared RichText type', async () => {
    const sdl = printSchema(await buildSiteSchema(fakeSchemaService([posts])));
    expect(sdl).toMatch(/type RichText \{[\s\S]*json: JSON[\s\S]*html: String[\s\S]*markdown: String[\s\S]*text: String[\s\S]*\}/);
    expect(sdl).toMatch(/body: RichText\b/);
  });

  it('returns JSON plus sanitised, semantic HTML; malformed values read as null', async () => {
    const list = vi.fn(async () => ({
      data: [
        { id: 'a', status: 'published', data: { title: 'A', body: doc } },
        { id: 'b', status: 'published', data: { title: 'B', body: '<p>legacy html</p>' } },
      ],
      meta: { total: 2 },
    }));
    const schema = await buildSiteSchema(fakeSchemaService([posts]));
    const result = await graphql({
      schema,
      source: 'query { posts { title body { json html text markdown } } }',
      contextValue: { siteId: 's', items: { list }, schema: {} } as unknown as GraphQLContext,
    });
    expect(result.errors).toBeUndefined();
    const rows = result.data?.posts as Array<{ title: string; body: { json: unknown; html: string; text: string; markdown: string } | null }>;
    expect(rows[1]!.body).toBeNull();
    const body = rows[0]!.body!;
    expect(body.json).toEqual(doc);
    expect(body.html).toContain('<h2>Hi &lt;there&gt;</h2>');
    expect(body.html).not.toContain('javascript');
    expect(body.html).toContain('<figure data-ref-kind="file" data-ref-id="file_1234"><img src="/api/v1/files/file_1234/content" alt="A cat"></figure>');
    expect(body.html).toContain('<table><caption>T</caption><thead><tr><th scope="col">H</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>');
    expect(body.text).toContain('Hi <there>');
    expect(body.markdown).toContain('## Hi \\<there\\>');
  });

  it('renders custom blocks named after a collection through its display template, escaped (#697)', async () => {
    const callout = { ...collection('callout', [field('title', 'string')]), displayTemplate: 'Note: {{title}}' };
    const withBlock = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'custom', name: 'callout', data: { title: '<b>Hi</b>' } },
        { type: 'custom', name: 'unknown', data: { title: 'x' } },
      ],
    };
    const list = vi.fn(async () => ({ data: [{ id: 'a', status: 'published', data: { title: 'A', body: withBlock } }], meta: { total: 1 } }));
    const schema = await buildSiteSchema(fakeSchemaService([posts, callout]));
    const result = await graphql({
      schema,
      source: 'query { posts { body { html text } } }',
      contextValue: { siteId: 's', items: { list }, schema: {} } as unknown as GraphQLContext,
    });
    expect(result.errors).toBeUndefined();
    const body = (result.data?.posts as Array<{ body: { html: string; text: string } }>)[0]!.body;
    expect(body.html).toBe('<div data-block="callout"><p>Note: &lt;b&gt;Hi&lt;/b&gt;</p></div><div data-block="unknown"></div>');
    expect(body.text).toBe('Note: <b>Hi</b>');
  });
});
