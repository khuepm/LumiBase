import { describe, expect, it, vi } from 'vitest';
import {
  SchemaService,
  SchemaServiceError,
  assertFieldMutationAllowed,
  assessFieldMutationRisk,
} from '../schema-service';

const existing = { name: 'title', type: 'string' };

describe('SchemaService field migration risk', () => {
  it('does not flag presentation-only edits on populated fields', () => {
    expect(
      assessFieldMutationRisk(existing, { name: 'title', type: 'string' }, 12),
    ).toEqual({
      risky: false,
      changes: [],
      requiresMigrationPlan: false,
    });
  });

  it('rejects type changes on populated fields without a migration plan', () => {
    expect(() =>
      assertFieldMutationAllowed(existing, { name: 'title', type: 'text' }, 4),
    ).toThrowError(SchemaServiceError);

    try {
      assertFieldMutationAllowed(existing, { name: 'title', type: 'text' }, 4);
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaServiceError);
      expect((err as SchemaServiceError).code).toBe('FIELD_MIGRATION_REQUIRED');
      expect((err as SchemaServiceError).status).toBe(409);
    }
  });

  it('rejects renames on populated fields without explicit confirmation', () => {
    expect(() =>
      assertFieldMutationAllowed(existing, { name: 'headline', type: 'string' }, 2),
    ).toThrowError(/requires a migration plan/);
  });

  it('allows risky changes when a migration plan or confirmation is supplied', () => {
    expect(() =>
      assertFieldMutationAllowed(existing, { name: 'headline', type: 'text' }, 2, {
        migrationPlan: { strategy: 'copy-json-key' },
      }),
    ).not.toThrow();
    expect(() =>
      assertFieldMutationAllowed(existing, { name: 'headline', type: 'text' }, 2, {
        confirmRiskyChange: true,
      }),
    ).not.toThrow();
  });
});

describe('SchemaService field deletion risk', () => {
  const collection = {
    id: 'collection-posts',
    siteId: 'site-1',
    name: 'posts',
  };

  function createDeleteDb(deleted: string[]) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      delete: () => ({
        where: () => ({
          returning: async () => {
            deleted.push('field-title');
            return [{ id: 'field-title' }];
          },
        }),
      }),
    };
  }

  it('requires force when deleting a populated field', async () => {
    const deleted: string[] = [];
    const service = new SchemaService({
      db: createDeleteDb(deleted) as never,
      siteId: 'site-1',
    });
    vi.spyOn(service, 'getCollection').mockResolvedValue(collection as never);
    vi.spyOn(service as never, 'countFieldDataRows').mockResolvedValue(3);

    await expect(service.deleteField('posts', 'title')).rejects.toMatchObject({
      code: 'FIELD_DELETE_REQUIRES_FORCE',
      status: 409,
    });
    expect(deleted).toEqual([]);
  });

  it('deletes a populated field when force is explicit', async () => {
    const deleted: string[] = [];
    const deletedCacheKeys: string[] = [];
    const backups: Array<{ collectionId: string; fieldName: string }> = [];
    const service = new SchemaService({
      db: createDeleteDb(deleted) as never,
      siteId: 'site-1',
      cache: {
        get: vi.fn(),
        set: vi.fn(),
        delete: async (key: string) => {
          deletedCacheKeys.push(key);
        },
      },
    });
    vi.spyOn(service, 'getCollection').mockResolvedValue(collection as never);
    vi.spyOn(service as never, 'countFieldDataRows').mockResolvedValue(3);
    vi.spyOn(service as never, 'backupFieldDataToRevisions').mockImplementation(async (collectionId: unknown, fieldName: unknown) => {
      backups.push({ collectionId: collectionId as string, fieldName: fieldName as string });
    });

    await expect(service.deleteField('posts', 'title', { force: true, backupToRevisions: true })).resolves.toEqual({ ok: true });
    expect(deleted).toEqual(['field-title']);
    expect(backups).toEqual([{ collectionId: 'collection-posts', fieldName: 'title' }]);
    expect(deletedCacheKeys).toContain('schema:site-1:posts');
  });

  it('requires a revision backup when force-deleting a populated field', async () => {
    const deleted: string[] = [];
    const service = new SchemaService({
      db: createDeleteDb(deleted) as never,
      siteId: 'site-1',
    });
    vi.spyOn(service, 'getCollection').mockResolvedValue(collection as never);
    vi.spyOn(service as never, 'countFieldDataRows').mockResolvedValue(3);
    const backup = vi.spyOn(service as never, 'backupFieldDataToRevisions');

    await expect(service.deleteField('posts', 'title', { force: true })).rejects.toMatchObject({
      code: 'FIELD_DELETE_REQUIRES_BACKUP',
      status: 409,
    });
    expect(backup).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });
});
