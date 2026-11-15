import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { resolveAccessView } from '../openapi-access';
import { generateOpenApiDocument } from '../openapi-generator';
import type { OpenApiRealm } from '../openapi-config';
import type { TypegenManifest } from '../../typegen-service';
import {
  ADMIN_BUNDLE,
  bundleOf,
  collection,
  field,
  matrixManifest,
  perm,
  propertyKeys,
  validateOpenApi,
} from './fixtures';
import type { PermissionBundle } from '../../permission-service';

function build(manifest: TypegenManifest, bundle: PermissionBundle, realm: OpenApiRealm = 'studio') {
  return generateOpenApiDocument({
    manifest,
    access: resolveAccessView(bundle, manifest, realm),
    realm,
    siteId: 'site-a',
    schemaVersion: 3,
  });
}

type Doc = ReturnType<typeof build>;
const schemasOf = (doc: Doc) =>
  (doc['components'] as { schemas: Record<string, { properties?: Record<string, Record<string, unknown>> }> }).schemas;
const pathsOf = (doc: Doc) => doc['paths'] as Record<string, Record<string, unknown>>;

describe('generateOpenApiDocument — field-type matrix', () => {
  it('produces a valid OpenAPI 3.1 document for an admin', async () => {
    const doc = build(matrixManifest(), ADMIN_BUNDLE);
    const result = await validateOpenApi(doc);
    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(doc.openapi).toBe('3.1.0');
  });

  it('maps every field type, relation, file, localized and JSON field', () => {
    const props = schemasOf(build(matrixManifest(), ADMIN_BUNDLE))['posts.Fields']!.properties!;
    expect(props['title']).toEqual({ type: 'string' });
    expect(props['body']).toEqual({ type: ['string', 'null'] });
    expect(props['views']).toEqual({ type: ['integer', 'null'] });
    expect(props['big']).toEqual({ type: ['integer', 'null'], format: 'int64' });
    expect(props['price']).toEqual({ type: ['number', 'null'] });
    expect(props['featured']).toEqual({ type: ['boolean', 'null'] });
    expect(props['meta']).toEqual({}); // json → any (SDK: unknown)
    expect(props['ref_uuid']).toEqual({ type: ['string', 'null'], format: 'uuid' });
    expect(props['day']).toEqual({ type: ['string', 'null'], format: 'date' });
    expect(props['published_on']).toEqual({ type: ['string', 'null'], format: 'date-time' });
    expect(props['kind']).toEqual({ type: ['string', 'null'], enum: ['news', 'blog', null] });
    expect(props['headline']).toMatchObject({ type: ['object', 'null'], additionalProperties: { type: 'string' } });
    expect(props['cover']).toMatchObject({ type: ['string', 'null'] });
    expect(props['gallery']).toMatchObject({ type: ['array', 'null'], items: { type: 'string' } });
    // Admin holds read_decrypted, so the encrypted field is its plain type.
    expect(props['secret_note']).toEqual({ type: ['string', 'null'] });
    expect(props['slug']).toMatchObject({ readOnly: true });
    // m2o on the stored row is the target's id; o2m is an array of ids.
    expect(props['author']).toEqual({ type: ['string', 'null'] });
    expect(props['comments']).toEqual({ type: ['array', 'null'], items: { type: 'integer' } });
    // A presentation alias has no wire value.
    expect(props).not.toHaveProperty('divider');
  });

  it('documents relation/file expansion on the projection only', () => {
    const projection = schemasOf(build(matrixManifest(), ADMIN_BUNDLE))['posts.Projection']!.properties!;
    expect(projection['author']).toMatchObject({
      anyOf: [{ anyOf: [{ type: 'string' }, { $ref: '#/components/schemas/authors.Projection' }] }, { type: 'null' }],
    });
    expect(projection['cover']).toMatchObject({ anyOf: [{ anyOf: [{ type: 'string' }, { type: 'object' }] }, { type: 'null' }] });
    expect(projection['created_at']).toEqual({ type: 'string', format: 'date-time' });
  });

  it('uses the {data, meta} / {errors} envelopes', () => {
    const doc = build(matrixManifest(), ADMIN_BUNDLE);
    const list = pathsOf(doc)['/items/posts']!['get'] as { responses: Record<string, Record<string, unknown>> };
    const okSchema = (list.responses['200']!['content'] as Record<string, { schema: Record<string, unknown> }>)['application/json']!.schema;
    expect(Object.keys(okSchema['properties'] as object)).toEqual(['data', 'meta']);
    expect(list.responses['404']).toEqual({ $ref: '#/components/responses/Error' });
    expect(schemasOf(doc)['ErrorResponse']).toMatchObject({ required: ['errors'] });
    expect(doc['servers']).toEqual([{ url: '/api/v1' }]);
  });

  it('documents write operations only for granted actions', () => {
    const bundle = bundleOf([perm('posts', 'read'), perm('posts', 'update', ['title', 'body'])]);
    const doc = build(matrixManifest(), bundle);
    const paths = pathsOf(doc);
    expect(Object.keys(paths['/items/posts']!)).toEqual(['get']);
    expect(Object.keys(paths['/items/posts/{id}']!).sort()).toEqual(['get', 'parameters', 'patch']);
    const update = schemasOf(doc)['posts.UpdateInput']!.properties!['data'] as { properties: Record<string, unknown> };
    expect(Object.keys(update.properties)).toEqual(['title', 'body']);
    expect(schemasOf(doc)).not.toHaveProperty('posts.CreateInput');
  });
});

describe('generateOpenApiDocument — permissions', () => {
  it('never lists a collection the caller cannot read', async () => {
    const bundle = bundleOf([perm('posts', 'read'), perm('authors', 'read')]);
    const doc = build(matrixManifest(), bundle);
    const text = JSON.stringify(doc);
    expect(text).not.toContain('payroll');
    expect(text).not.toContain('salary');
    expect(Object.keys(pathsOf(doc)).some((path) => path.includes('comments'))).toBe(false);
    // `comments` the o2m FIELD stays (posts can read it), but has no $ref to
    // the unreadable `comments` collection.
    expect(text).not.toContain('comments.Projection');
    expect((await validateOpenApi(doc)).valid).toBe(true);
  });

  it('applies field masks (whitelist and `-exclude`) like maskItem does', () => {
    const bundle = bundleOf([perm('posts', 'read', ['*', '-secret_note', '-price']), perm('authors', 'read', ['name'])]);
    const doc = build(matrixManifest(), bundle);
    const keys = propertyKeys(doc);
    expect(keys.has('secret_note')).toBe(false);
    expect(keys.has('price')).toBe(false);
    expect(keys.has('title')).toBe(true);
    expect(keys.has('email')).toBe(false);
    expect(keys.has('name')).toBe(true);
  });

  it('never documents a write field that is not also readable', () => {
    const bundle = bundleOf([perm('posts', 'read', ['title']), perm('posts', 'create', ['title', 'price'])]);
    const doc = build(matrixManifest(), bundle);
    const create = schemasOf(doc)['posts.CreateInput']!.properties!['data'] as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(create.properties)).toEqual(['title']);
    expect(create.required).toEqual(['title']);
    expect(propertyKeys(doc).has('price')).toBe(false);
  });

  it("documents the '***' mask on encrypted fields for a caller without read_decrypted", () => {
    const doc = build(matrixManifest(), bundleOf([perm('posts', 'read')]));
    expect(schemasOf(doc)['posts.Fields']!.properties!['secret_note']).toMatchObject({
      anyOf: [{ anyOf: [{ type: 'string' }, { const: '***' }] }, { type: 'null' }],
    });
  });

  it('shows encrypted fields unmasked to a caller with read_decrypted', () => {
    const doc = build(matrixManifest(), bundleOf([perm('posts', 'read'), perm('posts', 'read_decrypted')]));
    expect(schemasOf(doc)['posts.Fields']!.properties!['secret_note']).toEqual({ type: ['string', 'null'] });
  });

  it('gives the public realm a read-only surface even if writes were granted', async () => {
    const bundle = bundleOf([perm('posts', 'read', ['title']), perm('posts', 'create'), perm('posts', 'delete')]);
    const doc = build(matrixManifest(), bundle, 'public');
    const paths = pathsOf(doc);
    for (const item of Object.values(paths)) {
      for (const method of ['post', 'patch', 'put', 'delete']) expect(item).not.toHaveProperty(method);
    }
    expect(doc['security']).toEqual([{ siteHeader: [] }]);
    expect((await validateOpenApi(doc)).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property-based: for ANY schema and ANY permission set, the document is valid
// OpenAPI 3.1 and never names a hidden field or collection.
// ---------------------------------------------------------------------------

const FIELD_TYPES = ['string', 'text', 'integer', 'bigInteger', 'decimal', 'boolean', 'json', 'uuid', 'date', 'datetime', 'time', 'timestamp', 'csv', 'hash', 'geometry'];
const INTERFACES = [undefined, 'input', 'translatable-text', 'file', 'files'];
// Fixed-length names: two distinct names can never be substrings of each other.
const name = fc.stringMatching(/^[a-z]{10}$/);

const scenario = fc
  .uniqueArray(name, { minLength: 2, maxLength: 5 })
  .chain((collectionNames) =>
    fc.record({
      collectionNames: fc.constant(collectionNames),
      fieldSets: fc.tuple(
        ...collectionNames.map(() =>
          fc.uniqueArray(
            fc.record({
              name,
              type: fc.constantFrom(...FIELD_TYPES),
              iface: fc.constantFrom(...INTERFACES),
              required: fc.boolean(),
              encrypted: fc.boolean(),
              relateTo: fc.option(fc.nat({ max: collectionNames.length - 1 }), { nil: undefined }),
              readable: fc.boolean(),
              writable: fc.boolean(),
            }),
            { selector: (f) => f.name, minLength: 1, maxLength: 6 },
          ),
        ),
      ),
      collectionReadable: fc.tuple(...collectionNames.map(() => fc.boolean())),
      useExclude: fc.boolean(),
      realm: fc.constantFrom<OpenApiRealm>('studio', 'frontend', 'api_key', 'public'),
    }),
  );

describe('generateOpenApiDocument — properties', () => {
  it('is always valid OpenAPI 3.1 and never leaks a hidden field or collection', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        // Field names must be unique across the whole site for the substring check.
        const allFieldNames = s.fieldSets.flat().map((f) => f.name);
        fc.pre(new Set([...allFieldNames, ...s.collectionNames]).size === allFieldNames.length + s.collectionNames.length);

        const manifest: TypegenManifest = {
          version: 2,
          site: 'site-a',
          collections: s.collectionNames.map((cname, i) =>
            collection(
              cname,
              s.fieldSets[i]!.map((f) =>
                f.relateTo !== undefined
                  ? field(f.name, 'string', { kind: 'm2o', target: s.collectionNames[f.relateTo]!, required: f.required })
                  : field(f.name, f.type, { interface: f.iface, required: f.required, encrypted: f.encrypted }),
              ),
              {
                relations: s.fieldSets[i]!
                  .filter((f) => f.relateTo !== undefined)
                  .map((f) => ({
                    field: f.name,
                    kind: 'm2o' as const,
                    target: s.collectionNames[f.relateTo!]!,
                    manyCollection: cname,
                    manyField: f.name,
                    oneCollection: s.collectionNames[f.relateTo!]!,
                    oneField: null,
                    junctionCollection: null,
                    relationType: 'm2o' as const,
                    alias: f.name,
                  })),
              },
            ),
          ),
        };

        const perms = s.collectionNames.flatMap((cname, i) => {
          if (!s.collectionReadable[i]) return [];
          const fields = s.fieldSets[i]!;
          const readMask = s.useExclude
            ? ['*', ...fields.filter((f) => !f.readable).map((f) => `-${f.name}`)]
            : fields.filter((f) => f.readable).map((f) => f.name);
          return [
            perm(cname, 'read', readMask),
            perm(cname, 'create', fields.filter((f) => f.writable).map((f) => f.name)),
            perm(cname, 'update', ['*']),
            perm(cname, 'delete'),
          ];
        });

        const doc = build(manifest, bundleOf(perms), s.realm);
        const text = JSON.stringify(doc);

        s.collectionNames.forEach((cname, i) => {
          if (!s.collectionReadable[i]) {
            expect(text).not.toContain(`${cname}`);
            for (const f of s.fieldSets[i]!) expect(text).not.toContain(`"${f.name}"`);
          } else {
            for (const f of s.fieldSets[i]!) if (!f.readable) expect(text).not.toContain(`"${f.name}"`);
          }
        });
        if (s.realm === 'public') {
          expect(text).not.toMatch(/"(post|patch|put|delete)":/);
        }

        const result = await validateOpenApi(doc);
        if (!result.valid) throw new Error(JSON.stringify(result.errors).slice(0, 2000));
      }),
      { numRuns: 60 },
    );
  });
});
