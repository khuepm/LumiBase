import { describe, expect, it } from 'vitest';
import { buildSchema, GraphQLList, GraphQLNonNull, GraphQLObjectType, isObjectType } from 'graphql';
import { Validator } from '@seriousme/openapi-schema-validator';

import { generateGraphQLSdl, generateOpenApi, generateTypes, generateZod } from '../index';
import { FIXTURE_MANIFEST } from './fixture-manifest';

/**
 * Golden outputs for every typegen target from one fixture manifest.
 * Regenerate after an intentional change with `vitest --run -u`.
 */
const golden = (name: string, actual: string) =>
  expect(actual).toMatchFileSnapshot(`./__golden__/${name}`);

const ts = `${generateTypes(FIXTURE_MANIFEST, { importSource: '@lumibase/sdk' })}\n`;
const zod = `${generateZod(FIXTURE_MANIFEST)}\n`;
const sdl = generateGraphQLSdl(FIXTURE_MANIFEST);
const openapi = generateOpenApi(FIXTURE_MANIFEST);

describe('typegen targets — golden outputs', () => {
  it('ts', async () => golden('types.ts.golden', ts));
  it('zod', async () => golden('zod.golden.ts', zod));
  it('graphql-sdl', async () => golden('schema.graphql', sdl));
  it('openapi', async () => golden('openapi.json', `${JSON.stringify(openapi, null, 2)}\n`));

  it('is deterministic and carries no site id', () => {
    expect(generateZod(FIXTURE_MANIFEST)).toBe(generateZod(FIXTURE_MANIFEST));
    for (const output of [zod, sdl, JSON.stringify(openapi)]) expect(output).not.toContain('site_fixture');
  });
});

describe('ts target — localized, file and float fields', () => {
  it('types per-locale maps and file references by interface', () => {
    expect(ts).toContain('headline: Partial<Record<Locale, string>>;');
    expect(ts).toContain('cover?: string | null;');
    expect(ts).toContain('gallery?: string[] | null;');
    expect(ts).toContain('rating?: number | null;');
    expect(ts).toContain('published_at?: string | null;');
  });
});

describe('zod target — parses and rejects real data', () => {
  // The golden file is a real module: importing it proves the generated
  // source compiles against the installed `zod`.
  const load = () => import('./__golden__/zod.golden');

  const validPost = {
    id: 'p_1',
    status: 'draft',
    updated_at: '2026-01-01T00:00:00Z',
    title: 'Hello',
    views: 3,
    featured: false,
    kind: 'news',
    headline: { en: 'Hello', vi: 'Xin chào' },
    cover: 'file_1',
    gallery: ['file_2', 'file_3'],
    metadata: { anything: [1, 2, 3] },
    author_id: null,
    tags: [1, { id: 2, label: 'x' }],
  };

  it('accepts a valid item, including nulls on nullable fields', async () => {
    const { Blog_postsSchema, LumibaseSchemas } = await load();
    expect(Blog_postsSchema.safeParse(validPost).success).toBe(true);
    expect(LumibaseSchemas.blog_posts).toBe(Blog_postsSchema);
    expect(Blog_postsSchema.safeParse({ ...validPost, body: null, rating: null }).success).toBe(true);
  });

  it('rejects a wrong scalar, a value outside the enum, and a missing required field', async () => {
    const { Blog_postsSchema } = await load();
    expect(Blog_postsSchema.safeParse({ ...validPost, views: 'three' }).success).toBe(false);
    expect(Blog_postsSchema.safeParse({ ...validPost, views: 1.5 }).success).toBe(false);
    expect(Blog_postsSchema.safeParse({ ...validPost, kind: 'opinion' }).success).toBe(false);
    const { title: _title, ...withoutTitle } = validPost;
    expect(Blog_postsSchema.safeParse(withoutTitle).success).toBe(false);
    expect(Blog_postsSchema.safeParse({ ...validPost, title: null }).success).toBe(false);
  });

  it('validates localized maps and file arrays', async () => {
    const { Blog_postsSchema } = await load();
    expect(Blog_postsSchema.safeParse({ ...validPost, headline: { en: 1 } }).success).toBe(false);
    expect(Blog_postsSchema.safeParse({ ...validPost, gallery: 'file_2' }).success).toBe(false);
  });

  it('accepts the masked value of an encrypted field, and integer primary keys', async () => {
    const { AuthorsSchema, TagsSchema } = await load();
    expect(AuthorsSchema.safeParse({ id: 'a', created_at: 'x', name: 'N', email: '***' }).success).toBe(true);
    expect(AuthorsSchema.safeParse({ id: 'a', created_at: 'x', name: 'N', email: 5 }).success).toBe(false);
    expect(TagsSchema.safeParse({ id: 1, label: 't' }).success).toBe(true);
    expect(TagsSchema.safeParse({ id: '1', label: 't' }).success).toBe(false);
  });
});

describe('graphql-sdl target', () => {
  const schema = buildSchema(sdl);

  it('parses with graphql buildSchema', () => {
    expect(schema.getQueryType()?.name).toBe('Query');
    expect(schema.getMutationType()?.getFields()['create_blog_posts']).toBeDefined();
    expect(schema.getSubscriptionType()?.getFields()['tags_events']).toBeDefined();
  });

  it('uses the server type names and nested relation fields', () => {
    const posts = schema.getType('BlogPosts');
    const authors = schema.getType('Authors');
    expect(isObjectType(posts) && isObjectType(authors)).toBe(true);
    const postFields = (posts as GraphQLObjectType).getFields();
    expect(String(postFields['author']?.type)).toBe('Authors');
    expect(String(postFields['views']?.type)).toBe('Int');
    expect(String(postFields['rating']?.type)).toBe('Float');
    expect(String(postFields['big_count']?.type)).toBe('String');
    expect(String(postFields['published_at']?.type)).toBe('DateTime');
    expect(String(postFields['metadata']?.type)).toBe('JSON');
    // The structural column wins over the content field of the same name.
    expect(String(postFields['status']?.type)).toBe('String');
    const authorPosts = (authors as GraphQLObjectType).getFields()['posts'];
    expect(authorPosts?.type).toBeInstanceOf(GraphQLNonNull);
    expect((authorPosts?.type as GraphQLNonNull<GraphQLList<never>>).ofType).toBeInstanceOf(GraphQLList);
    expect(authorPosts?.args.map((arg) => arg.name)).toEqual(['limit', 'offset']);
  });

  it('omits Mutation and Subscription for a collection-less site', () => {
    const empty = buildSchema(generateGraphQLSdl({ version: 2, site: 's', collections: [] }));
    expect(empty.getMutationType()).toBeUndefined();
    expect(empty.getSubscriptionType()).toBeUndefined();
  });
});

describe('openapi target', () => {
  it('validates against the OpenAPI 3.1 schema', async () => {
    const validator = new Validator();
    const result = await validator.validate(openapi as unknown as Record<string, unknown>);
    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(validator.version).toBe('3.1');
  });

  it('documents { data, meta } envelopes, nullability and enums', () => {
    const schemas = openapi.components.schemas;
    expect(schemas['blog_posts.ListResponse']).toMatchObject({
      required: ['data'],
      properties: { meta: { $ref: '#/components/schemas/PaginationMeta' } },
    });
    const fields = schemas['blog_posts.Fields'] as { properties: Record<string, unknown>; required: string[] };
    expect(fields.properties['body']).toEqual({ type: ['string', 'null'] });
    expect(fields.properties['kind']).toEqual({ type: 'string', enum: ['news', 'guide', 'review'] });
    expect(fields.properties['headline']).toMatchObject({ type: 'object', additionalProperties: { type: 'string' } });
    expect(fields.required).toEqual(expect.arrayContaining(['title', 'views', 'featured', 'kind', 'headline']));
    expect(schemas['tags.Item']).toMatchObject({ properties: { id: { type: 'integer' } } });
  });
});
