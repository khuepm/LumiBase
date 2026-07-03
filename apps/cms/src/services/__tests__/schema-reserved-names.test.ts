import { describe, expect, it, vi } from 'vitest';
import { SchemaService, SchemaServiceError } from '../schema-service';

/**
 * Reserved collection-name enforcement. The `lumibase_` prefix is owned by the
 * platform (CDC/Firebase sync tables, internal config), so neither the builder
 * (routes → service) nor the AI harness (skill handler → service) may create or
 * rename a collection into it. The guard lives in `ensureName`, which runs
 * before any DB access — so these tests need no real database.
 */
const makeService = () =>
  new SchemaService({
    db: {} as never,
    siteId: 'site-1',
  });

describe('SchemaService reserved collection names', () => {
  it('rejects createCollection with the lumibase_ prefix', async () => {
    const service = makeService();

    await expect(service.createCollection({ name: 'lumibase_secret' } as never)).rejects.toMatchObject({
      code: 'RESERVED_NAME',
      status: 422,
    });
  });

  it('rejects the prefix even when it is the whole name', async () => {
    const service = makeService();

    await expect(service.createCollection({ name: 'lumibase_' } as never)).rejects.toBeInstanceOf(
      SchemaServiceError,
    );
  });

  it('allows ordinary collection names', async () => {
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
    vi.spyOn(service as never, 'invalidate').mockResolvedValue(undefined);

    const row = await service.createCollection({ name: 'blog_posts' } as never);
    expect(row).toMatchObject({ name: 'blog_posts' });
  });

  it('rejects renaming a collection into the reserved prefix', async () => {
    const service = makeService();

    await expect(
      service.updateCollection('blog_posts', { name: 'lumibase_hijack' } as never),
    ).rejects.toMatchObject({ code: 'RESERVED_NAME' });
  });
});
