import Ajv2020Module from 'ajv/dist/2020.js';
import AjvDraft07Module from 'ajv';
import addFormatsModule from 'ajv-formats';

/**
 * JSON Schema helpers for the tool-schema fidelity suite (#716).
 *
 * Two dialects reach an MCP client from LumiBase:
 *   - stdio (`@modelcontextprotocol/sdk` McpServer) stamps every input schema
 *     with `$schema: draft-07`;
 *   - HTTP (`POST /api/v1/mcp`) advertises `z.toJSONSchema` output with the
 *     `$schema` key stripped, which MCP clients read as 2020-12.
 *
 * A schema is accepted here only if it compiles under BOTH dialects with Ajv's
 * strict mode on. Strict mode is what turns "a keyword the client does not know"
 * (`prefixItems` read as draft-07, a typo'd `minLenght`, `nullable: true` OpenAPI
 * leftovers) into a failure instead of a silently ignored constraint.
 */

type AjvInstance = {
  compile: (schema: object) => ((data: unknown) => boolean) & { errors?: unknown[] | null };
  validateSchema: (schema: object) => boolean | Promise<unknown>;
  errorsText: (errors?: unknown) => string;
  errors?: unknown[] | null;
};
type AjvCtor = new (opts: Record<string, unknown>) => AjvInstance;
type AddFormats = (ajv: AjvInstance) => unknown;

// ajv ships CJS with a `default` export; under ESM interop the constructor sits
// on either the namespace or its `default`, depending on the loader.
const pick = <T>(mod: unknown): T => ((mod as { default?: T }).default ?? mod) as T;
const Ajv2020 = pick<AjvCtor>(Ajv2020Module);
const AjvDraft07 = pick<AjvCtor>(AjvDraft07Module);
const addFormats = pick<AddFormats>(addFormatsModule);

function make(Ctor: AjvCtor): AjvInstance {
  const ajv = new Ctor({ strict: true, allErrors: true, validateFormats: true });
  addFormats(ajv);
  return ajv;
}

export const ajv2020 = make(Ajv2020);
export const ajvDraft07 = make(AjvDraft07);

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

/** The dialect a schema declares; no `$schema` means 2020-12 (MCP default). */
export function dialectOf(schema: Record<string, unknown>): 'draft-07' | '2020-12' {
  return schema['$schema'] === DRAFT_07 ? 'draft-07' : '2020-12';
}

function withoutDialect(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _drop, ...rest } = schema;
  return rest;
}

/**
 * Problems that make `schema` unusable as an MCP tool input schema, or `[]`.
 * Checks the meta-schema, strict compilation in both dialects, and the MCP
 * requirement that a tool's `inputSchema` is an object schema.
 */
export function schemaProblems(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return ['inputSchema is not an object'];
  const s = schema as Record<string, unknown>;
  const problems: string[] = [];
  if (s['type'] !== 'object') problems.push(`inputSchema.type is ${JSON.stringify(s['type'])}, MCP requires "object"`);
  const bare = withoutDialect(s);
  for (const [label, ajv] of [
    ['draft-07', ajvDraft07],
    ['2020-12', ajv2020],
  ] as const) {
    if (ajv.validateSchema(bare) !== true) {
      problems.push(`${label} meta-schema: ${ajv.errorsText(ajv.errors)}`);
      continue;
    }
    try {
      ajv.compile(bare);
    } catch (err) {
      problems.push(`${label} strict compile: ${(err as Error).message}`);
    }
  }
  return problems;
}

type Validate = ((data: unknown) => boolean) & { errors?: unknown[] | null };
const compiled = new WeakMap<object, Validate>();

function validatorFor(schema: Record<string, unknown>): Validate {
  let validate = compiled.get(schema);
  if (!validate) {
    const ajv = dialectOf(schema) === 'draft-07' ? ajvDraft07 : ajv2020;
    validate = ajv.compile(withoutDialect(schema));
    compiled.set(schema, validate);
  }
  return validate;
}

/** Does `value` satisfy `schema`, in the dialect the schema declares? */
export function schemaAccepts(schema: Record<string, unknown>, value: unknown): boolean {
  return validatorFor(schema)(value);
}

/**
 * The top-level properties `value` violates `schema` at (`/rules`, `/` for the
 * root), or `[]` when it is accepted. Lets an accepted gap be scoped to one key
 * instead of silencing a whole tool.
 */
export function rejectedAt(schema: Record<string, unknown>, value: unknown): string[] {
  const validate = validatorFor(schema);
  if (validate(value)) return [];
  const paths = ((validate.errors ?? []) as Array<{ instancePath: string; params?: { missingProperty?: string } }>).map(
    (e) => {
      const top = e.instancePath.split('/')[1];
      if (top !== undefined) return `/${top}`;
      return e.params?.missingProperty ? `/${e.params.missingProperty}` : '/';
    },
  );
  return [...new Set(paths)].sort();
}

type Json = Record<string, unknown>;

/** Strings tried, in order, against a `pattern` with no better hint. */
const PATTERN_CANDIDATES = ['posts', 'abc', 'a', 'x1', '0 * * * *', 'en', 'abc-123', 'a:b', 'A1', 'ab'.repeat(32)];

function stringFor(key: string, s: Json): string {
  const format = s['format'];
  if (format === 'email') return 'editor@example.com';
  if (format === 'uri' || format === 'url') return 'https://example.com/a.js';
  if (format === 'date-time') return '2026-01-01T00:00:00.000Z';
  if (format === 'date') return '2026-01-01';
  if (format === 'uuid') return '0190a2b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
  const pattern = typeof s['pattern'] === 'string' ? new RegExp(s['pattern'] as string, 'u') : null;
  // Keys whose Zod contract carries a `.refine()` the JSON Schema cannot show.
  const hinted = /url$/i.test(key)
    ? 'https://example.com/a.js'
    : /schedule|cron/i.test(key)
      ? '0 * * * *'
      : /(At|After|Before)$/.test(key)
        ? '2026-01-01T00:00:00.000Z'
        : /email/i.test(key)
          ? 'editor@example.com'
          : null;
  const candidates = [...(hinted ? [hinted] : []), ...PATTERN_CANDIDATES];
  const min = typeof s['minLength'] === 'number' ? (s['minLength'] as number) : 0;
  for (const c of candidates) {
    if (c.length < min) continue;
    if (pattern && !pattern.test(c)) continue;
    return c;
  }
  throw new Error(`no sample string for "${key}" (pattern ${String(s['pattern'])})`);
}

/**
 * A minimal value that `schema` accepts: required keys only, first enum member,
 * first non-null `anyOf` branch. Deterministic, so a fidelity failure always
 * reproduces with the same payload.
 */
export function sampleFor(schema: unknown, key = ''): unknown {
  return sample(schema, key, false);
}

/**
 * Like {@link sampleFor}, but every declared property is present, at every
 * depth, and every array holds one element. Used to prove a handler forwards
 * each advertised key and the server accepts each one.
 */
export function fullSampleFor(schema: unknown, key = ''): unknown {
  return sample(schema, key, true);
}

function sample(schema: unknown, key: string, full: boolean): unknown {
  const s = (schema ?? {}) as Json;
  if ('const' in s) return s['const'];
  if (Array.isArray(s['enum'])) return (s['enum'] as unknown[])[0];
  const branches = (s['anyOf'] ?? s['oneOf']) as unknown[] | undefined;
  if (Array.isArray(branches)) {
    const nonNull = branches.find((b) => (b as Json)['type'] !== 'null') ?? branches[0];
    return sample(nonNull, key, full);
  }
  const type = Array.isArray(s['type']) ? (s['type'] as string[]).find((t) => t !== 'null') : s['type'];
  switch (type) {
    case 'string':
      return stringFor(key, s);
    case 'integer':
    case 'number': {
      const min = (s['minimum'] as number | undefined) ?? ((s['exclusiveMinimum'] as number | undefined) ?? 0) + 1;
      return Math.max(1, min);
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array': {
      const n = Math.max((s['minItems'] as number | undefined) ?? 0, full ? 1 : 0);
      return Array.from({ length: n }, () => sample(s['items'], key, full));
    }
    case 'object': {
      const props = (s['properties'] ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const keys = full ? Object.keys(props) : ((s['required'] ?? []) as string[]);
      for (const k of keys) out[k] = sample(props[k], k, full);
      return out;
    }
    default:
      return 'x';
  }
}

/** Values every optional property is probed with in the differential check. */
export const PROBES: ReadonlyArray<unknown> = [
  null,
  '',
  'x',
  0,
  1.5,
  true,
  [],
  ['x'],
  // Invalid array elements (#716 review): `[""]` passed stdio while the
  // server's `z.string().min(1)` items refused it; wrong-typed elements too.
  [''],
  [0],
  [null],
  [{}],
  {},
  { a: 1 },
];

/** Every enum / const value a property can take, including inside an array's items. */
function enumValues(schema: unknown): unknown[] {
  const s = (schema ?? {}) as Json;
  const out: unknown[] = [];
  if ('const' in s) out.push(s['const']);
  if (Array.isArray(s['enum'])) out.push(...(s['enum'] as unknown[]));
  for (const b of ((s['anyOf'] ?? s['oneOf'] ?? []) as unknown[])) out.push(...enumValues(b));
  return out;
}

/**
 * {@link PROBES} plus every member of the property's enum (each alone, and each
 * as a one-element array when the enum sits on array items). The first-member
 * sampler alone never sent `kind: "webhook"`, so a schema that is only valid
 * for `pull` passed (#716 review).
 */
export function probesFor(property: unknown): unknown[] {
  const p = (property ?? {}) as Json;
  const values = enumValues(p);
  const items = enumValues(p['items']);
  return [...PROBES, ...values, ...items.map((v) => [v])];
}

// ── structural comparison of an advertised schema with a server schema ──────

const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'];

function branches(s: Json): Json[] {
  const list = (s['anyOf'] ?? s['oneOf']) as Json[] | undefined;
  return Array.isArray(list) ? list.flatMap(branches) : [s];
}

/** JSON types a schema admits, or `'any'` when it does not constrain the type. */
export function typesOf(schema: unknown): Set<string> | 'any' {
  const out = new Set<string>();
  for (const b of branches((schema ?? {}) as Json)) {
    if ('const' in b) {
      const v = b['const'];
      out.add(v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
      continue;
    }
    const t = b['type'];
    if (typeof t === 'string') out.add(t);
    else if (Array.isArray(t)) for (const x of t as string[]) out.add(x);
    else if (Array.isArray(b['enum'])) for (const v of b['enum'] as unknown[]) out.add(v === null ? 'null' : typeof v);
    else return 'any';
  }
  return out;
}

function nonNull(s: Json): Json[] {
  return branches(s).filter((b) => b['type'] !== 'null' && !(Array.isArray(b['type']) && (b['type'] as string[]).every((t) => t === 'null')));
}

/** Finite set of values, when every non-null branch is an enum or const. */
function finiteValues(s: Json): unknown[] | null {
  const out: unknown[] = [];
  for (const b of nonNull(s)) {
    if ('const' in b) out.push(b['const']);
    else if (Array.isArray(b['enum'])) out.push(...(b['enum'] as unknown[]));
    else return null;
  }
  return out.length > 0 ? out : null;
}

interface ObjectView {
  /** Property name → every schema any object branch gives it. */
  props: Map<string, Json[]>;
  /** Required keys, when exactly one object branch exists. */
  required: string[] | null;
  /** No `properties` at all: an open record or `{}` that forwards any key. */
  open: boolean;
}

function objectView(s: Json): ObjectView | null {
  const objects = nonNull(s).filter((b) => b['type'] === 'object' || 'properties' in b ||
    (Array.isArray(b['type']) && (b['type'] as string[]).includes('object')));
  if (objects.length === 0) return null;
  const props = new Map<string, Json[]>();
  let open = false;
  for (const o of objects) {
    if (!o['properties']) open = true;
    for (const [k, v] of Object.entries((o['properties'] ?? {}) as Record<string, Json>)) {
      props.set(k, [...(props.get(k) ?? []), v]);
    }
  }
  const required = objects.length === 1 ? ((objects[0]!['required'] ?? []) as string[]) : null;
  return { props, required, open };
}

function arrayItems(s: Json): Json | null {
  const items = nonNull(s)
    .filter((b) => b['type'] === 'array' || (Array.isArray(b['type']) && (b['type'] as string[]).includes('array')))
    .map((b) => (b['items'] ?? {}) as Json);
  if (items.length === 0) return null;
  return items.length === 1 ? items[0]! : { anyOf: items };
}

const merge = (list: Json[]): Json => (list.length === 1 ? list[0]! : { anyOf: list });

/**
 * Where an advertised (tool) schema and a server (route) schema disagree on
 * shape, recursively through object properties and array items:
 *   - `server-only`: a key the server accepts that the tool does not advertise
 *     (a schema-respecting client can never send it; an SDK strips it);
 *   - `advertised-only`: a key the tool advertises that the server's schema
 *     does not declare (Zod strips it: the call "succeeds" without effect);
 *   - `type`: the tool admits a JSON type the server refuses;
 *   - `enum`: the tool admits a value outside the server's enum;
 *   - `required`: the server requires a key the tool marks optional.
 * Open records (`properties` absent) on either side forward any key, so key
 * sets below them are not compared. Value constraints (`minLength`, patterns,
 * refinements) are the differential probe's job, not this function's.
 */
export function shapeMismatches(advertised: unknown, server: unknown, path = ''): string[] {
  const a = (advertised ?? {}) as Json;
  const s = (server ?? {}) as Json;
  const out: string[] = [];
  const at = path || '<body>';

  const ta = typesOf(a);
  const ts = typesOf(s);
  if (ts !== 'any') {
    if (ta === 'any') out.push(`type ${at}: advertised any, server ${[...ts].join('|')}`);
    else {
      const loose = [...ta].filter((t) => SCALAR_TYPES.includes(t) && !ts.has(t) && !(t === 'integer' && ts.has('number')));
      if (loose.length > 0) out.push(`type ${at}: advertised ${loose.join('|')}, server ${[...ts].join('|')}`);
    }
  }

  const serverValues = finiteValues(s);
  if (serverValues) {
    const advertisedValues = finiteValues(a);
    const extra = advertisedValues
      ? advertisedValues.filter((v) => !serverValues.some((sv) => JSON.stringify(sv) === JSON.stringify(v)))
      : ['<any>'];
    if (extra.length > 0) out.push(`enum ${at}: advertised ${extra.map((v) => JSON.stringify(v)).join(',')} outside server enum`);
  }

  const oa = objectView(a);
  const os = objectView(s);
  if (oa && os && !oa.open && !os.open) {
    for (const key of os.props.keys()) if (!oa.props.has(key)) out.push(`server-only ${path ? `${path}.` : ''}${key}`);
    for (const key of oa.props.keys()) if (!os.props.has(key)) out.push(`advertised-only ${path ? `${path}.` : ''}${key}`);
    if (oa.required && os.required) {
      for (const key of os.required) {
        if (oa.props.has(key) && !oa.required.includes(key)) out.push(`required ${path ? `${path}.` : ''}${key}`);
      }
    }
    for (const [key, list] of oa.props) {
      const theirs = os.props.get(key);
      if (theirs) out.push(...shapeMismatches(merge(list), merge(theirs), path ? `${path}.${key}` : key));
    }
  }

  const ia = arrayItems(a);
  const is = arrayItems(s);
  if (ia && is) out.push(...shapeMismatches(ia, is, `${path}[]`));
  return out;
}
