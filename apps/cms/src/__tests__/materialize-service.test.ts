import { describe, expect, it } from 'vitest';

import type { MaterializeConfig } from '../services/materialize-service';
import {
  createPhysicalTable,
  queryPhysicalTable,
} from '../services/materialize-service';

function sqlToString(statement: unknown): string {
  const chunks =
    (statement as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (chunk && typeof chunk === 'object' && 'queryChunks' in chunk) {
        // Nested sql`` fragment — recurse into its text.
        return sqlToString(chunk);
      }
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join('') : '';
    })
    .join('');
}

/**
 * Collect the interpolated values from a drizzle `sql` statement. Drizzle keeps
 * embedded JS values as bare primitive chunks in `queryChunks` (StringChunk
 * holds the static SQL text as a string[]; Name holds identifiers) and turns
 * them into real bind parameters at driver render time. So a value passed as
 * `${x}` shows up here as a bare primitive — never inside the SQL text (this is
 * exactly the SQL-injection guarantee we assert).
 */
function sqlParams(statement: unknown): unknown[] {
  const chunks =
    (statement as { queryChunks?: unknown[] }).queryChunks ?? [];
  const out: unknown[] = [];
  for (const chunk of chunks) {
    if (
      typeof chunk === 'string' ||
      typeof chunk === 'number' ||
      typeof chunk === 'boolean'
    ) {
      out.push(chunk);
    } else if (chunk && typeof chunk === 'object' && 'queryChunks' in chunk) {
      // Nested sql`` fragment (e.g. the conditional status filter) — recurse so
      // its bound values are counted too.
      out.push(...sqlParams(chunk));
    }
  }
  return out;
}

/** Collect the identifier names (sql.identifier → `Name` chunks) in a statement. */
function sqlIdentifiers(statement: unknown): string[] {
  const chunks =
    (statement as { queryChunks?: Array<Record<string, unknown>> }).queryChunks ??
    [];
  return chunks
    .filter(
      (chunk) =>
        chunk != null &&
        typeof chunk === 'object' &&
        chunk.constructor?.name === 'Name' &&
        typeof (chunk as { value?: unknown }).value === 'string',
    )
    .map((chunk) => (chunk as { value: string }).value);
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
    const identifiers: string[] = [];
    const db = {
      execute(statement: unknown) {
        identifiers.push(...sqlIdentifiers(statement));
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

    // Table names are emitted as safe quoted identifiers via sql.identifier().
    expect(identifiers).toContain('mat_mcalpha123');
    expect(identifiers).toContain('mat_mcbeta123');
    expect(identifiers).not.toContain('mat_shared');
  });

  it('filters physical table reads and counts by caller site id (via bind params)', async () => {
    const rendered: Array<{ text: string; params: unknown[]; identifiers: string[] }> = [];
    const db = {
      execute(statement: unknown) {
        rendered.push({
          text: sqlToString(statement),
          params: sqlParams(statement),
          identifiers: sqlIdentifiers(statement),
        });
        return Promise.resolve(rendered.length === 1 ? [] : [{ cnt: '0' }]);
      },
    };

    // Deliberately pass values containing single quotes: they must NOT appear in
    // the SQL text (no interpolation/escaping) — they must be bound parameters.
    await queryPhysicalTable(db as never, 'mcAlpha123', "site-a'quoted", {
      status: "published'quoted",
    });

    for (const stmt of rendered) {
      expect(stmt.identifiers).toContain('mat_mcalpha123');
      // The raw values must never be interpolated into the SQL string.
      expect(stmt.text).not.toContain("site-a'quoted");
      expect(stmt.text).not.toContain("published'quoted");
      // They must be present as bound parameters instead.
      expect(stmt.params).toContain("site-a'quoted");
      expect(stmt.params).toContain("published'quoted");
    }
  });
});
