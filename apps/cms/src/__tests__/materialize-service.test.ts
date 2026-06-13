import { describe, expect, it } from 'vitest';

import type { MaterializeConfig } from '../services/materialize-service';
import {
  createPhysicalTable,
  queryPhysicalTable,
} from '../services/materialize-service';

function sqlToString(statement: unknown): string {
  const chunks =
    (statement as { queryChunks?: Array<{ value?: string[] }> }).queryChunks ??
    [];
  return chunks.flatMap((chunk) => chunk.value ?? []).join('');
}

function makeConfig(overrides: Partial<MaterializeConfig>): MaterializeConfig {
  return {
    id: 'mc-default',
    siteId: 'site-default',
    collection: 'posts',
    target: 'shared',
    refreshStrategy: 'manual',
    projection: { fields: ['*'] },
    filter: {},
    ...overrides,
  };
}

describe('materialize service tenant isolation', () => {
  it('creates physical tables from materialization ids instead of shared targets', async () => {
    const statements: string[] = [];
    const db = {
      execute(statement: unknown) {
        statements.push(sqlToString(statement));
        return Promise.resolve([]);
      },
    };

    await createPhysicalTable(
      db as never,
      makeConfig({ id: 'mcAlpha123', siteId: 'site-a' }),
    );
    await createPhysicalTable(
      db as never,
      makeConfig({ id: 'mcBeta123', siteId: 'site-b' }),
    );

    expect(
      statements.some((statement) =>
        statement.includes('CREATE TABLE IF NOT EXISTS mat_mcalpha123'),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes('CREATE TABLE IF NOT EXISTS mat_mcbeta123'),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes('CREATE TABLE IF NOT EXISTS mat_shared'),
      ),
    ).toBe(false);
  });

  it('filters physical table reads and counts by caller site id', async () => {
    const statements: string[] = [];
    const db = {
      execute(statement: unknown) {
        statements.push(sqlToString(statement));
        return Promise.resolve(statements.length === 1 ? [] : [{ cnt: '0' }]);
      },
    };

    await queryPhysicalTable(db as never, 'mcAlpha123', "site-a'quoted", {
      status: "published'quoted",
    });

    expect(statements[0]).toContain('FROM mat_mcalpha123');
    expect(statements[0]).toContain(
      "WHERE site_id = 'site-a''quoted' AND status = 'published''quoted'",
    );
    expect(statements[1]).toContain('FROM mat_mcalpha123');
    expect(statements[1]).toContain(
      "WHERE site_id = 'site-a''quoted' AND status = 'published''quoted'",
    );
  });
});
