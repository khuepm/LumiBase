import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import { ItemService, ItemServiceError } from '../item-service';
import { ALL } from './blocks-fixtures';

/**
 * Dynamic zones (#748): ItemService resolves the block templates through the
 * (site-scoped) SchemaService before validating, so every write path that
 * goes through `runValidation` checks blocks per template.
 */
const getCompiled = vi.fn(async (name: string) => ALL.find((c) => c.name === name) ?? null);

vi.mock('../schema-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../schema-service')>();
  return {
    ...actual,
    SchemaService: vi.fn().mockImplementation(function () {
      return { getCompiled };
    }),
  };
});

type WithRunValidation = {
  runValidation(collection: string, data: Record<string, unknown>, partial: boolean): Promise<Record<string, unknown>>;
};

function service(): WithRunValidation {
  return new ItemService({ db: {} as Database, siteId: 'site-1' }) as unknown as WithRunValidation;
}

describe('ItemService + blocks', () => {
  it('normalises null zones and returns canonical blocks', async () => {
    getCompiled.mockClear();
    const out = await service().runValidation('pages', { title: 't', sections: null }, false);
    expect(out).toEqual({ title: 't', sections: [] });
    // pages + its three reachable templates
    expect(getCompiled.mock.calls.map((c) => c[0]).sort()).toEqual(['columns', 'cta', 'hero', 'pages']);
  });

  it('rejects an invalid nested block with a 400 VALIDATION error naming the path', async () => {
    const err = await service()
      .runValidation(
        'pages',
        { sections: [{ id: 'c', type: 'columns', data: { items: [{ id: 'h', type: 'hero', data: {} }] } }] },
        false,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ItemServiceError);
    expect((err as ItemServiceError).code).toBe('VALIDATION');
    expect((err as ItemServiceError).status).toBe(400);
    expect((err as ItemServiceError).message).toContain('sections.0.data.items.0.data.title');
  });

  it('does not resolve templates for collections without blocks fields', async () => {
    getCompiled.mockClear();
    await service().runValidation('hero', { title: 'x' }, false);
    expect(getCompiled).toHaveBeenCalledTimes(1);
  });
});
