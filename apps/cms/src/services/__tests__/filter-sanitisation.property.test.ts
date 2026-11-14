import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fc from 'fast-check';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { items, relations, type Database } from '@lumibase/database';
import {
  ItemService,
  ItemServiceError,
  buildFilter,
  buildSort,
  type ItemFilter,
  type ItemRow,
} from '../item-service';
import { compileWhere, evaluate, type MagicContext } from '../permission-dsl';
import { PermissionService, type CompiledPermission } from '../permission-service';
import { SchemaService, type CompiledCollection } from '../schema-service';
import { containsPattern, endsWithPattern, escapeLikePattern, startsWithPattern } from '../like-pattern';
import {
  FIELD_FORBIDDEN_CODE,
  MAX_FILTER_DEPTH,
  collectFilterFields,
  findUnreadableQueryField,
  meiliFilterAttributes,
  meiliSortAttribute,
} from '../filter-guard';
import type { PolicyRule } from '@lumibase/contracts';

/**
 * Filter sanitisation audit (#738, epic #674 S09).
 *
 * Threat model: a caller who cannot READ a field (masked by the policy's field
 * whitelist) must not learn its value through a filter, a sort, a relation
 * expansion or a count. Property tests generate arbitrary filter trees over a
 * hidden field and assert the refusal is identical — same code, status and
 * message, and no database round-trip — whatever the stored data is. Plus
 * literal LIKE semantics for `_contains`-family operators and no raw SQL from
 * field names, paths, operators or values.
 */

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);

// ── A tiny Postgres LIKE evaluator (backslash is the default escape) ──────
function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '\\' && i + 1 < pattern.length) {
      i += 1;
      re += pattern[i]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else if (ch === '%') {
      re += '[\\s\\S]*';
    } else if (ch === '_') {
      re += '[\\s\\S]';
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '');
}
const like = (value: string, pattern: string) => likeToRegExp(pattern, false).test(value);
const ilike = (value: string, pattern: string) => likeToRegExp(pattern, true).test(value);

/** Strings rich in LIKE metacharacters. */
const metaString = fc.string({
  unit: fc.constantFrom('a', 'b', 'A', 'x', ' ', '%', '_', '\\', '.', '*'),
  maxLength: 12,
});

describe('LIKE wildcard escaping (#738)', () => {
  it('escaped patterns have exact substring / prefix / suffix semantics', () => {
    fc.assert(
      fc.property(metaString, metaString, (hay, needle) => {
        expect(like(hay, containsPattern(needle))).toBe(hay.includes(needle));
        expect(like(hay, startsWithPattern(needle))).toBe(hay.startsWith(needle));
        expect(like(hay, endsWithPattern(needle))).toBe(hay.endsWith(needle));
      }),
      { numRuns: 500 },
    );
  });

  it('a bare wildcard only matches itself', () => {
    expect(escapeLikePattern('%')).toBe('\\%');
    expect(escapeLikePattern('_')).toBe('\\_');
    expect(escapeLikePattern('\\')).toBe('\\\\');
    expect(like('anything', containsPattern('%'))).toBe(false);
    expect(like('100%', containsPattern('%'))).toBe(true);
    expect(like('ab', containsPattern('_'))).toBe(false);
  });

  it('item filters bind the escaped pattern (regression: `%` matched every row)', () => {
    const q = render(buildFilter({ title: { _contains: '50%_off\\' } })!);
    expect(q.params).toContain('%50\\%\\_off\\\\%');
    expect(render(buildFilter({ title: { _starts_with: '_' } })!).params).toContain('\\_%');
    expect(render(buildFilter({ title: { _ends_with: '%' } })!).params).toContain('%\\%');
  });

  it('permission-rule SQL agrees with the in-memory evaluator for any magic value', () => {
    // Regression: `{ email: { _ends_with: '$CURRENT_USER.email' } }` with a
    // user e-mail containing `%` matched every row in SQL but none in memory.
    fc.assert(
      fc.property(metaString, metaString, fc.constantFrom('_contains', '_starts_with', '_ends_with'), (stored, mine, op) => {
        const ctx: MagicContext = {
          userId: 'u1',
          siteId: 's1',
          roleId: null,
          ip: null,
          headers: {},
          user: { email: mine },
        };
        const rule = { email: { [op]: '$CURRENT_USER.email' } } as unknown as PolicyRule;
        const q = render(compileWhere(rule, ctx)!);
        const pattern = q.params[q.params.length - 1] as string;
        expect(ilike(stored, pattern)).toBe(evaluate(rule, { email: stored }, ctx));
      }),
      { numRuns: 300 },
    );
  });
});

// ── No raw SQL from names, paths, operators or values ────────────────────
const MARK = 'ZQX';
const hostile = fc.string({ maxLength: 20 }).map((s) => `${MARK}${s}`);
const OPS = [
  '_eq', '_neq', '_in', '_nin', '_gt', '_gte', '_lt', '_lte', '_contains', '_starts_with',
  '_ends_with', '_null', '_nnull', '_json_contains', '_has_key', '_has_any_keys', '_has_all_keys',
] as const;

describe('no injection through filter / sort (#738)', () => {
  it('a hostile field name, JSON path, operator or value never reaches the SQL text', () => {
    fc.assert(
      fc.property(
        fc.oneof(hostile, fc.tuple(hostile, hostile).map(([a, b]) => `${a}.${b}`), fc.constant('safe')),
        fc.oneof(fc.constantFrom(...OPS), hostile),
        fc.oneof(hostile, fc.array(hostile, { minLength: 1, maxLength: 3 }), fc.boolean(), fc.integer()),
        (field, op, value) => {
          let text: string | null = null;
          try {
            const built = buildFilter({ [field]: { [op]: value } } as ItemFilter);
            text = built ? render(built).sql : '';
          } catch (err) {
            expect(err).toBeInstanceOf(ItemServiceError);
            expect((err as ItemServiceError).code).toBe('INVALID_FILTER');
          }
          if (text !== null) expect(text).not.toContain(MARK);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('a hostile sort token never reaches the SQL text', () => {
    fc.assert(
      fc.property(hostile, fc.constantFrom('', '-', '+'), (name, dir) => {
        try {
          const text = buildSort([`${dir}${name}`]).map((s) => render(sql`${s}`).sql).join(',');
          expect(text).not.toContain(MARK);
        } catch (err) {
          expect((err as ItemServiceError).code).toBe('INVALID_FILTER');
        }
      }),
      { numRuns: 300 },
    );
  });

  it('refuses nesting deeper than MAX_FILTER_DEPTH', () => {
    let deep: ItemFilter = { title: { _eq: 'x' } };
    for (let i = 0; i <= MAX_FILTER_DEPTH; i += 1) deep = { _and: [deep] };
    expect(() => buildFilter(deep)).toThrow(/nested too deeply/);
  });
});

// ── Filter trees over hidden / readable fields ───────────────────────────
const HIDDEN = ['secret', 'salary'] as const;
const READABLE = ['title', 'body', 'author'] as const;
const STRUCTURAL = new Set(['id', 'status', 'sort', 'user_created', 'user_updated', 'created_at', 'updated_at']);
const KNOWN = [...HIDDEN, ...READABLE];

const fieldRef = fc.oneof(
  fc.constantFrom<string>(...HIDDEN, ...READABLE, 'status', 'id', 'not_a_field'),
  fc.tuple(fc.constantFrom<string>(...HIDDEN, ...READABLE), fc.constantFrom('a', 'b_c', 'x1')).map(([a, b]) => `${a}.${b}`),
);
const leafValue = fc.oneof(fc.string({ maxLength: 6 }), fc.integer(), fc.boolean(), fc.constant('%'), fc.constant('_'));
const leaf = fc
  .tuple(fieldRef, fc.constantFrom('_eq', '_neq', '_contains', '_starts_with', '_ends_with', '_null', '_nnull', '_gt', '_lt'), leafValue)
  .map(([f, op, v]) => ({ [f]: { [op]: v } }) as ItemFilter);
const { tree } = fc.letrec<{ tree: ItemFilter }>((tie) => ({
  tree: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.array(tie('tree'), { minLength: 1, maxLength: 3 }).map((xs) => ({ _and: xs }) as ItemFilter),
    fc.array(tie('tree'), { minLength: 1, maxLength: 3 }).map((xs) => ({ _or: xs }) as ItemFilter),
  ),
}));

function perm(fields: string[], overrides: Partial<CompiledPermission> = {}): CompiledPermission {
  return {
    collection: 'posts',
    action: 'read',
    rule: null,
    fields,
    presets: {},
    validation: {},
    sources: [{ policyId: 'p', policyName: 'P' }],
    ...overrides,
  };
}

/** Whether a filter names a field the readable set does not contain. */
function referencesHidden(filter: unknown, readable: ReadonlySet<string>): boolean {
  return collectFilterFields(filter).some((ref) => {
    if (STRUCTURAL.has(ref)) return false;
    return !readable.has(ref.split('.')[0]!);
  });
}

describe('readable-field guard — pure (#738)', () => {
  it('collects every field the SQL builder would compile, through _and/_or nesting', () => {
    expect(
      collectFilterFields({
        _and: [{ title: { _eq: 'a' } }, { _or: [{ secret: { _null: true } }, { 'salary.band': { _gt: 1 } }] }],
        status: { _eq: 'published' },
        ignored: 'scalar values emit no clause',
      }),
    ).toEqual(['title', 'secret', 'salary.band', 'status']);
  });

  it('whitelist, `*` with exclusions, and unknown fields', () => {
    const base = { knownFields: KNOWN, structuralFields: STRUCTURAL };
    expect(findUnreadableQueryField({ ...base, perm: perm(['*']), filter: { secret: { _eq: 1 } } })).toBeNull();
    expect(findUnreadableQueryField({ ...base, perm: null, filter: { secret: { _eq: 1 } } })).toBeNull();
    expect(findUnreadableQueryField({ ...base, perm: perm(['*', '-secret']), filter: { secret: { _eq: 1 } } })).toBe('secret');
    expect(findUnreadableQueryField({ ...base, perm: perm(['*', '-secret']), filter: { salary: { _eq: 1 } } })).toBeNull();
    // A field that does not exist is refused exactly like a hidden one, so the
    // refusal does not reveal the schema.
    expect(findUnreadableQueryField({ ...base, perm: perm(['title']), filter: { nope: { _eq: 1 } } })).toBe('nope');
    expect(findUnreadableQueryField({ ...base, perm: perm(['title']), sort: ['-secret'] })).toBe('secret');
    expect(findUnreadableQueryField({ ...base, perm: perm(['title']), sort: ['-status', 'title'] })).toBeNull();
    // JSON paths are checked on their top-level field.
    expect(findUnreadableQueryField({ ...base, perm: perm(['author']), filter: { 'author.name': { _eq: 'x' } } })).toBeNull();
    expect(findUnreadableQueryField({ ...base, perm: perm(['author']), filter: { 'secret.name': { _eq: 'x' } } })).toBe('secret.name');
  });

  it('refuses a filter exactly when it names an unreadable field (property)', () => {
    const readable = new Set<string>(READABLE);
    fc.assert(
      fc.property(tree, (filter) => {
        const result = findUnreadableQueryField({
          perm: perm([...READABLE]),
          knownFields: KNOWN,
          structuralFields: STRUCTURAL,
          filter,
        });
        expect(result !== null).toBe(referencesHidden(filter, readable));
      }),
      { numRuns: 500 },
    );
  });

  it('extracts Meili filter/sort attributes, treating quoted strings as values', () => {
    expect(meiliFilterAttributes(`title = "a b" AND (secret > 3 OR salary IN ['x', "y"]) AND NOT x EXISTS`)).toEqual([
      'title',
      'secret',
      'salary',
      'x',
    ]);
    expect(meiliFilterAttributes(`status = 'it\\'s secret = 1'`)).toEqual(['status']);
    // An unquoted value is conservatively treated as an attribute (fail closed).
    expect(meiliFilterAttributes('status = published')).toEqual(['status', 'published']);
    expect(meiliFilterAttributes('price 10 TO 20')).toEqual(['price']);
    expect(meiliSortAttribute('secret:desc')).toBe('secret');
  });
});

// ── ItemService.list: the refusal is data-independent (oracle test) ─────
const CTX: MagicContext = { userId: 'u1', siteId: 'site-1', roleId: 'r1', ip: null, headers: {} };

function row(id: string, data: Record<string, unknown>): ItemRow {
  return {
    id,
    siteId: 'site-1',
    collectionId: 'col_posts',
    status: 'published',
    sort: 0,
    data,
    userCreated: null,
    userUpdated: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  };
}

function fakeDb(byTable: Map<unknown, unknown[]>) {
  let selects = 0;
  const db = {
    select(projection?: unknown) {
      selects += 1;
      let table: unknown;
      const builder: Record<string, unknown> = {
        from: (t: unknown) => {
          table = t;
          return builder;
        },
        where: () => builder,
        orderBy: () => builder,
        limit: () => builder,
        offset: () => builder,
        then: (onF?: (v: unknown[]) => unknown, onR?: (e: unknown) => unknown) => {
          const value = projection !== undefined ? [{ count: (byTable.get(items) ?? []).length }] : byTable.get(table) ?? [];
          return Promise.resolve(value).then(onF, onR);
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as Database, selects: () => selects };
}

function stubSchemas(schemas: Record<string, string[]>) {
  vi.spyOn(SchemaService.prototype, 'getCompiled').mockImplementation(async (name: string) => {
    const fields = schemas[name];
    if (!fields) return null;
    return {
      id: `col_${name}`,
      name,
      primaryKeyField: 'id',
      primaryKeyType: 'nanoid',
      storageMode: 'jsonb',
      meta: null,
      fields: fields.map((f) => ({ name: f, type: 'string' })),
    } as unknown as CompiledCollection;
  });
}

function grant(perms: Record<string, CompiledPermission | null>) {
  vi.spyOn(PermissionService.prototype, 'canAccess').mockImplementation(async (collection) => perms[collection] ?? null);
}

function listService(rows: ItemRow[], extra: Map<unknown, unknown[]> = new Map(), schemas: Record<string, string[]> = { posts: KNOWN }) {
  const tables = new Map<unknown, unknown[]>([[items, rows], ...extra]);
  const fake = fakeDb(tables);
  stubSchemas(schemas);
  const svc = new ItemService({ db: fake.db, siteId: 'site-1', permissionCtx: CTX });
  return { svc, selects: fake.selects };
}

async function outcome(p: Promise<unknown>) {
  try {
    await p;
    return { ok: true as const };
  } catch (err) {
    const e = err as ItemServiceError;
    return { ok: false as const, code: e.code, status: e.status, message: e.message };
  }
}

describe('ItemService.list — hidden fields are not observable (#738)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('any filter over a hidden field is refused identically for different stored data, before any query', async () => {
    grant({ posts: perm([...READABLE]) });
    const readable = new Set<string>(READABLE);
    await fc.assert(
      fc.asyncProperty(tree, fc.option(fc.constantFrom('secret', '-salary', 'title', '-id'), { nil: undefined }), async (filter, sortToken) => {
        const sort = sortToken ? [sortToken] : undefined;
        const a = listService([row('1', { title: 't', secret: 'alpha', salary: 1 })]);
        const b = listService([row('1', { title: 't', secret: 'omega', salary: 999 }), row('2', { secret: 'beta' })]);
        const ra = await outcome(a.svc.list('posts', { filter, sort, withTotal: true }));
        const rb = await outcome(b.svc.list('posts', { filter, sort, withTotal: true }));
        const hiddenSort = sortToken !== undefined && !STRUCTURAL.has(sortToken.replace(/^-/, '')) && !readable.has(sortToken.replace(/^-/, ''));
        if (referencesHidden(filter, readable) || hiddenSort) {
          expect(ra).toEqual(rb);
          expect(ra).toMatchObject({ ok: false, code: FIELD_FORBIDDEN_CODE, status: 403 });
          // No round-trip: the decision cannot depend on (or time) the data.
          expect(a.selects()).toBe(0);
          expect(b.selects()).toBe(0);
        } else if (!ra.ok) {
          expect(ra.code).not.toBe(FIELD_FORBIDDEN_CODE);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('regressions: _starts_with / _null / sort / JSON path on a hidden field are refused', async () => {
    grant({ posts: perm(['*', '-secret']) });
    for (const params of [
      { filter: { secret: { _starts_with: 'a' } } },
      { filter: { secret: { _null: true } } },
      { filter: { _or: [{ title: { _eq: 'x' } }, { _and: [{ secret: { _contains: '%' } }] }] } },
      { filter: { 'secret.nested': { _eq: 'x' } } },
      { sort: ['-secret'] },
    ] as const) {
      const { svc, selects } = listService([row('1', { title: 't', secret: 's' })]);
      await expect(svc.list('posts', params as never)).rejects.toMatchObject({ code: FIELD_FORBIDDEN_CODE, status: 403 });
      expect(selects()).toBe(0);
    }
  });

  it('readable fields, structural columns and unrestricted callers still filter and sort', async () => {
    grant({ posts: perm(['title']) });
    const { svc } = listService([row('1', { title: 't', secret: 's' })]);
    const res = await svc.list('posts', {
      filter: { _and: [{ title: { _contains: 't' } }, { status: { _eq: 'published' } }] },
      sort: ['-updated_at', 'title'],
    });
    expect(res.data).toHaveLength(1);
    expect((res.data[0] as ItemRow).data).toEqual({ title: 't' });

    vi.restoreAllMocks();
    grant({ posts: perm(['*']) });
    const open = listService([row('1', { title: 't', secret: 's' })]);
    await expect(open.svc.list('posts', { filter: { secret: { _eq: 's' } }, sort: ['secret'] })).resolves.toBeDefined();
  });

  it('o2m expansion yields nothing when the child FK field is hidden (relational oracle)', async () => {
    grant({ posts: perm(['*']), comments: perm(['body']) });
    const rel = { siteId: 'site-1', type: 'o2m', manyCollection: 'comments', manyField: 'post_id', oneCollection: 'posts' };
    const { svc, selects } = listService(
      [row('p1', { title: 't' })],
      new Map<unknown, unknown[]>([[relations, [rel]]]),
      { posts: KNOWN, comments: ['body', 'post_id'] },
    );
    const res = await svc.list('posts', { fields: ['title', 'comments.body'], withTotal: false });
    expect((res.data[0] as Record<string, unknown>).comments).toEqual([]);
    // items + relations only — the child rows were never loaded.
    expect(selects()).toBe(2);
  });

  it('m2m expansion yields nothing without read access to the junction collection', async () => {
    grant({ posts: perm(['*']), tags: perm(['*']) });
    const rel = {
      siteId: 'site-1',
      type: 'm2m',
      manyCollection: 'posts',
      manyField: 'tags',
      oneCollection: 'tags',
      junctionCollection: 'posts_tags',
      junctionManyField: 'post_id',
      junctionOneField: 'tag_id',
    };
    const { svc, selects } = listService(
      [row('p1', { title: 't' })],
      new Map<unknown, unknown[]>([[relations, [rel]]]),
      { posts: KNOWN, tags: ['name'], posts_tags: ['post_id', 'tag_id'] },
    );
    const res = await svc.list('posts', { fields: ['title', 'tags.name'], withTotal: false });
    expect((res.data[0] as Record<string, unknown>).tags).toEqual([]);
    expect(selects()).toBe(2);
  });
});
