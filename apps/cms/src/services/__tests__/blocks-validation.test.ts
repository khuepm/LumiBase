import { describe, expect, it, vi } from 'vitest';
import { validateItem, type ValidationIssue } from '../validation';
import {
  MAX_BLOCK_DEPTH,
  blocksFieldConfigProblems,
  readBlocksOptions,
  resolveBlockTemplates,
} from '../blocks';
import type { Database } from '@lumibase/database';
import { SchemaService, SchemaServiceError, assertBlocksFieldConfig } from '../schema-service';
import { ALL, blocksField, cf, coll, cta, getCompiledFrom, pages } from './blocks-fixtures';

/** Dynamic zones (#748) — validation matrix for the `blocks` field type. */

async function templatesFor(fields = pages.fields, list = ALL) {
  return resolveBlockTemplates(fields, (n) => getCompiledFrom(list, n));
}

async function validatePage(data: Record<string, unknown>, opts: { partial?: boolean } = {}) {
  return validateItem(pages.fields, data, { ...opts, blockTemplates: await templatesFor() });
}

function issuesOf(r: ReturnType<typeof validateItem>): ValidationIssue[] {
  if (r.ok) throw new Error('expected validation to fail');
  return r.issues;
}

function paths(r: ReturnType<typeof validateItem>): string[] {
  return issuesOf(r).map((i) => i.field);
}

describe('blocks field config (schema write)', () => {
  it('accepts a well-formed definition and ignores other types', () => {
    expect(blocksFieldConfigProblems({ type: 'blocks', options: { allowedBlocks: ['hero'], min: 0, max: 3 } })).toEqual([]);
    expect(blocksFieldConfigProblems({ type: 'json', options: {} })).toEqual([]);
  });

  it.each([
    [{}, 'non-empty array'],
    [{ allowedBlocks: [] }, 'non-empty array'],
    [{ allowedBlocks: ['Hero'] }, 'machine name'],
    [{ allowedBlocks: ['hero', 'hero'] }, 'duplicates'],
    [{ allowedBlocks: ['hero'], min: -1 }, 'options.min'],
    [{ allowedBlocks: ['hero'], max: 1.5 }, 'options.max'],
    [{ allowedBlocks: ['hero'], min: 3, max: 1 }, 'must not exceed'],
  ])('rejects options %j', (options, fragment) => {
    const problems = blocksFieldConfigProblems({ type: 'blocks', options });
    expect(problems.join(' ')).toContain(fragment);
  });

  it('rejects an encrypted blocks field', () => {
    expect(blocksFieldConfigProblems({ type: 'blocks', options: { allowedBlocks: ['hero'] }, encrypted: true })).toHaveLength(1);
  });

  it('assertBlocksFieldConfig throws a 422 SchemaServiceError', () => {
    try {
      assertBlocksFieldConfig({ type: 'blocks', options: {} });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaServiceError);
      expect((err as SchemaServiceError).code).toBe('INVALID_FIELD_CONFIG');
      expect((err as SchemaServiceError).status).toBe(422);
    }
  });

  it('SchemaService.createField rejects a malformed blocks field before touching the DB', async () => {
    const svc = new SchemaService({ db: {} as Database, siteId: 'site-1' });
    await expect(
      svc.createField('pages', { name: 'zone', type: 'blocks', interface: 'blocks', options: { allowedBlocks: [] } }),
    ).rejects.toMatchObject({ code: 'INVALID_FIELD_CONFIG', status: 422 });
  });

  it('readBlocksOptions is lenient at runtime', () => {
    expect(readBlocksOptions(null)).toEqual({ allowedBlocks: [] });
    expect(readBlocksOptions({ allowedBlocks: ['hero', 7, 'hero', 'BAD'], min: 'x', max: 2 })).toEqual({
      allowedBlocks: ['hero'],
      max: 2,
    });
  });
});

describe('resolveBlockTemplates', () => {
  it('collects templates transitively through nested zones', async () => {
    const map = await templatesFor();
    expect([...map.keys()].sort()).toEqual(['columns', 'cta', 'hero']);
  });

  it('omits templates that do not exist (validator then fails closed)', async () => {
    const map = await templatesFor([blocksField('z', ['ghost', 'hero'])]);
    expect([...map.keys()]).toEqual(['hero']);
  });

  it('stops at the depth bound and terminates on self-reference', async () => {
    const loop = coll('loop', [blocksField('inner', ['loop'])]);
    const getCompiled = vi.fn((n: string) => getCompiledFrom([loop], n));
    const map = await resolveBlockTemplates(loop.fields, getCompiled);
    expect([...map.keys()]).toEqual(['loop']);
    expect(getCompiled).toHaveBeenCalledTimes(1);
  });
});

describe('blocks validation — null / missing / empty (Strapi #26816 class)', () => {
  it('normalises null to []', async () => {
    const r = await validatePage({ sections: null });
    expect(r).toEqual({ ok: true, data: { sections: [] } });
  });

  it('keeps [] as []', async () => {
    expect(await validatePage({ sections: [] })).toEqual({ ok: true, data: { sections: [] } });
  });

  it('leaves a missing optional zone missing (no crash)', async () => {
    expect(await validatePage({ title: 'x' })).toEqual({ ok: true, data: { title: 'x' } });
  });

  it('skips an absent zone on a partial update', async () => {
    expect(await validatePage({ title: 'y' }, { partial: true })).toEqual({ ok: true, data: { title: 'y' } });
  });

  it('treats block data null/missing as {} (then validates required fields)', async () => {
    const r = await validatePage({ sections: [{ id: 'a', type: 'cta', data: null }] });
    expect(paths(r)).toEqual(['sections.0.data.label']);
    const ok = validateItem([blocksField('z', ['columns'])], { z: [{ id: 'b', type: 'columns' }] }, {
      blockTemplates: await templatesFor([blocksField('z', ['columns'])]),
    });
    expect(ok).toEqual({ ok: true, data: { z: [{ id: 'b', type: 'columns', data: {} }] } });
  });

  it('a required zone rejects missing, null and empty', async () => {
    const fields = [blocksField('body', ['hero'], { required: true })];
    const blockTemplates = await templatesFor(fields);
    for (const data of [{}, { body: null }, { body: [] }]) {
      const r = validateItem(fields, data, { blockTemplates });
      expect(paths(r)).toEqual(['body']);
    }
  });
});

describe('blocks validation — shape and per-block schema', () => {
  it('accepts valid blocks, preserving order and ids', async () => {
    const sections = [
      { id: 'h1', type: 'hero', data: { title: 'Hi', height: 3 } },
      { id: 'c1', type: 'cta', data: { label: 'Go', url: 'https://example.com' } },
    ];
    expect(await validatePage({ sections })).toEqual({ ok: true, data: { sections } });
  });

  it('assigns a nanoid to blocks without an id', async () => {
    const r = await validatePage({ sections: [{ type: 'cta', data: { label: 'Go' } }] });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const [block] = r.data.sections as Array<{ id: string }>;
    expect(block!.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });

  it.each([
    ['non-array value', { sections: 'nope' }, ['sections'], 'invalid_type'],
    ['non-object block', { sections: [1] }, ['sections.0'], 'invalid_type'],
    ['missing type', { sections: [{ id: 'a', data: {} }] }, ['sections.0.type'], 'invalid_type'],
    ['disallowed type', { sections: [{ id: 'a', type: 'pages', data: {} }] }, ['sections.0.type'], 'invalid_value'],
    ['unknown block property', { sections: [{ id: 'a', type: 'cta', data: { label: 'x' }, __typename: 'X' }] }, ['sections.0.__typename'], 'unrecognized_keys'],
    ['malformed id', { sections: [{ id: 'has space', type: 'cta', data: { label: 'x' } }] }, ['sections.0.id'], 'invalid_format'],
    ['non-object data', { sections: [{ id: 'a', type: 'cta', data: [1] }] }, ['sections.0.data'], 'invalid_type'],
    ['unknown data field', { sections: [{ id: 'a', type: 'cta', data: { label: 'x', nope: 1 } }] }, ['sections.0.data.nope'], 'unrecognized_keys'],
    ['wrong data type', { sections: [{ id: 'a', type: 'hero', data: { title: 5 } }] }, ['sections.0.data.title'], 'invalid_type'],
    ['data rule (min)', { sections: [{ id: 'a', type: 'hero', data: { title: 't', height: -1 } }] }, ['sections.0.data.height'], 'too_small'],
    ['data rule (url)', { sections: [{ id: 'a', type: 'cta', data: { label: 'x', url: 'nope' } }] }, ['sections.0.data.url'], 'invalid_format'],
  ])('rejects %s with a path-precise issue', async (_label, data, expectedPaths, code) => {
    const r = await validatePage(data);
    expect(paths(r)).toEqual(expectedPaths);
    expect(issuesOf(r)[0]!.code).toBe(code);
  });

  it('rejects duplicate block ids at the second occurrence', async () => {
    const r = await validatePage({
      sections: [
        { id: 'dup', type: 'cta', data: { label: 'a' } },
        { id: 'dup', type: 'cta', data: { label: 'b' } },
      ],
    });
    expect(paths(r)).toEqual(['sections.1.id']);
  });

  it('rejects a block whose template no longer exists (fail closed)', async () => {
    const fields = [blocksField('z', ['ghost'])];
    const r = validateItem(fields, { z: [{ id: 'a', type: 'ghost', data: {} }] }, { blockTemplates: new Map() });
    expect(paths(r)).toEqual(['z.0.type']);
    expect(issuesOf(r)[0]!.message).toContain('does not exist');
  });

  it('fails closed when no template map is supplied at all', () => {
    const r = validateItem(pages.fields, { sections: [{ id: 'a', type: 'cta', data: { label: 'x' } }] });
    expect(paths(r)).toEqual(['sections.0.type']);
  });

  it('enforces min / max', async () => {
    const fields = [blocksField('z', ['cta'], { min: 1, max: 2 })];
    const blockTemplates = await templatesFor(fields);
    const b = (id: string) => ({ id, type: 'cta', data: { label: id } });
    expect(issuesOf(validateItem(fields, { z: [] }, { blockTemplates }))[0]!.code).toBe('too_small');
    expect(validateItem(fields, { z: [b('a'), b('b')] }, { blockTemplates }).ok).toBe(true);
    expect(issuesOf(validateItem(fields, { z: [b('a'), b('b'), b('c')] }, { blockTemplates }))[0]!.code).toBe('too_big');
  });

  it('rejects values for encrypted / pii template fields', async () => {
    const secret = coll('secret', [cf('ssn', 'string', { encrypted: true, classification: 'pii' })]);
    const fields = [blocksField('z', ['secret'])];
    const blockTemplates = await resolveBlockTemplates(fields, (n) => getCompiledFrom([secret], n));
    const r = validateItem(fields, { z: [{ id: 'a', type: 'secret', data: { ssn: '123' } }] }, { blockTemplates });
    expect(paths(r)).toEqual(['z.0.data.ssn']);
  });

  it('reports every bad block, not only the first', async () => {
    const r = await validatePage({
      sections: [
        { id: 'a', type: 'hero', data: {} },
        { id: 'b', type: 'cta', data: { label: 'ok' } },
        { id: 'c', type: 'nope', data: {} },
      ],
    });
    expect(paths(r)).toEqual(['sections.0.data.title', 'sections.2.type']);
  });
});

describe('blocks validation — nested zones', () => {
  it('validates nested blocks recursively with full paths', async () => {
    const r = await validatePage({
      sections: [
        {
          id: 'col',
          type: 'columns',
          data: {
            gap: 2,
            items: [
              { id: 'x', type: 'cta', data: { label: 'ok' } },
              { id: 'y', type: 'hero', data: { title: 9 } },
            ],
          },
        },
      ],
    });
    expect(paths(r)).toEqual(['sections.0.data.items.1.data.title']);
    expect(issuesOf(r)[0]!.path).toEqual(['sections', 0, 'data', 'items', 1, 'data', 'title']);
  });

  it('rejects a block type allowed at the outer level but not in the nested zone', async () => {
    const r = await validatePage({
      sections: [{ id: 'col', type: 'columns', data: { items: [{ id: 'z', type: 'columns', data: {} }] } }],
    });
    expect(paths(r)).toEqual(['sections.0.data.items.0.type']);
  });

  it('normalises null nested zones to [] too', async () => {
    const r = await validatePage({ sections: [{ id: 'col', type: 'columns', data: { items: null } }] });
    expect(r).toEqual({ ok: true, data: { sections: [{ id: 'col', type: 'columns', data: { items: [] } }] } });
  });

  it(`enforces the nesting depth limit (${MAX_BLOCK_DEPTH})`, async () => {
    const loop = coll('loop', [blocksField('inner', ['loop'])]);
    const fields = [blocksField('root', ['loop'])];
    const blockTemplates = await resolveBlockTemplates(fields, (n) => getCompiledFrom([loop], n));
    const nest = (levels: number): unknown[] =>
      levels === 0 ? [] : [{ id: `l${levels}`, type: 'loop', data: { inner: nest(levels - 1) } }];

    expect(validateItem(fields, { root: nest(MAX_BLOCK_DEPTH) }, { blockTemplates }).ok).toBe(true);
    const deep = validateItem(fields, { root: nest(MAX_BLOCK_DEPTH + 1) }, { blockTemplates });
    const issue = issuesOf(deep)[0]!;
    expect(issue.code).toBe('too_big');
    expect(issue.path!.filter((p) => p === 'inner')).toHaveLength(MAX_BLOCK_DEPTH);
  });
});

describe('blocks — reorder / insert / remove round-trips', () => {
  const a = { id: 'a', type: 'hero', data: { title: 'A' } };
  const b = { id: 'b', type: 'cta', data: { label: 'B' } };
  const c = { id: 'c', type: 'hero', data: { title: 'C', subtitle: 's' } };

  it.each([
    ['reorder', [c, a, b]],
    ['insert in the middle', [a, { id: 'n', type: 'cta', data: { label: 'N' } }, b, c]],
    ['remove', [a, c]],
    ['remove all', []],
  ])('%s keeps exactly the submitted order and content', async (_label, sections) => {
    const r = await validatePage({ sections }, { partial: true });
    expect(r).toEqual({ ok: true, data: { sections } });
    // Validating the output again is a fixed point.
    if (r.ok) expect(await validatePage(r.data, { partial: true })).toEqual(r);
  });

  it('an inserted block without an id gets one; others keep theirs', async () => {
    const r = await validatePage({ sections: [a, { type: 'cta', data: { label: 'new' } }, b] });
    if (!r.ok) throw new Error('unexpected');
    const ids = (r.data.sections as Array<{ id: string }>).map((s) => s.id);
    expect(ids[0]).toBe('a');
    expect(ids[2]).toBe('b');
    expect(ids[1]).not.toBe('');
  });

  it('cta fixture sanity: template has the expected fields', () => {
    expect(cta.fields.map((f) => f.name)).toEqual(['label', 'url']);
  });
});
