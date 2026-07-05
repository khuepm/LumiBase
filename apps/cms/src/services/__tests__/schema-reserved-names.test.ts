import { describe, expect, it, vi } from 'vitest';
import { SchemaService, SchemaServiceError } from '../schema-service';

/**
 * Reserved collection-name enforcement. The physical namespaces owned by the
 * platform — `lumibase_` (every system table, ADR-010) and `mat_`
 * (materialized collection tables) — may not be claimed by user- or
 * AI-created collections, whether via create or rename. The guard lives in
 * `ensureName`, which runs before any DB access, so a throwing fake db
 * proves rejection happens at validation time.
 */

function makeThrowingDbService() {
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
  it.each(['lumibase_posts', 'lumibase_users', 'lumibase_secret', 'mat_products'])(
    'rejects "%s" with RESERVED_NAME before touching the database',
    async (name) => {
      const service = makeThrowingDbService();
      await expect(service.createCollection({ name } as never)).rejects.toMatchObject({
        name: 'SchemaServiceError',
        code: 'RESERVED_NAME',
        status: 422,
      });
    },
  );

  it('rejects the prefix even when it is the whole name', async () => {
    const service = makeThrowingDbService();
    await expect(service.createCollection({ name: 'lumibase_' } as never)).rejects.toBeInstanceOf(
      SchemaServiceError,
    );
  });

  it('rejects renaming a collection into the reserved prefix', async () => {
    const service = makeThrowingDbService();
    await expect(
      service.updateCollection('blog_posts', { name: 'lumibase_hijack' } as never),
    ).rejects.toMatchObject({ code: 'RESERVED_NAME' });
  });

  it('allows ordinary collection names end-to-end', async () => {
    const db = {
      insert: () => ({
        values: () => ({
          returning: async () => [{ id: 'collection-1', name: 'blog_posts' }],
        }),
      }),
    };
    const service = new SchemaService({ db: db as never, siteId: 'site-1' });
    // getCollection returning null means "does not exist yet".
    vi.spyOn(service, 'getCollection').mockResolvedValue(null as never);
    vi.spyOn(service as never, 'invalidate').mockResolvedValue(undefined as never);

    const row = await service.createCollection({ name: 'blog_posts' } as never);
    expect(row).toMatchObject({ name: 'blog_posts' });
  });

  it('still accepts names that merely contain a reserved string (prefix-scoped, not substring)', async () => {
    const service = makeThrowingDbService();
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
