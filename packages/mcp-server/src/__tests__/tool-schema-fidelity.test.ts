import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { agentToolNamesWithSchema, jsonSchemaFor, validateAgentToolInput } from '@lumibase/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { GOVERNED_TOOLS, toSkillArgs } from '../governed.js';
import { registerAllTools } from '../tools/index.js';
import { FIELD_TYPES, FIELD_TYPES_EXHAUSTIVE, matrix } from './fidelity/field-matrix.js';
import { PROBES, sampleFor, schemaAccepts, schemaProblems } from './fidelity/json-schema.js';

/**
 * Tool-schema fidelity suite (#716).
 *
 * The defect class: an auto-generated MCP tool schema that disagrees with what
 * the server accepts. Payload #16214 advertised nullable relations without
 * `{type:"null"}`; Directus #27039 advertised an array where the server wanted
 * an object. Either way a schema-respecting client cannot send a valid call, or
 * sends one the server then refuses.
 *
 * Where LumiBase's schemas come from (both transports):
 *   - stdio (`packages/mcp-server`): hand-written Zod shapes per tool module,
 *     converted by the MCP SDK (`$schema: draft-07`). Validated server-side by
 *     the SDK with the same Zod; governed tools then go through the harness.
 *   - HTTP (`POST /api/v1/mcp`): `CORE_SKILLS` in `apps/cms` →
 *     `ToolRegistryService` → `McpService`. Write skills advertise
 *     `jsonSchemaFor()` from `@lumibase/contracts`; the harness validates with
 *     `validateAgentToolInput()` over the same Zod. Pinned by the committed
 *     golden `fidelity/golden/http-tools-list.json`, which
 *     `apps/cms/.../mcp-tool-schema-golden.test.ts` proves equal to the live server.
 *   - No transport derives an input schema from collection field definitions:
 *     item tools take `data` as an open record. The field-type matrix therefore
 *     exercises VALUES of every field type through that record (see
 *     `fidelity/field-matrix.ts`), plus the field/relation/collection definition
 *     tools whose arguments are typed.
 *
 * What fails CI here: an invalid JSON Schema (meta-schema or Ajv strict compile,
 * draft-07 and 2020-12), an unreviewed change to either golden, a value the
 * advertised schema and the server judge differently, and a matrix value the
 * transports do not carry through unchanged.
 */

const PACKAGE_DIR = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const HTTP_GOLDEN = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fidelity', 'golden', 'http-tools-list.json'), 'utf8'),
) as { site: Tool[]; organization: Tool[] };

// ── stdio harness ───────────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

function fakeClient() {
  const calls: Recorded[] = [];
  const record = (method: string) => (path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return Promise.resolve({ ok: true });
  };
  const client = {
    tokenKind: 'site',
    readOnly: false,
    get: vi.fn(record('GET')),
    post: vi.fn(record('POST')),
    patch: vi.fn(record('PATCH')),
    put: vi.fn(record('PUT')),
    delete: vi.fn(record('DELETE')),
    getText: vi.fn(() => Promise.resolve('')),
    getRootText: vi.fn(() => Promise.resolve('')),
    postRaw: vi.fn(record('POST_RAW')),
    withSite: <T>(_site: string, fn: () => Promise<T>) => fn(),
  };
  return { client: client as unknown as LumiBaseClient, calls };
}

type Profile = 'site' | 'organization' | 'readOnly';

const PROFILE_OPTIONS: Record<Profile, Parameters<typeof registerAllTools>[2]> = {
  site: { dispatcher: null, tokenKind: 'site', siteId: 'site_fidelity' },
  // An organization key not pinned to a site: every site tool gains `site`.
  organization: { dispatcher: null, tokenKind: 'organization' },
  readOnly: { dispatcher: null, tokenKind: 'site', siteId: 'site_fidelity', readOnly: true },
};

interface Connected {
  client: Client;
  tools: Tool[];
  /** Zod shape each tool registered — what the SDK validates arguments with. */
  shapes: Map<string, Record<string, z.ZodType>>;
  calls: Recorded[];
}

async function connect(profile: Profile): Promise<Connected> {
  const server = new McpServer({ name: 'lumibase', version: 'fidelity' });
  const shapes = new Map<string, Record<string, z.ZodType>>();
  const recording = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'registerTool') return Reflect.get(target, prop, receiver);
      return (name: string, config: { inputSchema?: Record<string, z.ZodType> }, handler: unknown) => {
        shapes.set(name, config.inputSchema ?? {});
        return (target.registerTool as (...a: unknown[]) => unknown).call(target, name, config, handler);
      };
    },
  });
  const { client: api, calls } = fakeClient();
  registerAllTools(recording, api, PROFILE_OPTIONS[profile]);
  const client = new Client({ name: 'fidelity-suite', version: 'test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  return { client, tools, shapes, calls };
}

const connected = {} as Record<Profile, Connected>;

beforeAll(async () => {
  for (const profile of Object.keys(PROFILE_OPTIONS) as Profile[]) connected[profile] = await connect(profile);
});

afterAll(async () => {
  await Promise.all(Object.values(connected).map((c) => c.client.close()));
});

function advertised(tools: Tool[], name: string): Record<string, unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not advertised: ${name}`);
  return tool.inputSchema as Record<string, unknown>;
}

const httpSchema = (name: string) => advertised(HTTP_GOLDEN.site, name);
const stdioSchema = (name: string) => advertised(connected.site.tools, name);

/** Calls a stdio tool through the SDK client; returns the request it made upstream. */
async function callStdio(name: string, args: Record<string, unknown>): Promise<Recorded> {
  const { client, calls } = connected.site;
  const before = calls.length;
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, `${name} refused ${JSON.stringify(args)}: ${JSON.stringify(result.content)}`).toBeFalsy();
  expect(calls.length, `${name} made no upstream request`).toBe(before + 1);
  return calls[calls.length - 1]!;
}

/** stdio arguments as the SDK hands them to the handler (Zod-parsed). */
function stdioParsed(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return z.object(connected.site.shapes.get(name)!).parse(args) as Record<string, unknown>;
}

// ── 1. every advertised schema is a valid JSON Schema ─────────────────────────

describe('every advertised inputSchema is a valid JSON Schema', () => {
  it('the matrix of field types is exhaustive over FieldType', () => {
    expect(FIELD_TYPES_EXHAUSTIVE).toBe(true);
  });

  for (const profile of Object.keys(PROFILE_OPTIONS) as Profile[]) {
    it(`stdio (${profile} profile)`, () => {
      const { tools } = connected[profile];
      expect(tools.length).toBeGreaterThan(profile === 'readOnly' ? 40 : 100);
      const invalid = tools
        .map((t) => [t.name, schemaProblems(t.inputSchema)] as const)
        .filter(([, problems]) => problems.length > 0);
      expect(invalid).toEqual([]);
    });
  }

  it('HTTP (site and organization endpoints, from the golden)', () => {
    // The MCP SDK's own result schema — what an MCP client parses `tools/list` with.
    expect(() => ListToolsResultSchema.parse({ tools: HTTP_GOLDEN.site })).not.toThrow();
    expect(() => ListToolsResultSchema.parse({ tools: HTTP_GOLDEN.organization })).not.toThrow();
    const invalid = [...HTTP_GOLDEN.site, ...HTTP_GOLDEN.organization]
      .map((t) => [t.name, schemaProblems(t.inputSchema)] as const)
      .filter(([, problems]) => problems.length > 0);
    expect(invalid).toEqual([]);
  });

  it('the canonical contract emits valid schemas for every skill, advertised verbatim over HTTP', () => {
    for (const name of agentToolNamesWithSchema()) {
      const schema = jsonSchemaFor(name)!;
      expect(schemaProblems(schema), name).toEqual([]);
      expect(httpSchema(name), `${name}: HTTP golden differs from jsonSchemaFor`).toEqual(schema);
    }
  });

  it('the validator really refuses broken schemas (guards the guard)', () => {
    expect(schemaProblems({ type: 'object', properties: { a: { type: 'strng' } } })).not.toEqual([]);
    expect(schemaProblems({ type: 'object', properties: { a: { type: 'string', minLenght: 1 } } })).not.toEqual([]);
    expect(schemaProblems({ type: 'array', items: {} })).not.toEqual([]);
    // Draft-04 boolean `exclusiveMinimum`: legal in old generators, invalid in both dialects here.
    expect(schemaProblems({ type: 'object', properties: { a: { type: 'number', exclusiveMinimum: true } } })).not.toEqual([]);
    expect(schemaProblems({ type: 'object', properties: { a: { type: 'string', example: 'x' } } })).not.toEqual([]);
  });
});

// ── 2. golden tool lists ──────────────────────────────────────────────────────

describe('golden tools/list', () => {
  it('stdio tool list and schemas match the committed golden', async () => {
    // Full schemas for the site profile; the other profiles are pinned by name
    // and derived from it (next test), so the golden does not repeat 150 schemas.
    const golden = {
      site: connected.site.tools,
      organization: connected.organization.tools.map((t) => t.name),
      readOnly: connected.readOnly.tools.map((t) => t.name),
    };
    // Intended change: `pnpm -F @lumibase/mcp-server exec vitest run
    // src/__tests__/tool-schema-fidelity.test.ts -u`, then review the diff.
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(
      './fidelity/golden/stdio-tools-list.json',
    );
  });

  it('organization and read-only profiles are the site schemas, plus a required `site` / minus writes', () => {
    const site = new Map(connected.site.tools.map((t) => [t.name, t]));
    for (const tool of connected.organization.tools) {
      const base = site.get(tool.name);
      if (!base) continue; // organization-only tools: pinned by name, validated above
      const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      const { site: siteArg, ...rest } = schema.properties ?? {};
      expect(siteArg, `${tool.name} lacks the site argument`).toBeDefined();
      expect(schema.required, tool.name).toContain('site');
      expect({ ...schema, properties: rest, required: schema.required?.filter((r) => r !== 'site') }, tool.name).toEqual({
        ...base.inputSchema,
        properties: base.inputSchema.properties ?? {},
        required: base.inputSchema.required ?? [],
      });
    }
    for (const tool of connected.readOnly.tools) {
      expect(tool, tool.name).toEqual(site.get(tool.name));
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
  });

  it('the real stdio entrypoint (spawned process) advertises the same list', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts'],
      cwd: PACKAGE_DIR,
      env: {
        PATH: process.env['PATH'] ?? '',
        // Never contacted: listing tools makes no upstream request, and
        // governance is off so no probe is sent either.
        LUMIBASE_URL: 'http://127.0.0.1:9',
        LUMIBASE_SITE_ID: 'site_fidelity',
        LUMIBASE_TOKEN: 'fidelity-placeholder',
        LUMIBASE_MCP_GOVERNED: 'off',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'fidelity-stdio', version: 'test' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toEqual(connected.site.tools);
    } finally {
      await client.close();
    }
  }, 60_000);
});

// ── 3. advertised schema vs what the server accepts ────────────────────────────

/**
 * Zod `.refine()` checks that JSON Schema cannot express. Listed so they stay
 * visible; each entry must still be a real mismatch or the test fails.
 */
const UNREPRESENTABLE = new Set([
  // `extensionBundleUrl`: protocol allow-list via `new URL()`.
  'installExtension.bundleUrl',
  'updateExtension.bundleUrl',
  'install_extension.bundleUrl',
  'update_extension.bundleUrl',
]);

describe('advertised schema and server validation agree', () => {
  it('HTTP: every canonical tool, every property, every probe value', () => {
    const mismatches: string[] = [];
    for (const name of agentToolNamesWithSchema()) {
      const schema = httpSchema(name);
      const base = sampleFor(schema) as Record<string, unknown>;
      expect(schemaAccepts(schema, base), `${name} sample ${JSON.stringify(base)}`).toBe(true);
      expect(validateAgentToolInput(name, base).ok, `${name} sample ${JSON.stringify(base)}`).toBe(true);
      for (const key of Object.keys((schema['properties'] ?? {}) as object)) {
        for (const probe of PROBES) {
          const args = { ...base, [key]: probe };
          const json = schemaAccepts(schema, args);
          const server = validateAgentToolInput(name, args).ok;
          if (json !== server) mismatches.push(`${name}.${key}`);
        }
      }
      // Unknown keys: `.strict()` refuses them, so the schema must say so.
      const extra = { ...base, __unknown: 1 };
      if (schemaAccepts(schema, extra) !== validateAgentToolInput(name, extra).ok) mismatches.push(`${name}.<extra>`);
    }
    const unexpected = [...new Set(mismatches)].filter((m) => !UNREPRESENTABLE.has(m));
    expect(unexpected).toEqual([]);
    for (const known of UNREPRESENTABLE) {
      if (/^[a-z]+[A-Z]/.test(known)) expect(mismatches, `stale allow-list entry ${known}`).toContain(known);
    }
  });

  it('stdio: the SDK-advertised schema and the Zod the SDK validates with agree', () => {
    const mismatches: string[] = [];
    for (const tool of connected.site.tools) {
      const schema = tool.inputSchema as Record<string, unknown>;
      const zod = z.object(connected.site.shapes.get(tool.name)!);
      const base = sampleFor(schema) as Record<string, unknown>;
      expect(schemaAccepts(schema, base) && zod.safeParse(base).success, `${tool.name} sample`).toBe(true);
      for (const key of Object.keys((schema['properties'] ?? {}) as object)) {
        for (const probe of PROBES) {
          const args = { ...base, [key]: probe };
          if (schemaAccepts(schema, args) !== zod.safeParse(args).success) {
            mismatches.push(`${tool.name}.${key}=${JSON.stringify(probe)}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('stdio → governed: whatever a governed tool advertises, its canonical skill accepts', () => {
    const rejected: string[] = [];
    const seen = new Set<string>();
    for (const [toolName, binding] of Object.entries(GOVERNED_TOOLS)) {
      const schema = stdioSchema(toolName);
      const zod = z.object(connected.site.shapes.get(toolName)!);
      const base = sampleFor(schema) as Record<string, unknown>;
      const candidates = [base];
      for (const key of Object.keys((schema['properties'] ?? {}) as object)) {
        for (const probe of PROBES) candidates.push({ ...base, [key]: probe });
      }
      for (const args of candidates) {
        if (!schemaAccepts(schema, args)) continue;
        const parsed = zod.parse(args) as Record<string, unknown>;
        const verdict = validateAgentToolInput(binding.skill, toSkillArgs(parsed, binding));
        if (!verdict.ok) {
          const key = `${toolName}.${verdict.issues.map((i) => i.path).join(',')}`;
          seen.add(key);
          if (!UNREPRESENTABLE.has(key)) rejected.push(`${key} ← ${JSON.stringify(args)}`);
        }
      }
    }
    expect(rejected).toEqual([]);
    for (const known of [...UNREPRESENTABLE].filter((k) => k.includes('_'))) {
      expect(seen, `stale allow-list entry ${known}`).toContain(known);
    }
  });

  it('array vs object (Directus #27039): `data` is an object on both transports, consistently', () => {
    for (const bad of [[], [{ title: 'x' }], 'x', null]) {
      for (const [name, tool] of [
        ['createItem', 'create_item'],
        ['updateItem', 'update_item'],
      ] as const) {
        const httpArgs = { collection: 'posts', id: 'post_1', data: bad };
        if (name === 'createItem') delete (httpArgs as { id?: string }).id;
        expect(schemaAccepts(httpSchema(name), httpArgs), `${name} advertised ${JSON.stringify(bad)}`).toBe(false);
        expect(validateAgentToolInput(name, httpArgs).ok, `${name} harness ${JSON.stringify(bad)}`).toBe(false);
        const stdioArgs = { collection: 'posts', id: 'post_1', data: bad };
        expect(schemaAccepts(stdioSchema(tool), stdioArgs), `${tool} advertised ${JSON.stringify(bad)}`).toBe(false);
      }
    }
  });
});

// ── 4. field-type matrix round-trip ───────────────────────────────────────────

describe('field-type matrix: type × nullable × localized × repeatable', () => {
  const cases = matrix();

  it('covers every storage type and reference kind in all 8 shape combinations', () => {
    const kinds = new Set(cases.map((c) => c.kind));
    for (const t of FIELD_TYPES) expect(kinds).toContain(t);
    for (const k of ['m2o', 'o2m', 'm2m', 'm2a', 'file', 'image', 'files']) expect(kinds).toContain(k);
    expect(cases.length).toBe(kinds.size * 8);
  });

  it.each(cases.map((c) => [c.label, c] as const))('%s', async (_label, c) => {
    const data = { [c.field]: c.value };

    // HTTP: advertised schema and harness validation both accept, data unchanged.
    for (const [name, args] of [
      ['createItem', { collection: 'posts', data, status: 'draft' }],
      ['updateItem', { collection: 'posts', id: 'post_1', data, expect: { [c.field]: c.value } }],
    ] as const) {
      expect(schemaAccepts(httpSchema(name), args), `${name} advertised`).toBe(true);
      const verdict = validateAgentToolInput(name, args);
      expect(verdict.ok, `${name} harness`).toBe(true);
      if (verdict.ok) expect(verdict.data['data']).toEqual(data);
    }

    // stdio: advertised schema accepts, the SDK passes it, REST receives it unchanged.
    const created = await callStdio('create_item', { collection: 'posts', data });
    expect(created).toMatchObject({ method: 'POST', path: '/items/posts' });
    expect((created.body as { data: unknown }).data).toEqual(data);
    const updated = await callStdio('update_item', { collection: 'posts', id: 'post_1', data });
    expect(updated).toMatchObject({ method: 'PATCH', path: '/items/posts/post_1' });
    expect(updated.body).toEqual({ data });
    expect(schemaAccepts(stdioSchema('create_item'), { collection: 'posts', data })).toBe(true);

    // stdio → governed: the translated arguments pass the canonical contract.
    for (const tool of ['create_item', 'update_item'] as const) {
      const args = stdioParsed(tool, { collection: 'posts', id: 'post_1', data });
      const binding = GOVERNED_TOOLS[tool]!;
      const verdict = validateAgentToolInput(binding.skill, toSkillArgs(args, binding));
      expect(verdict.ok, `${tool} → ${binding.skill}`).toBe(true);
      if (verdict.ok) expect(verdict.data['data']).toEqual(data);
    }
  });

  it.each(FIELD_TYPES.flatMap((type) => [[type, false], [type, true]] as const))(
    'defining a %s field (nullable=%s) is accepted by both transports',
    async (type, nullable) => {
      const http = { collection: 'posts', name: `f_${type.toLowerCase()}`, type, required: !nullable, interface: 'input', note: null };
      expect(schemaAccepts(httpSchema('createField'), http)).toBe(true);
      expect(validateAgentToolInput('createField', http).ok).toBe(true);

      const stdio = { collection: 'posts', field_name: `f_${type.toLowerCase()}`, type, interface: 'input', nullable, note: null, label: null };
      expect(schemaAccepts(stdioSchema('upsert_field'), stdio)).toBe(true);
      const sent = await callStdio('upsert_field', stdio);
      expect(sent.method).toBe('PUT');
      // Exactly what the caller set: no `null` dropped, no Zod default injected
      // into what REST treats as a partial update.
      expect(sent.body).toEqual({ type, interface: 'input', nullable, note: null, label: null });
    },
  );
});

// ── 5. nullable references (Payload #16214) ───────────────────────────────────

describe('nullable relation and metadata columns advertise and accept null', () => {
  const NULLABLE_RELATION_KEYS = [
    'oneField',
    'junctionCollection',
    'aliasField',
    'relatedDisplayTemplate',
    'junctionManyField',
    'junctionOneField',
    'sortField',
  ];

  it('createRelation / create_relation: every nullable key takes null end to end', async () => {
    const args: Record<string, unknown> = { manyCollection: 'posts', manyField: 'author', oneCollection: 'authors', type: 'm2o' };
    for (const key of NULLABLE_RELATION_KEYS) args[key] = null;

    expect(schemaAccepts(httpSchema('createRelation'), args)).toBe(true);
    expect(validateAgentToolInput('createRelation', args).ok).toBe(true);
    expect(schemaAccepts(stdioSchema('create_relation'), args)).toBe(true);
    const sent = await callStdio('create_relation', args);
    expect(sent.body).toEqual(args);
    const binding = GOVERNED_TOOLS['create_relation']!;
    expect(validateAgentToolInput(binding.skill, toSkillArgs(stdioParsed('create_relation', args), binding)).ok).toBe(true);
  });

  it('update_collection can clear nullable collection metadata (REST accepts null)', async () => {
    const patch = { label: null, note: null, icon: null, color: null, displayTemplate: null, sortField: null, archiveField: null };
    expect(schemaAccepts(stdioSchema('update_collection'), { name: 'posts', patch })).toBe(true);
    const sent = await callStdio('update_collection', { name: 'posts', patch });
    expect(sent).toMatchObject({ method: 'PATCH', path: '/collections/posts', body: patch });
  });

  it('apply_schema field inputs take null for clearable columns', async () => {
    const field = { name: 'subtitle', type: 'string', interface: 'input', display: null, label: null, note: null, group: null };
    expect(schemaAccepts(stdioSchema('apply_schema'), { name: 'posts', fields: [field], note: null })).toBe(true);
    const sent = await callStdio('apply_schema', { name: 'posts', fields: [field], note: null });
    expect(sent.body).toEqual({ fields: [field], note: null });
  });

  it('upsert_field forwards REST-only keys instead of stripping them', async () => {
    const args = {
      collection: 'customers',
      field_name: 'email',
      type: 'string',
      interface: 'input',
      classification: 'pii',
      encrypted: true,
      rawEnabled: false,
      validation: { rules: [] },
    };
    const sent = await callStdio('upsert_field', args);
    const { collection: _c, field_name: _f, ...body } = args;
    expect(sent.body).toEqual(body);
  });
});
