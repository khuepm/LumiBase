import type { TypegenField, TypegenManifest } from '../types';

const system = (name: string, type: string, extra: Partial<TypegenField> = {}): TypegenField => ({
  name,
  type,
  required: true,
  nullable: false,
  readonly: true,
  generated: true,
  system: true,
  encrypted: false,
  ...extra,
});

const user = (name: string, type: string, extra: Partial<TypegenField> = {}): TypegenField => ({
  name,
  type,
  required: false,
  nullable: true,
  readonly: false,
  generated: false,
  system: false,
  encrypted: false,
  ...extra,
});

/**
 * Golden fixture: scalars of every storage type, an enum, m2o / o2m / m2m
 * relations, single + multi file fields, a localized (translatable) field,
 * JSON, an encrypted field and an integer-keyed collection.
 */
export const FIXTURE_MANIFEST: TypegenManifest = {
  version: 2,
  site: 'site_fixture',
  collections: [
    {
      name: 'authors',
      primaryKey: 'id',
      primaryKeyField: 'id',
      primaryKeyType: 'uuid',
      fields: [
        system('id', 'uuid', { primaryKey: true, branded: 'AuthorsId' }),
        system('created_at', 'datetime'),
        user('name', 'string', { required: true, nullable: false }),
        user('email', 'string', { encrypted: true }),
      ],
      relations: [
        {
          field: 'posts',
          kind: 'o2m',
          target: 'blog_posts',
          manyCollection: 'blog_posts',
          manyField: 'author_id',
          oneCollection: 'authors',
          oneField: 'posts',
          junctionCollection: null,
          relationType: 'o2m',
          alias: 'posts',
        },
      ],
    },
    {
      name: 'blog_posts',
      primaryKey: 'id',
      primaryKeyField: 'id',
      primaryKeyType: 'nanoid',
      fields: [
        system('id', 'string', { primaryKey: true, branded: 'Blog_postsId' }),
        system('status', 'string', { readonly: false, generated: false }),
        system('updated_at', 'datetime'),
        user('title', 'string', { required: true, nullable: false }),
        user('body', 'text'),
        user('views', 'integer', { required: true, nullable: false }),
        user('rating', 'float'),
        user('price', 'decimal'),
        user('big_count', 'bigInteger'),
        user('featured', 'boolean', { required: true, nullable: false }),
        user('published_on', 'date'),
        user('published_at', 'dateTime'),
        user('kind', 'string', { required: true, nullable: false, enum: ['news', 'guide', 'review'] }),
        user('metadata', 'json'),
        user('location', 'geometry'),
        user('cover', 'uuid', { interface: 'file' }),
        user('gallery', 'json', { interface: 'files' }),
        user('headline', 'json', { interface: 'translatable-text', required: true, nullable: false }),
        user('author_id', 'uuid', { kind: 'm2o', target: 'authors', branded: 'AuthorsId' }),
        user('tags', 'alias', { kind: 'm2m', target: 'tags', interface: 'list-m2m' }),
      ],
      relations: [
        {
          field: 'author_id',
          kind: 'm2o',
          target: 'authors',
          manyCollection: 'blog_posts',
          manyField: 'author_id',
          oneCollection: 'authors',
          oneField: 'posts',
          junctionCollection: null,
          relationType: 'm2o',
          alias: 'author',
        },
        {
          field: 'tags',
          kind: 'm2m',
          target: 'tags',
          manyCollection: 'blog_posts',
          manyField: 'tags',
          oneCollection: 'tags',
          oneField: null,
          junctionCollection: 'blog_posts_tags',
          relationType: 'm2m',
          alias: 'tags',
        },
      ],
    },
    {
      name: 'tags',
      primaryKey: 'id',
      primaryKeyField: 'id',
      primaryKeyType: 'integer',
      fields: [
        system('id', 'integer', { primaryKey: true }),
        user('label', 'string', { required: true, nullable: false }),
      ],
      relations: [],
    },
  ],
};
