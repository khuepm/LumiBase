import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import Ajv2020 from 'ajv/dist/2020';
import wordpress from './fixtures/wordpress-alike.json';
import wordpressSchemaOnly from './fixtures/wordpress-alike.schema-only.json';
import {
  BackendTemplateSchema,
  TEMPLATE_LIMITS,
  backendTemplateJsonSchema,
  canonicalTemplate,
  canonicalTemplateJson,
  exportBackendTemplate,
  parseBackendTemplate,
  templateDigest,
  validateBackendTemplate,
  type BackendTemplate,
  type TemplateError,
} from '../index';

/**
 * #901 (BT01) — the `lumibase.template@v1` contract. One `describe` per
 * acceptance criterion; names carry the AC id for the evidence trail.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ok = (input: unknown) => {
  const result = validateBackendTemplate(input);
  if (!result.ok) throw new Error(`expected valid, got ${JSON.stringify(result.errors, null, 1)}`);
  return result.template;
};
const errorsOf = (input: unknown): TemplateError[] => {
  const result = validateBackendTemplate(input);
  if (result.ok) throw new Error('expected the template to be refused');
  return result.errors;
};

/** A minimal valid template with `n` collections, each with one string field. */
function minimal(collections = 1): Record<string, unknown> {
  return {
    formatVersion: 'lumibase.template@v1',
    slug: 'minimal',
    displayName: 'Minimal',
    templateVersion: '1.0.0',
    compatibility: { cmsVersionRange: '>=2.2.0', storageModes: ['jsonb'] },
    config: {
      version: 'lumibase.config@v1',
      collections: Array.from({ length: collections }, (_, i) => ({ name: `c${i}` })),
      fields: Array.from({ length: collections }, (_, i) => ({ collection: `c${i}`, field: 'title', type: 'string', interface: 'input' })),
      relations: [],
    },
  };
}

/** Fisher-Yates shuffle driven by fast-check's random source. */
function shuffled<T>(list: T[], seed: number): T[] {
  const out = [...list];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Same object with every object's keys in a seeded random order. */
function reorderKeys(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) return value.map((v, i) => reorderKeys(v, seed + i));
  if (value !== null && typeof value === 'object') {
    const keys = shuffled(Object.keys(value as Record<string, unknown>), seed);
    const out: Record<string, unknown> = {};
    for (const [i, key] of keys.entries()) out[key] = reorderKeys((value as Record<string, unknown>)[key], seed + i + 1);
    return out;
  }
  return value;
}

function permuted(t: BackendTemplate, seed: number): unknown {
  const copy = clone(t);
  copy.config.collections = shuffled(copy.config.collections, seed);
  copy.config.fields = shuffled(copy.config.fields, seed + 1);
  copy.config.relations = shuffled(copy.config.relations, seed + 2);
  for (const pack of Object.values(copy.seedPacks ?? {})) pack.records = shuffled(pack.records, seed + 3);
  return reorderKeys(copy, seed + 4);
}

describe('BT01-AC01 — schema-only round trip', () => {
  it('validate → export → reparse keeps the schema and inserts no seed default', () => {
    const template = ok(wordpressSchemaOnly);
    expect(template.seedPacks).toBeUndefined();
    const exported = exportBackendTemplate(template);
    expect('seedPacks' in exported).toBe(false);
    const reparsed = parseBackendTemplate(JSON.stringify(exported));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(canonicalTemplate(reparsed.template)).toEqual(canonicalTemplate(template));
    expect('seedPacks' in reparsed.template).toBe(false);
    expect(reparsed.template.config.collections).toHaveLength(8);
  });

  it('round-trips under any permutation (property)', async () => {
    const template = ok(wordpressSchemaOnly);
    await fc.assert(fc.asyncProperty(fc.integer(), async (seed) => {
      const again = parseBackendTemplate(JSON.stringify(permuted(template, seed)));
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(canonicalTemplateJson(exportBackendTemplate(again.template))).toBe(canonicalTemplateJson(template));
    }), { numRuns: 50 });
  });
});

describe('BT01-AC02 — stable digest', () => {
  it('is equal under key and keyed-list reordering (property), seed packs included', async () => {
    const template = ok(wordpress);
    const digest = await templateDigest(template);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    await fc.assert(fc.asyncProperty(fc.integer(), async (seed) => {
      expect(await templateDigest(ok(permuted(template, seed)))).toBe(digest);
    }), { numRuns: 50 });
  });

  it('changes when a field or a seed value changes, and ignores transport metadata', async () => {
    const template = ok(wordpress);
    const base = await templateDigest(template);
    const field = clone(template);
    field.config.fields[0]!.required = false;
    expect(await templateDigest(ok(field))).not.toBe(base);
    const seed = clone(template);
    seed.seedPacks!['demo']!.records[0]!.values['name'] = 'Another author';
    expect(await templateDigest(ok(seed))).not.toBe(base);
    const stamped = clone(template);
    stamped.config.exportedAt = '2026-11-19T00:00:00Z';
    expect(await templateDigest(ok(stamped))).toBe(base);
  });

  it('keeps the order of arrays whose order is data', async () => {
    const t = ok(minimal());
    t.config.fields[0]!.special = ['a', 'b'];
    const swapped = clone(t);
    swapped.config.fields[0]!.special = ['b', 'a'];
    expect(await templateDigest(t)).not.toBe(await templateDigest(swapped));
  });
});

describe('BT01-AC03 — precise rejection', () => {
  const cases: Array<[string, (t: Record<string, any>) => void, string, string]> = [
    ['unknown format', (t) => { t.formatVersion = 'lumibase.template@v2'; }, 'UNSUPPORTED_FORMAT', '$.formatVersion'],
    ['unknown config version', (t) => { t.config.version = 'lumibase.config@v9'; }, 'UNSUPPORTED_FORMAT', '$.config.version'],
    ['invalid SemVer', (t) => { t.templateVersion = '1.0'; }, 'INVALID_TEMPLATE', '$.templateVersion'],
    ['leading-zero SemVer', (t) => { t.templateVersion = '01.0.0'; }, 'INVALID_TEMPLATE', '$.templateVersion'],
    ['duplicate collection', (t) => { t.config.collections.push({ name: 'posts' }); }, 'INVALID_TEMPLATE', '$.config.collections[8].name'],
    ['duplicate field', (t) => { t.config.fields.push({ collection: 'posts', field: 'title', type: 'string', interface: 'input' }); }, 'INVALID_TEMPLATE', '$.config.fields[22].field'],
    ['duplicate relation', (t) => { t.config.relations.push({ ...t.config.relations[0] }); }, 'INVALID_TEMPLATE', '$.config.relations[10].manyField'],
    ['duplicate seed key', (t) => { t.seedPacks.demo.records.push({ ...t.seedPacks.demo.records[0] }); }, 'INVALID_TEMPLATE', '$.seedPacks["demo"].records[2].key'],
    ['dangling relation collection', (t) => { t.config.relations[0].oneCollection = 'writers'; }, 'INVALID_TEMPLATE', '$.config.relations[0].oneCollection'],
    ['dangling relation field', (t) => { t.config.relations[0].manyField = 'writer'; }, 'INVALID_TEMPLATE', '$.config.relations[0].manyField'],
    ['field of undeclared collection', (t) => { t.config.fields[0].collection = 'ghosts'; }, 'INVALID_TEMPLATE', '$.config.fields[0].collection'],
    ['reserved prefix', (t) => { t.config.collections[0].name = 'lumibase_users'; }, 'INVALID_TEMPLATE', '$.config.collections[0].name'],
    ['system collection', (t) => { t.config.collections[0].system = true; }, 'INVALID_TEMPLATE', '$.config.collections[0].system'],
    ['unsupported storage', (t) => { t.config.collections[0].storageMode = 'physical'; t.compatibility.storageModes.push('physical'); }, 'INCOMPATIBLE_RUNTIME', '$.config.collections[0].storageMode'],
    ['undeclared storage', (t) => { t.config.collections[0].storageMode = 'materialized'; }, 'INVALID_TEMPLATE', '$.config.collections[0].storageMode'],
    ['non-nanoid key', (t) => { t.config.collections[0].primaryKeyType = 'integer'; }, 'INVALID_TEMPLATE', '$.config.collections[0].primaryKeyType'],
    ['unknown field type', (t) => { t.config.fields[0].type = 'money'; }, 'INVALID_TEMPLATE', '$.config.fields[0].type'],
    ['m2a relation', (t) => { t.config.relations[0].type = 'm2a'; }, 'INCOMPATIBLE_RUNTIME', '$.config.relations[0].type'],
    ['seed reference to another collection', (t) => { t.seedPacks.demo.records.push({ key: 'c1', collection: 'comments', values: { body: 'x' }, references: { post: 'author-demo' } }); }, 'INVALID_TEMPLATE', '$.seedPacks["demo"].records[2].references["post"]'],
    ['external seed reference', (t) => { t.seedPacks.demo.records[1].references.author = 'author-elsewhere'; }, 'INVALID_TEMPLATE', '$.seedPacks["demo"].records[1].references["author"]'],
    ['relation in values', (t) => { t.seedPacks.demo.records[1].values.author = 'author-demo'; }, 'INVALID_TEMPLATE', '$.seedPacks["demo"].records[1].values["author"]'],
    ['value of the wrong type', (t) => { t.seedPacks.demo.records[1].values.title = 42; }, 'INVALID_TEMPLATE', '$.seedPacks["demo"].records[1].values["title"]'],
    ['missing required value', (t) => { delete t.seedPacks.demo.records[0].values.name; }, 'INVALID_TEMPLATE', '$.seedPacks["demo"].records[0]'],
  ];

  it.each(cases)('%s → stable code and JSON path', (_label, mutate, code, path) => {
    const doc = clone(wordpress) as Record<string, any>;
    mutate(doc);
    const errors = errorsOf(doc);
    expect(errors, JSON.stringify(errors)).toContainEqual(expect.objectContaining({ code, path }));
  });

  it('duplicate JSON keys in raw text are refused with their path (never last-wins)', () => {
    const text = JSON.stringify(wordpress).replace('"storageMode":"jsonb"', '"storageMode":"jsonb","storageMode":"physical"');
    const result = parseBackendTemplate(text);
    expect(result).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'INVALID_TEMPLATE', path: '$.config.collections[0].storageMode' })] });
  });

  it('required references that form a cycle are refused', () => {
    const doc = clone(wordpress) as Record<string, any>;
    const parent = doc.config.fields.find((f: { collection: string; field: string }) => f.collection === 'comments' && f.field === 'parent');
    parent.required = true;
    doc.seedPacks.demo.records.push(
      { key: 'c-a', collection: 'comments', values: { body: 'a' }, references: { post: 'post-demo', parent: 'c-b' } },
      { key: 'c-b', collection: 'comments', values: { body: 'b' }, references: { post: 'post-demo', parent: 'c-a' } },
    );
    expect(errorsOf(doc).some((e) => /cycle/.test(e.message))).toBe(true);
  });

  it('reports every problem, not just the first', () => {
    const doc = clone(wordpress) as Record<string, any>;
    doc.config.fields[0].type = 'money';
    doc.config.relations[0].oneCollection = 'writers';
    expect(errorsOf(doc).length).toBeGreaterThanOrEqual(2);
  });
});

describe('BT01-AC04 — limits (exact boundary and boundary + 1)', () => {
  const codes = (input: unknown) => {
    const r = validateBackendTemplate(input);
    return r.ok ? [] : r.errors.map((e) => e.code);
  };

  it('2 MiB document (UTF-8 bytes of the text)', () => {
    const base = JSON.stringify(minimal());
    const pad = TEMPLATE_LIMITS.maxDocumentBytes - base.length;
    const atLimit = base.slice(0, -1) + ' '.repeat(pad) + '}';
    expect(new TextEncoder().encode(atLimit).length).toBe(TEMPLATE_LIMITS.maxDocumentBytes);
    expect(parseBackendTemplate(atLimit).ok).toBe(true);
    const over = parseBackendTemplate(`${atLimit} `);
    expect(over).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'LIMIT_EXCEEDED', path: '$' })] });
  });

  it('nesting depth 32', () => {
    const nest = (levels: number): unknown => (levels === 0 ? 1 : { a: nest(levels - 1) });
    // root(1) → config(2) → collections(3) → [0](4); meta adds the remaining levels.
    const at = (depth: number) => {
      const doc = minimal() as any;
      doc.config.collections[0].meta = nest(depth - 4);
      return doc;
    };
    expect(codes(at(32))).toEqual([]);
    expect(codes(at(33))).toContain('LIMIT_EXCEEDED');
    expect(parseBackendTemplate(JSON.stringify(at(32))).ok).toBe(true);
    const raw = parseBackendTemplate(JSON.stringify(at(33)));
    expect(raw.ok ? [] : raw.errors.map((e) => e.code)).toEqual(['LIMIT_EXCEEDED']);
  });

  it('100 collections', () => {
    expect(codes(minimal(100))).toEqual([]);
    expect(codes(minimal(101))).toEqual(['LIMIT_EXCEEDED']);
  });

  it('2000 fields', () => {
    const withFields = (n: number) => {
      const doc = minimal(100) as any;
      doc.config.fields = Array.from({ length: n }, (_, i) => ({ collection: `c${i % 100}`, field: `f${i}`, type: 'string', interface: 'input' }));
      return doc;
    };
    expect(codes(withFields(2000))).toEqual([]);
    expect(codes(withFields(2001))).toEqual(['LIMIT_EXCEEDED']);
  });

  it('500 relations', () => {
    const withRelations = (n: number) => {
      const doc = minimal(100) as any;
      doc.config.fields.push(...Array.from({ length: n }, (_, i) => ({ collection: `c${i % 100}`, field: `r${i}`, type: 'string', interface: 'input' })));
      doc.config.relations = Array.from({ length: n }, (_, i) => ({ manyCollection: `c${i % 100}`, manyField: `r${i}`, oneCollection: 'c0', type: 'm2o' }));
      return doc;
    };
    expect(codes(withRelations(500))).toEqual([]);
    expect(codes(withRelations(501))).toEqual(['LIMIT_EXCEEDED']);
  });

  it('1000 seed records across packs', () => {
    const withRecords = (a: number, b: number) => {
      const doc = minimal() as any;
      const pack = (n: number, p: string) => ({ records: Array.from({ length: n }, (_, i) => ({ key: `${p}${i}`, collection: 'c0', values: { title: 't' } })) });
      doc.seedPacks = { one: pack(a, 'a'), two: pack(b, 'b') };
      return doc;
    };
    expect(codes(withRecords(600, 400))).toEqual([]);
    expect(codes(withRecords(600, 401))).toEqual(['LIMIT_EXCEEDED']);
  });

  it('1 MiB of seed values', () => {
    const withBytes = (total: number) => {
      const doc = minimal() as any;
      // Per record: JSON.stringify(values) + JSON.stringify(references ?? {}) = `{"title":"…"}` + `{}`.
      const overhead = '{"title":""}'.length + '{}'.length;
      const per = 4096;
      const count = Math.floor(total / per);
      const sizes = Array.from({ length: count }, () => per);
      sizes[0]! += total - count * per;
      const records = sizes.map((size, i) => ({ key: `r${i}`, collection: 'c0', values: { title: 'x'.repeat(size - overhead) } }));
      doc.seedPacks = { demo: { records } };
      return doc;
    };
    expect(codes(withBytes(TEMPLATE_LIMITS.maxSeedValueBytes))).toEqual([]);
    expect(codes(withBytes(TEMPLATE_LIMITS.maxSeedValueBytes + 1))).toEqual(['LIMIT_EXCEEDED']);
  });
});

describe('BT01-AC05 — portable identity', () => {
  const refused: Array<[string, (t: Record<string, any>) => void]> = [
    ['source site id', (t) => { t.siteId = 'site_a'; }],
    ['site id in config', (t) => { t.config.siteId = 'site_a'; }],
    ['collection runtime id', (t) => { t.config.collections[0].id = 'abc123'; }],
    ['field runtime id', (t) => { t.config.fields[0].id = 'fld_1'; }],
    ['seed record id', (t) => { t.seedPacks.demo.records[0].values.id = 'itm_1'; }],
    ['seed site id', (t) => { t.seedPacks.demo.records[0].values.site_id = 'site_a'; }],
    ['seed record id property', (t) => { t.seedPacks.demo.records[0].id = 'itm_1'; }],
    ['declared id field', (t) => { t.config.fields.push({ collection: 'posts', field: 'id', type: 'string', interface: 'input' }); }],
    ['executable SQL', (t) => { t.sql = 'DROP TABLE lumibase_users'; }],
    ['migrations', (t) => { t.config.migrations = ['CREATE TABLE x()']; }],
    ['webhooks', (t) => { t.config.webhooks = [{ name: 'w', url: 'https://example.com' }]; }],
    ['settings (may hold secrets)', (t) => { t.config.settings = [{ key: 'smtp.password', value: 'x' }]; }],
    ['replacement scopes', (t) => { t.config.managedScopes = ['posts']; }],
    ['permissions', (t) => { t.permissions = [{ role: 'public', action: 'read' }]; }],
    ['hash field seed', (t) => { t.config.fields.push({ collection: 'authors', field: 'secret', type: 'hash', interface: 'input' }); t.seedPacks.demo.records[0].values.secret = 'x'; }],
  ];

  it.each(refused)('refuses %s', (_label, mutate) => {
    const doc = clone(wordpress) as Record<string, any>;
    mutate(doc);
    expect(errorsOf(doc).every((e) => e.code === 'INVALID_TEMPLATE')).toBe(true);
  });

  it('empty webhooks / settings are allowed and dropped from the export', () => {
    const doc = clone(wordpress) as Record<string, any>;
    doc.config.webhooks = [];
    doc.config.settings = [];
    const exported = exportBackendTemplate(ok(doc));
    expect(exported.config).not.toHaveProperty('webhooks');
    expect(exported.config).not.toHaveProperty('settings');
  });

  it('the export carries no runtime identity', () => {
    const text = canonicalTemplateJson(exportBackendTemplate(ok(wordpress)));
    expect(text).not.toMatch(/"(id|siteId|site_id|createdAt|updatedAt|exportedAt)":/);
  });
});

describe('BT01-AC06 — Zod and generated JSON Schema agree', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validateJson = ajv.compile(backendTemplateJsonSchema());

  /** Structural fixtures: what the envelope (not the semantic checks) accepts. */
  const fixtures: Array<[string, unknown, boolean]> = [
    ['wordpress with seeds', wordpress, true],
    ['wordpress schema-only (seedPacks omitted)', wordpressSchemaOnly, true],
    ['null reference', (() => { const d = clone(wordpress) as any; d.seedPacks.demo.records[1].references.author = null; return d; })(), true],
    ['references omitted', (() => { const d = clone(wordpress) as any; delete d.seedPacks.demo.records[0].references; return d; })(), true],
    ['empty seed packs map', { ...clone(wordpressSchemaOnly), seedPacks: {} }, true],
    ['nullable field label', (() => { const d = clone(wordpress) as any; d.config.fields[0].label = null; return d; })(), true],
    ['missing slug', (() => { const d = clone(wordpress) as any; delete d.slug; return d; })(), false],
    ['bad slug', { ...clone(wordpress), slug: 'Word Press' }, false],
    ['bad semver', { ...clone(wordpress), templateVersion: 'v1.0.0' }, false],
    ['unknown top-level key', { ...clone(wordpress), siteId: 's' }, false],
    ['unknown storage mode', (() => { const d = clone(wordpress) as any; d.compatibility.storageModes = ['sqlite']; return d; })(), false],
    ['reference not a string', (() => { const d = clone(wordpress) as any; d.seedPacks.demo.records[1].references.author = 42; return d; })(), false],
    ['bad pack name', { ...clone(wordpress), seedPacks: { 'Demo Pack': { records: [] } } }, false],
    ['non-empty webhooks', (() => { const d = clone(wordpress) as any; d.config.webhooks = [{ name: 'x' }]; return d; })(), false],
    ['no collections', (() => { const d = clone(wordpress) as any; d.config.collections = []; return d; })(), false],
    ['unknown field key', (() => { const d = clone(wordpress) as any; d.config.fields[0].sql = 'x'; return d; })(), false],
  ];

  it.each(fixtures)('%s', (_label, input, expected) => {
    const zod = BackendTemplateSchema.safeParse(input).success;
    const json = validateJson(input) as boolean;
    expect({ zod, json }).toEqual({ zod: expected, json: expected });
  });
});
