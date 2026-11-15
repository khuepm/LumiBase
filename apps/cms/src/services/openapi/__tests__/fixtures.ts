import type { PermissionBundle, CompiledPermission, PermissionAction } from '../../permission-service';
import type { TypegenCollection, TypegenField, TypegenManifest } from '../../typegen-service';
import { Validator } from '@seriousme/openapi-schema-validator';

const SYSTEM_FIELDS: TypegenField[] = [
  'id',
  'status',
  'sort',
  'user_created',
  'user_updated',
  'created_at',
  'updated_at',
  'deleted_at',
].map((name) => ({
  name,
  type: name === 'sort' ? 'integer' : 'string',
  required: name === 'id' || name === 'status',
  nullable: !(name === 'id' || name === 'status'),
  readonly: name === 'id',
  generated: name === 'id',
  system: true,
  encrypted: false,
  primaryKey: name === 'id',
}));

export function field(name: string, type: string, extra: Partial<TypegenField> = {}): TypegenField {
  return {
    name,
    type,
    required: false,
    nullable: true,
    readonly: false,
    generated: false,
    system: false,
    encrypted: false,
    primaryKey: false,
    ...extra,
  };
}

export function collection(
  name: string,
  fields: TypegenField[],
  extra: Partial<TypegenCollection> = {},
): TypegenCollection {
  return {
    name,
    primaryKey: 'id',
    primaryKeyField: 'id',
    primaryKeyType: 'nanoid',
    fields: [...SYSTEM_FIELDS, ...fields],
    relations: [],
    ...extra,
  };
}

/**
 * Field-type matrix: every scalar `FieldType`, an enum, a localized
 * (`translatable-text`) field, single + multi file fields, JSON, an encrypted
 * field, a readonly field, an m2o relation and an o2m alias.
 */
export function matrixManifest(): TypegenManifest {
  const posts = collection(
    'posts',
    [
      field('title', 'string', { required: true, nullable: false }),
      field('body', 'text'),
      field('views', 'integer'),
      field('big', 'bigInteger'),
      field('price', 'decimal'),
      field('featured', 'boolean'),
      field('meta', 'json'),
      field('ref_uuid', 'uuid'),
      field('day', 'date'),
      field('published_on', 'datetime'),
      field('at', 'time'),
      field('stamp', 'timestamp'),
      field('tags', 'csv'),
      field('pin', 'hash'),
      field('location', 'geometry'),
      field('kind', 'string', { enum: ['news', 'blog'] }),
      field('headline', 'json', { interface: 'translatable-text' }),
      field('cover', 'uuid', { interface: 'file' }),
      field('gallery', 'alias', { interface: 'files' }),
      field('secret_note', 'string', { encrypted: true }),
      field('slug', 'string', { readonly: true }),
      field('author', 'string', { kind: 'm2o', target: 'authors', branded: 'AuthorsId' }),
      field('comments', 'alias', { interface: 'relation-o2m' }),
      field('divider', 'alias', { interface: 'presentation-divider' }),
    ],
    {
      relations: [
        {
          field: 'author',
          kind: 'm2o',
          target: 'authors',
          manyCollection: 'posts',
          manyField: 'author',
          oneCollection: 'authors',
          oneField: null,
          junctionCollection: null,
        },
        {
          field: 'comments',
          kind: 'o2m',
          target: 'comments',
          manyCollection: 'comments',
          manyField: 'post',
          oneCollection: 'posts',
          oneField: 'comments',
          junctionCollection: null,
        },
      ],
    },
  );
  const authors = collection('authors', [field('name', 'string', { required: true, nullable: false }), field('email', 'string')]);
  const comments = collection(
    'comments',
    [field('text', 'text'), field('post', 'string', { kind: 'm2o', target: 'posts' })],
    { primaryKeyType: 'integer' },
  );
  const payroll = collection('payroll', [field('salary', 'decimal')]);
  return { version: 2, site: 'site-a', collections: [posts, authors, comments, payroll] };
}

export function perm(collectionName: string, action: PermissionAction, fields: string[] = ['*']): CompiledPermission {
  return { collection: collectionName, action, rule: null, fields, presets: {}, validation: {}, sources: [] };
}

export function bundleOf(perms: CompiledPermission[], admin = false): PermissionBundle {
  return {
    admin,
    appAccess: true,
    tfaRequired: false,
    byKey: Object.fromEntries(perms.map((p) => [`${p.collection}::${p.action}`, p])),
    roles: [],
    policies: [],
  };
}

export const ADMIN_BUNDLE = bundleOf([], true);

/** Validate against the official OpenAPI 3.1 JSON Schema (incl. `$ref` resolution). */
export async function validateOpenApi(document: unknown): Promise<{ valid: boolean; errors: unknown }> {
  const validator = new Validator();
  // The validator mutates/annotates its input; hand it a copy.
  const res = await validator.validate(JSON.parse(JSON.stringify(document)) as Record<string, unknown>);
  return { valid: res.valid, errors: res.errors };
}

/** Every key that appears under any `properties` object in the document. */
export function propertyKeys(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) propertyKeys(child, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value && typeof value === 'object') {
        for (const name of Object.keys(value)) out.add(name);
      }
      propertyKeys(value, out);
    }
  }
  return out;
}
