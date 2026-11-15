import { describe, expect, it } from 'vitest';
import { validateFieldOptions, FieldOptionParitySchema } from '@lumibase/contracts/schemas';
import { validateItem } from '../validation';
import { assertFieldOptionsValid, SchemaServiceError, type CompiledField } from '../schema-service';

/**
 * #751 — field option parity: `allowClear`, `minLength`/`maxLength`, slug
 * charset policy. Covers (1) option validation on schema write and (2) the
 * item-write enforcement matrix in the single validation chokepoint that
 * ItemService (REST, GraphQL, MCP/agent, bulk, revert) runs.
 */

function field(
  name: string,
  type: string,
  iface: string,
  options: Record<string, unknown> = {},
  extra: Partial<CompiledField> = {},
): CompiledField {
  return {
    id: `f-${name}`,
    name,
    type,
    interface: iface,
    display: null,
    label: null,
    note: null,
    defaultValue: null,
    nullable: true,
    unique: false,
    indexed: false,
    searchable: false,
    length: null,
    precision: null,
    scale: null,
    special: [],
    translations: {},
    options,
    displayOptions: {},
    validation: {},
    conditions: [],
    required: false,
    readonly: false,
    hidden: false,
    encrypted: false,
    classification: 'none',
    versioned: false,
    rawEnabled: false,
    width: 'full',
    group: null,
    sortOrder: 0,
    ...extra,
  };
}

describe('field options — schema-write validation', () => {
  it('accepts the documented shapes', () => {
    expect(validateFieldOptions({ type: 'string', interface: 'select-radio', options: { allowClear: false, choices: [] } })).toEqual([]);
    expect(validateFieldOptions({ type: 'text', interface: 'input-multiline', options: { minLength: 10, maxLength: 2000, rows: 4 } })).toEqual([]);
    expect(validateFieldOptions({ type: 'string', interface: 'slug', options: { slug: { charset: 'ascii' } } })).toEqual([]);
    expect(validateFieldOptions({ type: 'string', interface: 'slug', options: { slug: { charset: 'unicode', lowercase: false, separator: '_' } } })).toEqual([]);
    expect(validateFieldOptions({ type: 'string', interface: 'slug', options: { slug: { charset: 'custom', pattern: '^[a-z0-9][a-z0-9-]*$' } } })).toEqual([]);
  });

  it('leaves existing option payloads (no #751 keys) untouched', () => {
    expect(validateFieldOptions({ type: 'string', interface: 'input', options: { trim: true, clear: true } })).toEqual([]);
    expect(validateFieldOptions({ type: 'string', interface: 'input', options: undefined })).toEqual([]);
  });

  it.each([
    [{ allowClear: 'no' }, 'options.allowClear'],
    [{ maxLength: 0 }, 'options.maxLength'],
    [{ maxLength: 1.5 }, 'options.maxLength'],
    [{ minLength: -1 }, 'options.minLength'],
    [{ maxLength: 2_000_000 }, 'options.maxLength'],
    [{ minLength: 10, maxLength: 5 }, 'options.minLength'],
    [{ slug: { charset: 'emoji' } }, 'options.slug.charset'],
    [{ slug: { charset: 'custom' } }, 'options.slug.pattern'],
    [{ slug: { charset: 'ascii', pattern: '[a-z]+' } }, 'options.slug.pattern'],
    [{ slug: { charset: 'ascii', separator: '/' } }, 'options.slug.separator'],
    [{ slug: { charset: 'ascii', extra: 1 } }, 'options.slug'],
  ])('rejects invalid option %j', (options, path) => {
    const issues = validateFieldOptions({ type: 'string', interface: 'slug', options });
    expect(issues.map((i) => i.path)).toContain(path);
  });

  it.each([
    '(a+)+$',
    '^(a|aa)*$',
    '(.*a){12}',
    '\\1',
    '(?=a)a',
    'a**',
    'a{1,1000}',
    '[a-z]{100}[a-z]{100}[a-z]{100}[a-z]{100}[a-z]{100}[a-z]{100}',
    'a'.repeat(201),
    '[abc',
    '\\bfoo',
  ])('rejects unsafe or unsupported custom slug pattern %s', (pattern) => {
    const issues = validateFieldOptions({
      type: 'string',
      interface: 'slug',
      options: { slug: { charset: 'custom', pattern } },
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.path).toBe('options.slug.pattern');
  });

  it('rejects allowClear on a non single-choice interface', () => {
    const issues = validateFieldOptions({ type: 'string', interface: 'input', options: { allowClear: false } });
    expect(issues[0]!.message).toMatch(/single-choice/);
  });

  it('rejects slug policy on a non-text type', () => {
    const issues = validateFieldOptions({ type: 'integer', interface: 'input-number', options: { slug: { charset: 'ascii' } } });
    expect(issues[0]!.path).toBe('options.slug');
  });

  it('rejects maxLength above the field storage length', () => {
    const issues = validateFieldOptions({ type: 'string', interface: 'input', options: { maxLength: 300 }, length: 255 });
    expect(issues[0]!.message).toMatch(/storage length \(255\)/);
    expect(validateFieldOptions({ type: 'string', interface: 'input', options: { maxLength: 255 }, length: 255 })).toEqual([]);
  });

  it('keeps unknown interface keys (open record)', () => {
    const parsed = FieldOptionParitySchema.parse({ choices: [{ value: 'a' }], allowClear: true });
    expect(parsed).toMatchObject({ choices: [{ value: 'a' }], allowClear: true });
  });

  it('SchemaService chokepoint throws INVALID_FIELD_OPTIONS (422)', () => {
    let err: unknown;
    try {
      assertFieldOptionsValid({ name: 'slug', type: 'string', interface: 'slug', options: { slug: { charset: 'custom', pattern: '(a+)+' } } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SchemaServiceError);
    expect((err as SchemaServiceError).code).toBe('INVALID_FIELD_OPTIONS');
    expect((err as SchemaServiceError).status).toBe(422);
    expect((err as SchemaServiceError).message).toContain('Field "slug"');
    expect(() => assertFieldOptionsValid({ name: 'x', type: 'string', interface: 'input', options: { maxLength: 10 } })).not.toThrow();
  });
});

describe('item write — text length (code points)', () => {
  const fields = [field('excerpt', 'text', 'input-multiline', { minLength: 3, maxLength: 5 })];

  it('counts Unicode code points, not UTF-16 units', () => {
    // 5 emoji = 10 UTF-16 units but 5 code points → allowed.
    expect(validateItem(fields, { excerpt: '😀😀😀😀😀' }).ok).toBe(true);
    // Vietnamese NFC letters are one code point each.
    expect(validateItem(fields, { excerpt: 'Việt' }).ok).toBe(true);
  });

  it('rejects over-length with a message naming field and limit', () => {
    const r = validateItem(fields, { excerpt: '😀😀😀😀😀😀' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]).toMatchObject({ field: 'excerpt', code: 'too_long' });
    expect(r.issues[0]!.message).toBe(
      'Field "excerpt" must be at most 5 characters (Unicode code points); received 6.',
    );
  });

  it('rejects under-length, but treats "" and null as no value', () => {
    const r = validateItem(fields, { excerpt: 'ab' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatchObject({ code: 'too_short' });
    expect(validateItem(fields, { excerpt: '' }).ok).toBe(true);
    expect(validateItem(fields, { excerpt: null }).ok).toBe(true);
  });

  it('enforces on partial (update) writes too', () => {
    expect(validateItem(fields, { excerpt: 'abcdef' }, { partial: true }).ok).toBe(false);
    expect(validateItem(fields, { other: 1 }, { partial: true }).ok).toBe(true);
  });

  it('does not enforce length on non-text types (pre-#751 loose key)', () => {
    const f = [field('n', 'integer', 'input-number', { maxLength: 1 })];
    expect(validateItem(f, { n: 12345 }).ok).toBe(true);
  });

  it('fields without the options keep previous behaviour', () => {
    const f = [field('title', 'string', 'input')];
    expect(validateItem(f, { title: 'x'.repeat(100_000) }).ok).toBe(true);
  });
});

describe('item write — slug charset policy', () => {
  const ascii = [field('slug', 'string', 'slug', { slug: { charset: 'ascii' } })];
  const unicode = [field('slug', 'string', 'slug', { slug: { charset: 'unicode' } })];
  const custom = [field('slug', 'string', 'slug', { slug: { charset: 'custom', pattern: '^[a-z]{2}/[a-z0-9-]+$' } })];
  const legacy = [field('slug', 'string', 'slug', { source: 'title' })];

  it.each([
    [ascii, 'tieng-viet', true],
    [ascii, 'tiếng-việt', false],
    [ascii, 'Tieng-Viet', false],
    [ascii, '-lead', false],
    [ascii, 'a--b', false],
    [unicode, 'tiếng-việt', true],
    [unicode, '東京-2026', true],
    [unicode, 'Tiếng-Việt', false],
    [unicode, 'a b', false],
    [custom, 'vi/xin-chao', true],
    [custom, 'vi/Xin', false],
    [custom, 'vie/xin', false],
    [legacy, 'Anything Goes!', true],
  ])('%#: %j accepts "%s" → %s', (f, value, ok) => {
    const r = validateItem(f as CompiledField[], { slug: value });
    expect(r.ok).toBe(ok);
    if (!r.ok) expect(r.issues[0]!.code).toBe('invalid_slug');
  });

  it('empty slug is left to `required`', () => {
    expect(validateItem(ascii, { slug: '' }).ok).toBe(true);
    expect(validateItem(ascii, { slug: null }).ok).toBe(true);
  });
});

describe('item write — allowClear on single-choice fields', () => {
  const radio = (opts: Record<string, unknown>, extra: Partial<CompiledField> = {}) =>
    [field('tone', 'string', 'select-radio', { choices: [{ value: 'a' }, { value: 'b' }], ...opts }, extra)];
  const current = { tone: 'a' };

  it.each([
    // [options, current, patch, ok]
    [{ allowClear: false }, current, { tone: null }, false],
    [{ allowClear: false }, current, { tone: '' }, false],
    [{ allowClear: false }, current, { tone: 'b' }, true],
    [{ allowClear: false }, { tone: null }, { tone: null }, true],
    [{ allowClear: false }, {}, { tone: null }, true],
    [{ allowClear: false }, current, { other: 1 }, true],
    [{ allowClear: true }, current, { tone: null }, true],
    [{}, current, { tone: null }, true],
  ])('%j current=%j patch=%j → ok=%s', (opts, cur, patch, ok) => {
    const r = validateItem(radio(opts), patch, { partial: true, current: cur });
    expect(r.ok).toBe(ok);
    if (!r.ok) {
      expect(r.issues[0]).toMatchObject({ field: 'tone', code: 'not_clearable' });
      expect(r.issues[0]!.message).toContain('allowClear: false');
    }
  });

  it('applies to select-dropdown too', () => {
    const f = [field('tone', 'string', 'select-dropdown', { allowClear: false })];
    expect(validateItem(f, { tone: null }, { partial: true, current }).ok).toBe(false);
  });

  it('create (no stored value) may leave a non-clearable field empty', () => {
    expect(validateItem(radio({ allowClear: false }), { tone: null }).ok).toBe(true);
  });

  it('required already rejects null regardless of allowClear', () => {
    const r = validateItem(radio({ allowClear: true }, { required: true }), { tone: null }, { partial: true, current });
    expect(r.ok).toBe(false);
  });
});
