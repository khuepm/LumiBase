import { describe, expect, it } from 'vitest';
import { collections as collectionsTable, fields } from '@lumibase/database';
import { TypegenService } from '../typegen-service';

/** Dynamic zones (#748): the typegen manifest carries a blocks field's allowed templates. */

function queryResult(rows: unknown[]) {
  return {
    orderBy: async () => rows,
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
}

function collectionRow(id: string, name: string) {
  return {
    id,
    siteId: 'site_1',
    name,
    primaryKeyField: 'id',
    primaryKeyType: 'nanoid',
    storageMode: 'jsonb',
    meta: {},
    sortField: null,
    archiveField: null,
  };
}

function fieldRow(name: string, type: string, options: Record<string, unknown> = {}) {
  return {
    id: `f_${name}`,
    siteId: 'site_1',
    collectionId: 'col_pages',
    name,
    type,
    interface: type === 'blocks' ? 'blocks' : 'input',
    nullable: true,
    required: false,
    readonly: false,
    encrypted: false,
    options,
    validation: { rules: [] },
    sortOrder: 0,
  };
}

describe('TypegenService + blocks', () => {
  it('emits allowedBlocks for blocks fields only (malformed entries dropped)', async () => {
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === collectionsTable) return queryResult([collectionRow('col_pages', 'pages')]);
            if (table === fields) {
              return queryResult([
                fieldRow('title', 'string'),
                fieldRow('sections', 'blocks', { allowedBlocks: ['hero', 'cta', 'Bad Name', 'hero'] }),
              ]);
            }
            return queryResult([]);
          },
        }),
      }),
    };
    const manifest = await new TypegenService({ db: db as never, siteId: 'site_1' }).getManifest();
    const pages = manifest.collections[0]!;
    expect(pages.fields.find((f) => f.name === 'sections')).toMatchObject({ type: 'blocks', allowedBlocks: ['hero', 'cta'] });
    expect(pages.fields.find((f) => f.name === 'title')).not.toHaveProperty('allowedBlocks');
  });
});
