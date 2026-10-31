import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createSiteScopedSql } from '@lumibase/runtime';

/**
 * Property (B130, design §7): whatever the site id contains — quotes,
 * `x' OR '1'='1`, `';--`, unicode — it only ever travels as a bound value of
 * the scope statement, never in the SQL text, on both the per-statement and
 * the `begin` paths.
 */
function recordingSql() {
  const texts: string[] = [];
  const values: unknown[][] = [];
  const lazy = (text: string, vals: unknown[]) => {
    const q = {
      values: () => q,
      then: (a?: (v: unknown) => unknown, b?: (e: unknown) => unknown) => {
        texts.push(text);
        values.push(vals);
        return Promise.resolve([]).then(a, b);
      },
    };
    return q;
  };
  const tx = Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => lazy(strings.join('$?'), vals),
    { unsafe: (text: string, vals: unknown[] = []) => lazy(text, vals) },
  );
  const base = Object.assign(() => undefined, {
    begin: async (a: unknown, b?: unknown) => {
      const cb = (typeof a === 'function' ? a : b) as (t: unknown) => unknown;
      return cb(tx);
    },
  });
  return { base, texts, values };
}

describe('createSiteScopedSql — site id is always a parameter', () => {
  const siteIds = fc.oneof(
    fc.string({ minLength: 1 }),
    fc.constantFrom("x' OR '1'='1", "';--", "a'); DROP TABLE lumibase_items; --", 'site_ünï©ødé', '"quoted"', '$1'),
  );

  it('unsafe path', async () => {
    await fc.assert(
      fc.asyncProperty(siteIds, async (siteId) => {
        const { base, texts, values } = recordingSql();
        const sql = createSiteScopedSql(base as unknown as Parameters<typeof createSiteScopedSql>[0], siteId);
        await sql.unsafe('select 1', []);
        // The SQL text is fixed; the site id appears only among the values.
        expect(texts).toEqual(["SELECT set_config('app.site_id', $?, true)", 'select 1']);
        expect(values).toEqual([[siteId], []]);
      }),
    );
  });

  it('begin path', async () => {
    await fc.assert(
      fc.asyncProperty(siteIds, async (siteId) => {
        const { base, texts, values } = recordingSql();
        const sql = createSiteScopedSql(base as unknown as Parameters<typeof createSiteScopedSql>[0], siteId);
        await sql.begin(async () => undefined);
        expect(texts).toEqual(["SELECT set_config('app.site_id', $?, true)"]);
        expect(values).toEqual([[siteId]]);
      }),
    );
  });
});
