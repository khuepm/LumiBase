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

const compiled = new WeakMap<object, (data: unknown) => boolean>();

/** Does `value` satisfy `schema`, in the dialect the schema declares? */
export function schemaAccepts(schema: Record<string, unknown>, value: unknown): boolean {
  let validate = compiled.get(schema);
  if (!validate) {
    const ajv = dialectOf(schema) === 'draft-07' ? ajvDraft07 : ajv2020;
    validate = ajv.compile(withoutDialect(schema));
    compiled.set(schema, validate);
  }
  return validate(value);
}

type Json = Record<string, unknown>;

/** Strings tried, in order, against a `pattern` with no better hint. */
const PATTERN_CANDIDATES = ['posts', 'abc', 'a', 'x1', '0 * * * *', 'en', 'abc-123', 'a:b', 'A1'];

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
  const s = (schema ?? {}) as Json;
  if ('const' in s) return s['const'];
  if (Array.isArray(s['enum'])) return (s['enum'] as unknown[])[0];
  const branches = (s['anyOf'] ?? s['oneOf']) as unknown[] | undefined;
  if (Array.isArray(branches)) {
    const nonNull = branches.find((b) => (b as Json)['type'] !== 'null') ?? branches[0];
    return sampleFor(nonNull, key);
  }
  switch (s['type']) {
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
      const n = (s['minItems'] as number | undefined) ?? 0;
      return Array.from({ length: n }, () => sampleFor(s['items'], key));
    }
    case 'object': {
      const props = (s['properties'] ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const req of (s['required'] ?? []) as string[]) out[req] = sampleFor(props[req], req);
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
  {},
  { a: 1 },
];
