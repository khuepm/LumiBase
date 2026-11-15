import { describe, expect, it, vi } from 'vitest';
import { graphql, printSchema, printType, isUnionType, type GraphQLSchema } from 'graphql';
import { buildSiteSchema, normalizeBlocksForRead } from '../schema-builder';
import type { GraphQLContext } from '../context';
import type { CompiledCollection } from '../../services/schema-service';
import { ALL, blocksField, cf, coll } from '../../services/__tests__/blocks-fixtures';

/** Dynamic zones (#748): `blocks` fields surface as lists of a per-field union. */

function fakeSchemaService(collections: CompiledCollection[]) {
  return {
    listCollections: vi.fn(async () => collections.map((c) => ({ name: c.name }))),
    getCompiled: vi.fn(async (name: string) => collections.find((c) => c.name === name) ?? null),
    listRelations: vi.fn(async () => []),
  } as unknown as Parameters<typeof buildSiteSchema>[0];
}

function ctxWith(items: Record<string, unknown>): GraphQLContext {
  return { siteId: 'site-1', items, schema: {} } as unknown as GraphQLContext;
}

function pageRow(sections: unknown) {
  return {
    id: 'p1',
    status: 'published',
    data: { title: 'Home', sections },
    sort: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

/** Only the block-related types, so unrelated schema changes don't churn the snapshot. */
function blockSdl(schema: GraphQLSchema): string {
  return Object.values(schema.getTypeMap())
    .filter((t) => !t.name.startsWith('__') && /Blocks?\d*$/.test(t.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => printType(t))
    .join('\n\n');
}

const QUERY = `query {
  pages_by_id(id: "p1") {
    title
    sections {
      __typename
      ... on HeroBlock { id type title height }
      ... on CtaBlock { id label url }
      ... on ColumnsBlock { id gap items { __typename ... on HeroBlock { title } ... on CtaBlock { label } } }
    }
  }
}`;

describe('GraphQL blocks union', () => {
  it('builds one union per blocks field over the allowed block object types (snapshot)', async () => {
    const schema = await buildSiteSchema(fakeSchemaService(ALL));
    const union = schema.getType('PagesSectionsBlocks');
    expect(union && isUnionType(union)).toBe(true);
    if (!union || !isUnionType(union)) return;
    expect(union.getTypes().map((t) => t.name)).toEqual(['HeroBlock', 'CtaBlock', 'ColumnsBlock']);
    expect(printSchema(schema)).toContain('sections: [PagesSectionsBlocks!]!');
    expect(blockSdl(schema)).toMatchSnapshot();
  });

  it('resolves blocks to their concrete types via the `type` discriminator, in order, incl. nested zones', async () => {
    const detail = vi.fn(async () =>
      pageRow([
        { id: 'h', type: 'hero', data: { title: 'Hi', height: 3 } },
        { id: 'c', type: 'cta', data: { label: 'Go', url: 'https://x.dev' } },
        {
          id: 'k',
          type: 'columns',
          data: { gap: 1, items: [{ id: 'n1', type: 'cta', data: { label: 'In' } }, { id: 'n2', type: 'hero', data: { title: 'Deep' } }] },
        },
      ]),
    );
    const schema = await buildSiteSchema(fakeSchemaService(ALL));
    const result = await graphql({ schema, source: QUERY, contextValue: ctxWith({ detail }) });
    expect(result.errors).toBeUndefined();
    expect(result.data?.pages_by_id).toEqual({
      title: 'Home',
      sections: [
        { __typename: 'HeroBlock', id: 'h', type: 'hero', title: 'Hi', height: 3 },
        { __typename: 'CtaBlock', id: 'c', label: 'Go', url: 'https://x.dev' },
        {
          __typename: 'ColumnsBlock',
          id: 'k',
          gap: 1,
          items: [
            { __typename: 'CtaBlock', label: 'In' },
            { __typename: 'HeroBlock', title: 'Deep' },
          ],
        },
      ],
    });
  });

  it.each([null, undefined, 'garbage', {}])('returns [] for a %j zone instead of erroring', async (stored) => {
    const detail = vi.fn(async () => pageRow(stored));
    const schema = await buildSiteSchema(fakeSchemaService(ALL));
    const result = await graphql({ schema, source: QUERY, contextValue: ctxWith({ detail }) });
    expect(result.errors).toBeUndefined();
    expect((result.data?.pages_by_id as { sections: unknown[] }).sections).toEqual([]);
  });

  it('drops blocks whose type is not a union member (e.g. template deleted) instead of failing', async () => {
    const detail = vi.fn(async () =>
      pageRow([{ id: 'x', type: 'ghost', data: {} }, null, { id: 'c', type: 'cta', data: null }]),
    );
    const schema = await buildSiteSchema(fakeSchemaService(ALL));
    const result = await graphql({ schema, source: QUERY, contextValue: ctxWith({ detail }) });
    expect(result.errors).toBeUndefined();
    expect((result.data?.pages_by_id as { sections: unknown[] }).sections).toEqual([
      { __typename: 'CtaBlock', id: 'c', label: null, url: null },
    ]);
  });

  it('falls back to JSON when no allowed template resolves', async () => {
    const lonely = coll('lonely', [blocksField('zone', ['ghost'])]);
    const schema = await buildSiteSchema(fakeSchemaService([lonely]));
    expect(printSchema(schema)).toMatch(/zone: JSON/);
  });

  it('suffixes block type names that collide with an existing collection type', async () => {
    const heroBlock = coll('hero_block', [cf('x', 'string')]);
    const schema = await buildSiteSchema(fakeSchemaService([...ALL, heroBlock]));
    expect(schema.getType('HeroBlock')).toBeDefined(); // the collection's item type
    const union = schema.getType('PagesSectionsBlocks');
    if (!union || !isUnionType(union)) throw new Error('union missing');
    expect(union.getTypes().map((t) => t.name)).toEqual(['HeroBlock2', 'CtaBlock', 'ColumnsBlock']);
  });

  it('normalizeBlocksForRead coerces missing ids/data', () => {
    expect(normalizeBlocksForRead([{ type: 'cta' }], new Set(['cta']))).toEqual([{ id: '', type: 'cta', data: {} }]);
  });
});
