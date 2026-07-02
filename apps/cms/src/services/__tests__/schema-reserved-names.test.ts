import { describe, expect, it, vi } from 'vitest';
import { SchemaService, SchemaServiceError } from '../schema-service';

/**
 * Collection names must not enter the physical namespaces reserved by the
 * platform: `lumibase_` (system tables, ADR-010) and `mat_` (materialized
 * collection tables). The guard runs before any DB access, so a throwing
 * fake db proves rejection happens at validation time.
 */

function makeService() {
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error('db must not be touched for a reserved name');
      },
    },
  );
  return new SchemaService({ db: db as never, siteId: 'site-1' });
}

describe('SchemaService reserved collection-name prefixes', () => {
  it.each(['lumibase_posts', 'lumibase_users', 'mat_products'])(
    'rejects "%s" with RESERVED_NAME before touching the database',
    async (name) => {
      const service = makeService();
      await expect(service.createCollection({ name } as never)).rejects.toMatchObject({
        name: 'SchemaServiceError',
        code: 'RESERVED_NAME',
        status: 422,
      });
    },
  );

  it('still accepts ordinary names (guard is prefix-scoped, not substring)', async () => {
    const service = makeService();
    // `materials` starts with "mat" but not "mat_"; `my_lumibase_notes`
    // contains but does not start with the reserved prefix.
    for (const name of ['materials', 'my_lumibase_notes', 'posts']) {
      const getCollection = vi
        .spyOn(service, 'getCollection')
        .mockRejectedValue(new SchemaServiceError('STOP', 'reached db lookup', 599));
      // Passing the name check means it proceeds to the duplicate-lookup step.
      await expect(service.createCollection({ name } as never)).rejects.toMatchObject({
        code: 'STOP',
      });
      getCollection.mockRestore();
    }
  });
});
