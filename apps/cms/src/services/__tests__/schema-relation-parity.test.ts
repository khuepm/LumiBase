import { describe, expect, it, vi } from 'vitest';
import {
  SchemaService,
  SchemaServiceError,
  assertPrimaryKeyStorageCompatible,
  assertRelationNotDuplicate,
  assertRelationOnDeleteCompatible,
  assertRelationTypeSupported,
  isSystemFieldName,
  normalizeRelationInput,
} from '../schema-service';

describe('SchemaService relation parity helpers', () => {
  it('infers relation type from junction metadata when omitted', () => {
    expect(
      normalizeRelationInput({
        manyCollection: 'posts',
        manyField: 'author_id',
        oneCollection: 'authors',
      }).type,
    ).toBe('m2o');

    expect(
      normalizeRelationInput({
        manyCollection: 'posts',
        manyField: 'id',
        oneCollection: 'tags',
        junctionCollection: 'post_tags',
        junctionManyField: 'post_id',
        junctionOneField: 'tag_id',
      }).type,
    ).toBe('m2m');
  });

  it('rejects destructive onDelete actions for external storage relations', () => {
    expect(() => assertRelationOnDeleteCompatible('restrict', 'external')).not.toThrow();
    expect(() => assertRelationOnDeleteCompatible('no action', 'external')).not.toThrow();
    expect(() => assertRelationOnDeleteCompatible('cascade', 'external')).toThrowError(SchemaServiceError);
    expect(() => assertRelationOnDeleteCompatible('set null', 'external')).toThrowError(
      /not supported/,
    );
  });

  it('reserves m2a relation support with an explicit not implemented error', () => {
    expect(() => assertRelationTypeSupported('m2o')).not.toThrow();
    try {
      assertRelationTypeSupported('m2a');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaServiceError);
      expect((err as SchemaServiceError).code).toBe('RELATION_TYPE_NOT_IMPLEMENTED');
      expect((err as SchemaServiceError).status).toBe(501);
    }
  });

  it('rejects duplicate relation identities with 409', () => {
    try {
      assertRelationNotDuplicate({ manyCollection: 'posts', manyField: 'author_id' }, 1);
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaServiceError);
      expect((err as SchemaServiceError).code).toBe('RELATION_EXISTS');
      expect((err as SchemaServiceError).status).toBe(409);
    }
  });

  it('treats item structural columns as valid relation fields', () => {
    expect(isSystemFieldName('id')).toBe(true);
    expect(isSystemFieldName('created_at')).toBe(true);
    expect(isSystemFieldName('title')).toBe(false);
  });

  it('rejects JSONB integer primary key strategies with a 400', () => {
    expect(() => assertPrimaryKeyStorageCompatible('nanoid', 'jsonb')).not.toThrow();
    expect(() => assertPrimaryKeyStorageCompatible('integer', 'materialized')).not.toThrow();

    try {
      assertPrimaryKeyStorageCompatible('integer', 'jsonb');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaServiceError);
      expect((err as SchemaServiceError).code).toBe('PRIMARY_KEY_STRATEGY_UNSUPPORTED');
      expect((err as SchemaServiceError).status).toBe(400);
    }
  });

  it('validates relation field references before create', async () => {
    const service = new SchemaService({
      db: {
        insert: () => {
          throw new Error('insert should not run for invalid relation input');
        },
      } as never,
      siteId: 'site-1',
    });
    vi.spyOn(service, 'getCollection').mockImplementation(async (name: string) => ({
      id: `collection-${name}`,
      name,
      primaryKeyField: 'id',
      storageMode: 'jsonb',
    }) as never);
    vi.spyOn(service as never, 'fieldExists').mockResolvedValue(false);

    await expect(
      service.createRelation({
        manyCollection: 'posts',
        manyField: 'missing_author_id',
        oneCollection: 'authors',
        type: 'm2o',
      }),
    ).rejects.toMatchObject({
      code: 'RELATION_FIELD_NOT_FOUND',
      status: 404,
    });
  });
});
