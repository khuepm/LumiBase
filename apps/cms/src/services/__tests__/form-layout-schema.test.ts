import { describe, expect, it, vi } from 'vitest';
import {
  MAX_LAYOUT_DEPTH,
  parseFormLayout,
  placedFields,
  renameFieldInLayout,
  resolveFormVisibility,
  validateFormLayout,
  type FormLayout,
  type LayoutNode,
} from '@lumibase/contracts/form-layout';
import { SchemaService, SchemaServiceError } from '../schema-service';

const FIELDS = ['title', 'kind', 'url', 'body', 'seo_title'];

const sample: FormLayout = {
  version: 1,
  nodes: [
    {
      type: 'tab',
      id: 'content',
      label: 'Content',
      children: [
        { type: 'field', field: 'title' },
        { type: 'field', field: 'kind' },
        {
          type: 'group',
          id: 'link',
          label: 'Link',
          collapsible: true,
          visibleWhen: { field: 'kind', op: 'eq', value: 'link' },
          skipRequiredWhenHidden: true,
          children: [{ type: 'field', field: 'url' }],
        },
      ],
    },
    { type: 'divider', id: 'sep', label: 'More' },
    { type: 'tab', id: 'seo', label: 'SEO', children: [{ type: 'field', field: 'seo_title', hiddenValue: 'clear' }] },
  ],
};

const codes = (input: unknown, fields = FIELDS) => {
  const r = validateFormLayout(input, fields);
  return r.ok ? [] : r.issues.map((i) => i.code);
};

describe('validateFormLayout', () => {
  it('accepts a well-formed layout and an empty one', () => {
    expect(validateFormLayout(sample, FIELDS)).toMatchObject({ ok: true });
    expect(validateFormLayout({ version: 1, nodes: [] }, [])).toMatchObject({ ok: true });
  });

  it('rejects a field placed twice', () => {
    const dup = structuredClone(sample);
    dup.nodes.push({ type: 'field', field: 'title' });
    expect(codes(dup)).toEqual(['DUPLICATE_FIELD']);
  });

  it('rejects unknown field keys in placements and in conditions', () => {
    expect(codes({ version: 1, nodes: [{ type: 'field', field: 'nope' }] })).toEqual(['UNKNOWN_FIELD']);
    expect(
      codes({ version: 1, nodes: [{ type: 'divider', id: 'd', visibleWhen: { field: 'ghost', op: 'empty' } }] }),
    ).toEqual(['UNKNOWN_CONDITION_FIELD']);
  });

  it('rejects duplicate node ids', () => {
    expect(
      codes({
        version: 1,
        nodes: [
          { type: 'tab', id: 'x', label: 'A', children: [] },
          { type: 'group', id: 'x', children: [] },
        ],
      }),
    ).toEqual(['DUPLICATE_NODE_ID']);
  });

  it('rejects a field conditioned on its own value', () => {
    expect(
      codes({ version: 1, nodes: [{ type: 'field', field: 'url', visibleWhen: { field: 'url', op: 'nempty' } }] }),
    ).toEqual(['SELF_REFERENCE']);
  });

  it('rejects nesting deeper than the limit', () => {
    let node: LayoutNode = { type: 'field', field: 'title' };
    for (let i = 0; i <= MAX_LAYOUT_DEPTH; i++) node = { type: 'group', id: `g${i}`, children: [node] };
    expect(codes({ version: 1, nodes: [node] })).toContain('TOO_DEEP');
  });

  it.each([
    [{ version: 2, nodes: [] }, 'wrong version'],
    [{ version: 1 }, 'missing nodes'],
    [{ version: 1, nodes: [{ type: 'columns', id: 'c', children: [] }] }, 'unknown node type'],
    [{ version: 1, nodes: [{ type: 'tab', id: 't', children: [] }] }, 'tab without label'],
    [{ version: 1, nodes: [{ type: 'group', id: 'Bad Id', children: [] }] }, 'bad node id'],
    [{ version: 1, nodes: [{ type: 'field', field: 'title', extra: 1 }] }, 'unknown key'],
    [{ version: 1, nodes: [{ type: 'field', field: 'title', hiddenValue: 'nuke' }] }, 'bad hiddenValue'],
    [{ version: 1, nodes: [{ type: 'divider', id: 'd', children: [] }] }, 'divider with children'],
    [{ version: 1, nodes: [{ type: 'field', field: 'title', visibleWhen: 'kind == 1' }] }, 'string expression'],
  ])('rejects %j (%s) as SCHEMA', (input, _why) => {
    expect(codes(input)).toEqual(expect.arrayContaining(['SCHEMA']));
  });
});

describe('parseFormLayout / resolveFormVisibility', () => {
  it('ignores missing or broken stored layouts (fail closed to no layout)', () => {
    expect(parseFormLayout(undefined)).toBeNull();
    expect(parseFormLayout({ version: 1, nodes: 'x' })).toBeNull();
    expect(parseFormLayout(sample)).toEqual(sample);
  });

  it('hides a group subtree and inherits its flags', () => {
    const v = resolveFormVisibility(sample, { kind: 'text' });
    expect(v.hiddenNodes.has('link')).toBe(true);
    expect(v.fields.get('url')).toEqual({ hidden: true, skipRequiredWhenHidden: true, hiddenValue: 'keep' });
    expect(v.fields.get('seo_title')).toEqual({ hidden: false, skipRequiredWhenHidden: false, hiddenValue: 'clear' });
    expect(resolveFormVisibility(sample, { kind: 'link' }).fields.get('url')?.hidden).toBe(false);
  });

  it('lists placements in document order', () => {
    expect(placedFields(sample)).toEqual(['title', 'kind', 'url', 'seo_title']);
  });

  it('renameFieldInLayout rewrites placements and condition references', () => {
    const renamed = renameFieldInLayout(sample, 'kind', 'variant');
    expect(placedFields(renamed)).toContain('variant');
    expect(JSON.stringify(renamed)).not.toContain('"kind"');
    expect(validateFormLayout(renamed, FIELDS.map((f) => (f === 'kind' ? 'variant' : f)))).toMatchObject({ ok: true });
  });
});

describe('SchemaService form layout', () => {
  function service(meta: Record<string, unknown> = {}) {
    const svc = new SchemaService({ db: {} as never, siteId: 'site_1' });
    const collection = { id: 'col_1', name: 'posts', meta };
    vi.spyOn(svc, 'getCollection').mockResolvedValue(collection as never);
    vi.spyOn(svc, 'listFields').mockResolvedValue(FIELDS.map((name) => ({ name })) as never);
    const update = vi.spyOn(svc, 'updateCollection').mockResolvedValue(collection as never);
    return { svc, update };
  }

  it('getFormLayout returns the stored layout or null', async () => {
    expect(await service({ formLayout: sample }).svc.getFormLayout('posts')).toEqual(sample);
    expect(await service({}).svc.getFormLayout('posts')).toBeNull();
  });

  it('setFormLayout validates against the collection fields and preserves other meta keys', async () => {
    const { svc, update } = service({ editorialWorkflow: true });
    await expect(svc.setFormLayout('posts', sample)).resolves.toEqual(sample);
    expect(update).toHaveBeenCalledWith('posts', { meta: { editorialWorkflow: true, formLayout: sample } });
  });

  it('setFormLayout(null) removes the layout', async () => {
    const { svc, update } = service({ formLayout: sample, editorialWorkflow: true });
    await expect(svc.setFormLayout('posts', null)).resolves.toBeNull();
    expect(update).toHaveBeenCalledWith('posts', { meta: { editorialWorkflow: true } });
  });

  it('setFormLayout refuses duplicates / unknown keys with INVALID_FORM_LAYOUT (400)', async () => {
    const { svc, update } = service();
    const bad = { version: 1, nodes: [{ type: 'field', field: 'title' }, { type: 'field', field: 'title' }, { type: 'field', field: 'ghost' }] };
    const err = await svc.setFormLayout('posts', bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaServiceError);
    expect(err).toMatchObject({ code: 'INVALID_FORM_LAYOUT', status: 400 });
    expect((err as Error).message).toMatch(/more than once/);
    expect((err as Error).message).toMatch(/Unknown field "ghost"/);
    expect(update).not.toHaveBeenCalled();
  });

  it('updateCollection rejects an invalid meta.formLayout before writing', async () => {
    const svc = new SchemaService({ db: { update: vi.fn() } as never, siteId: 'site_1' });
    vi.spyOn(svc, 'getCollection').mockResolvedValue({ id: 'col_1', name: 'posts', primaryKeyType: 'nanoid', storageMode: 'jsonb' } as never);
    vi.spyOn(svc, 'listFields').mockResolvedValue([{ name: 'title' }] as never);
    await expect(
      svc.updateCollection('posts', { meta: { formLayout: { version: 1, nodes: [{ type: 'field', field: 'ghost' }] } } }),
    ).rejects.toMatchObject({ code: 'INVALID_FORM_LAYOUT' });
  });

  it('createCollection only accepts an empty layout (no fields exist yet)', async () => {
    const svc = new SchemaService({ db: {} as never, siteId: 'site_1' });
    await expect(
      svc.createCollection({ name: 'posts', meta: { formLayout: { version: 1, nodes: [{ type: 'field', field: 'title' }] } } }),
    ).rejects.toMatchObject({ code: 'INVALID_FORM_LAYOUT' });
  });
});
