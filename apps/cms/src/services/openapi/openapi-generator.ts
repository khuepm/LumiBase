import type { TypegenCollection, TypegenManifest } from '../typegen-service';
import type { AccessView, CollectionAccess } from './openapi-access';
import type { OpenApiRealm } from './openapi-config';
import { fieldSchema, type FieldSchemaContext, type JsonSchema } from './field-schema';

/**
 * Live OpenAPI 3.1 document for one site, as seen by one caller (#745).
 *
 * Pure: everything permission-related arrives pre-resolved in `access`, so
 * the generator cannot widen what a caller sees — a collection missing from
 * `access` is never emitted, and a field missing from `access.read` is never
 * named anywhere in the document (paths, schemas, or descriptions).
 *
 * Shapes follow `routes/items.ts` exactly:
 * - default reads return the stored row: system columns at the top level
 *   (camelCase) and user fields under `data`;
 * - reads with `?fields=` return a flat projection (system columns in
 *   snake_case, user fields inline, relations/files expandable);
 * - success bodies are `{ data, meta? }`, failures `{ errors: [...] }`.
 */
export interface GenerateOpenApiInput {
  manifest: TypegenManifest;
  access: AccessView;
  realm: OpenApiRealm;
  siteId: string;
  schemaVersion: number;
}

export type OpenApiDocument = Record<string, unknown> & { openapi: '3.1.0' };

const ERROR_REF = '#/components/responses/Error';

/** Component keys must match `^[a-zA-Z0-9.\-_]+$` (OAS 3.1 §4.8.7.1). */
function componentBase(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function errorResponses(codes: string[]): Record<string, unknown> {
  return Object.fromEntries(codes.map((code) => [code, { $ref: ERROR_REF }]));
}

function jsonContent(schema: JsonSchema) {
  return { 'application/json': { schema } };
}

const timestamp: JsonSchema = { type: 'string', format: 'date-time' };
const nullableTimestamp: JsonSchema = { type: ['string', 'null'], format: 'date-time' };
const nullableString: JsonSchema = { type: ['string', 'null'] };

export function generateOpenApiDocument(input: GenerateOpenApiInput): OpenApiDocument {
  const { manifest, access, realm, siteId, schemaVersion } = input;
  const visible = manifest.collections.filter((collection) => access.has(collection.name));
  const byName = new Map(manifest.collections.map((collection) => [collection.name, collection]));

  // Disambiguate component bases that sanitize to the same string.
  const bases = new Map<string, string>();
  const taken = new Set<string>();
  for (const collection of visible) {
    const raw = componentBase(collection.name);
    let base = raw;
    for (let n = 2; taken.has(base); n += 1) base = `${raw}_${n}`;
    taken.add(base);
    bases.set(collection.name, base);
  }

  const primaryKeySchema = (name: string): JsonSchema => {
    const pkType = byName.get(name)?.primaryKeyType;
    return pkType === 'integer' || pkType === 'bigInteger' ? { type: 'integer' } : { type: 'string' };
  };
  // Only collections the caller can read get a `$ref`; anything else would
  // either dangle or document a collection they cannot see.
  const projectionRef = (name: string): string | null => {
    const base = bases.get(name);
    return base ? `#/components/schemas/${base}.Projection` : null;
  };

  const schemas: Record<string, JsonSchema> = {
    ErrorObject: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
      required: ['code'],
    },
    ErrorResponse: {
      type: 'object',
      properties: { errors: { type: 'array', items: { $ref: '#/components/schemas/ErrorObject' } } },
      required: ['errors'],
    },
    PaginationMeta: {
      type: 'object',
      properties: {
        total: { type: 'integer', minimum: 0, description: 'Omitted when the request passed `meta=none`.' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['limit', 'offset'],
    },
  };
  const paths: Record<string, Record<string, unknown>> = {};

  for (const collection of visible) {
    const collectionAccess = access.get(collection.name) as CollectionAccess;
    const base = bases.get(collection.name) as string;
    const ctx: FieldSchemaContext = {
      collection,
      readDecrypted: collectionAccess.readDecrypted,
      projectionRef,
      primaryKeySchema,
    };
    addCollectionSchemas(schemas, collection, collectionAccess, base, ctx);
    addCollectionPaths(paths, collection, collectionAccess, base, primaryKeySchema(collection.name));
  }

  paths['/deliver/page/{site_id}/{slug}'] = {
    get: {
      operationId: 'deliverPage',
      tags: ['delivery'],
      summary: 'Resolve a page and its section data in one round trip',
      description:
        'Public delivery surface (no credentials). Returns the page layout merged with the published ' +
        'data of each section; the body is the page payload itself rather than a `{ data }` envelope.',
      security: [],
      parameters: [
        { name: 'site_id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'locale', in: 'query', schema: { type: 'string' }, description: 'Locale variant.' },
        { name: 'lang', in: 'query', schema: { type: 'string' }, description: 'Alias of `locale`.' },
      ],
      responses: {
        '200': { description: 'Page payload.', content: jsonContent({ type: 'object' }) },
        '304': { description: 'Not modified (matching `If-None-Match`).' },
        '404': {
          description: 'Unknown site or page.',
          content: jsonContent({ type: 'object', properties: { error: { type: 'string' } } }),
        },
      },
    },
  };

  const publicRealm = realm === 'public';
  return {
    openapi: '3.1.0',
    info: {
      title: `LumiBase content API (${siteId})`,
      version: `schema-${schemaVersion}`,
      description:
        'Generated from the live site schema for the requesting caller: it lists only the collections, ' +
        'fields and operations that caller is permitted to use. Another role sees a different document.',
    },
    // Relative to this document (`/api/v1/openapi.json`), so no host is baked in.
    servers: [{ url: '/api/v1' }],
    security: publicRealm ? [{ siteHeader: [] }] : [{ bearerAuth: [], siteHeader: [] }],
    tags: [
      { name: 'items', description: 'Content items, per collection.' },
      { name: 'delivery', description: 'Public, cacheable delivery API.' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Session token or API key.' },
        siteHeader: { type: 'apiKey', in: 'header', name: 'X-Lumi-Site', description: 'Site id.' },
      },
      parameters: sharedParameters(),
      responses: {
        Error: { description: 'Error envelope.', content: jsonContent({ $ref: '#/components/schemas/ErrorResponse' }) },
      },
      schemas,
    },
    'x-lumibase': { site: siteId, realm, schemaVersion },
  };
}

function addCollectionSchemas(
  schemas: Record<string, JsonSchema>,
  collection: TypegenCollection,
  access: CollectionAccess,
  base: string,
  ctx: FieldSchemaContext,
): void {
  const readable = new Set(access.read);
  const userFields = collection.fields.filter((field) => !field.system && readable.has(field.name));

  const fieldProps: Record<string, JsonSchema> = {};
  const projectionProps: Record<string, JsonSchema> = {
    id: { ...ctx.primaryKeySchema(collection.name), readOnly: true },
    status: { type: 'string' },
    sort: { type: 'integer' },
    user_created: nullableString,
    user_updated: nullableString,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const required: string[] = [];
  for (const field of userFields) {
    const item = fieldSchema(field, ctx, 'item');
    const projection = fieldSchema(field, ctx, 'projection');
    if (item) {
      fieldProps[field.name] = item;
      if (field.required) required.push(field.name);
    }
    if (projection) projectionProps[field.name] = projection;
  }

  schemas[`${base}.Fields`] = {
    type: 'object',
    description: `User fields of \`${collection.name}\` readable by this caller.`,
    properties: fieldProps,
    ...(required.length > 0 ? { required } : {}),
  };
  schemas[`${base}.Item`] = {
    type: 'object',
    properties: {
      id: { ...ctx.primaryKeySchema(collection.name), readOnly: true },
      status: { type: 'string', description: '`draft`, `published`, `archived`, or a custom workflow value.' },
      sort: { type: 'integer' },
      data: { $ref: `#/components/schemas/${base}.Fields` },
      publishAt: nullableTimestamp,
      unpublishAt: nullableTimestamp,
      firstPublishedAt: { ...nullableTimestamp, readOnly: true, description: 'First publish; never moves (#687).' },
      publishedAt: { ...nullableTimestamp, readOnly: true, description: 'Most recent publish (#687).' },
      hasUnpublishedChanges: {
        type: 'boolean',
        readOnly: true,
        description: 'Data edited since the last publish (#687).',
      },
      userCreated: nullableString,
      userUpdated: nullableString,
      createdAt: { ...timestamp, readOnly: true },
      updatedAt: { ...timestamp, readOnly: true },
    },
    required: ['id', 'status', 'data'],
  };
  schemas[`${base}.Projection`] = {
    type: 'object',
    description: 'Flat shape returned when the request passes `fields=`; only requested keys are present.',
    properties: projectionProps,
  };

  const inputSchema = (allowed: string[], withRequired: boolean): JsonSchema => {
    const allowedSet = new Set(allowed);
    const props: Record<string, JsonSchema> = {};
    const req: string[] = [];
    for (const field of userFields) {
      if (!allowedSet.has(field.name) || field.readonly || field.generated) continue;
      const schema = fieldSchema(field, ctx, 'input');
      if (!schema) continue;
      props[field.name] = schema;
      if (withRequired && field.required) req.push(field.name);
    }
    const data: JsonSchema = { type: 'object', properties: props, ...(req.length > 0 ? { required: req } : {}) };
    return {
      type: 'object',
      properties: {
        data,
        status: { type: 'string' },
        sort: { type: 'integer' },
        publishAt: nullableTimestamp,
        unpublishAt: nullableTimestamp,
      },
      ...(withRequired ? { required: ['data'] } : {}),
    };
  };
  if (access.create) schemas[`${base}.CreateInput`] = inputSchema(access.create, true);
  if (access.update) schemas[`${base}.UpdateInput`] = inputSchema(access.update, false);
}

function addCollectionPaths(
  paths: Record<string, Record<string, unknown>>,
  collection: TypegenCollection,
  access: CollectionAccess,
  base: string,
  idSchema: JsonSchema,
): void {
  const name = collection.name;
  const opId = base.replace(/[.-]/g, '_');
  const itemOrProjection: JsonSchema = {
    anyOf: [{ $ref: `#/components/schemas/${base}.Item` }, { $ref: `#/components/schemas/${base}.Projection` }],
  };
  const single = (description: string, status = '200') => ({
    [status]: {
      description,
      content: jsonContent({ type: 'object', properties: { data: itemOrProjection }, required: ['data'] }),
    },
  });
  const idParam = { name: 'id', in: 'path', required: true, schema: idSchema };
  const ref = (param: string) => ({ $ref: `#/components/parameters/${param}` });

  const listPath: Record<string, unknown> = {
    get: {
      operationId: `list_${opId}`,
      tags: ['items'],
      summary: `List ${name}`,
      parameters: [
        ref('fields'),
        ref('filter'),
        ref('sort'),
        ref('limit'),
        ref('offset'),
        ref('status'),
        ref('meta'),
        ref('publicationState'),
        ref('modifiedSincePublish'),
      ],
      responses: {
        '200': {
          description: 'A page of items.',
          content: jsonContent({
            type: 'object',
            properties: {
              data: { type: 'array', items: itemOrProjection },
              meta: { $ref: '#/components/schemas/PaginationMeta' },
            },
            required: ['data'],
          }),
        },
        ...errorResponses(['400', '401', '403', '404']),
      },
    },
  };
  const detailPath: Record<string, unknown> = {
    parameters: [idParam],
    get: {
      operationId: `get_${opId}`,
      tags: ['items'],
      summary: `Get one ${name}`,
      parameters: [ref('fields'), ref('publicationState')],
      responses: { ...single('The item.'), ...errorResponses(['401', '403', '404']) },
    },
  };

  if (access.create) {
    listPath['post'] = {
      operationId: `create_${opId}`,
      tags: ['items'],
      summary: `Create ${name}`,
      requestBody: { required: true, content: jsonContent({ $ref: `#/components/schemas/${base}.CreateInput` }) },
      responses: { ...single('Created.', '201'), ...errorResponses(['400', '401', '403', '404', '409']) },
    };
  }
  if (access.update) {
    const body = { required: true, content: jsonContent({ $ref: `#/components/schemas/${base}.UpdateInput` }) };
    detailPath['patch'] = {
      operationId: `update_${opId}`,
      tags: ['items'],
      summary: `Update ${name}`,
      parameters: [ref('saveRevision')],
      requestBody: body,
      responses: { ...single('Updated.'), ...errorResponses(['400', '401', '403', '404', '409']) },
    };
  }
  if (access.delete) {
    detailPath['delete'] = {
      operationId: `delete_${opId}`,
      tags: ['items'],
      summary: `Delete ${name}`,
      responses: { '204': { description: 'Deleted.' }, ...errorResponses(['401', '403', '404', '409']) },
    };
  }

  const segment = encodeURIComponent(name);
  paths[`/items/${segment}`] = listPath;
  paths[`/items/${segment}/{id}`] = detailPath;
  if (access.create) {
    paths[`/items/${segment}/{id}/duplicate`] = {
      parameters: [idParam],
      post: {
        operationId: `duplicate_${opId}`,
        tags: ['items'],
        summary: `Duplicate one ${name} as a draft copy`,
        requestBody: {
          required: false,
          content: jsonContent({
            type: 'object',
            properties: {
              relations: { type: 'string', enum: ['none', 'reference', 'deep'], default: 'reference' },
              translations: { type: 'boolean', default: true },
              locale: { type: 'string' },
              overrides: { type: 'object', additionalProperties: true },
            },
          }),
        },
        responses: { ...single('The copy.', '201'), ...errorResponses(['400', '401', '403', '404', '409']) },
      },
    };
  }
}

function sharedParameters(): Record<string, unknown> {
  return {
    fields: {
      name: 'fields',
      in: 'query',
      schema: { type: 'string' },
      description: 'Comma-separated fields to return; `rel.*` expands a relation. Switches the shape to the projection.',
    },
    filter: {
      name: 'filter',
      in: 'query',
      schema: { type: 'string' },
      description: 'JSON filter (`{"title":{"_contains":"x"}}`) — or the `filter[field][_op]=value` form.',
    },
    sort: {
      name: 'sort',
      in: 'query',
      schema: { type: 'string' },
      description: 'Comma-separated fields; prefix `-` for descending.',
    },
    limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } },
    offset: { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
    status: { name: 'status', in: 'query', schema: { type: 'string' }, description: 'Only items with this status.' },
    meta: {
      name: 'meta',
      in: 'query',
      schema: { type: 'string', enum: ['total_count', 'none'], default: 'total_count' },
      description: '`none` skips the `count(*)` and omits `meta.total`.',
    },
    publicationState: {
      name: 'publicationState',
      in: 'query',
      schema: { type: 'string', enum: ['live', 'preview', 'all'] },
      description:
        'Publication cohort (#688): `live` = published inside its window, `preview` = draft + published, `all` = no filter. Anonymous callers always get `live`.',
    },
    modifiedSincePublish: {
      name: 'modifiedSincePublish',
      in: 'query',
      schema: { type: 'string', enum: ['true', 'false'] },
      description: 'Only items edited since their last publish (#687).',
    },
    saveRevision: {
      name: 'saveRevision',
      in: 'query',
      schema: { type: 'string', enum: ['true', 'false'], default: 'true' },
      description: '`false` skips the revision row (autosave, machine writes). Agent writes always keep theirs (#693).',
    },
  };
}
