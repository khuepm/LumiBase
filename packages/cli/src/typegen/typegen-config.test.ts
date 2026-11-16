import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypegenManifest } from '@lumibase/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { typesCommand } from '../commands/types.js';
import { parseArgs } from '../utils/args.js';
import { findTypegenConfigFile, loadTypegenConfig, validateTypegenConfig } from './load-config.js';
import { fileSource, planTypegen, runTypegen, watchTypegen } from './run.js';
import type { ResolvedConfig } from '../config.js';

const MANIFEST: TypegenManifest = {
  version: 2,
  site: 'site_abc',
  collections: [
    {
      name: 'articles',
      primaryKey: 'id',
      fields: [
        { name: 'id', type: 'string', required: true, nullable: false, primaryKey: true },
        { name: 'title', type: 'string', required: true, nullable: false },
      ],
    },
    {
      name: 'pages',
      primaryKey: 'id',
      fields: [{ name: 'id', type: 'string', required: true, nullable: false, primaryKey: true }],
    },
  ],
};

const ENV = {
  LUMIBASE_URL: 'http://localhost:1989',
  LUMIBASE_SITE_ID: 'site_abc',
  LUMIBASE_TOKEN: 'tok_abc',
};

const created: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lumibase-typegen-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

type Reply = { status: number; body?: unknown; etag?: string };

/** Answers the typegen endpoint from a queue (last reply repeats); records requests. */
function scriptedFetch(replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let index = 0;
  const fetcher = vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(input), headers: init?.headers ?? {} });
    const reply = replies[Math.min(index, replies.length - 1)] as Reply;
    index += 1;
    if (reply.status === 304) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(reply.body ?? { data: MANIFEST }), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.etag ? { ETag: reply.etag } : {}) },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const FALLBACK: ResolvedConfig = {
  url: ENV.LUMIBASE_URL,
  siteId: ENV.LUMIBASE_SITE_ID,
  token: ENV.LUMIBASE_TOKEN,
  sources: { url: 'env', siteId: 'env', token: 'env' },
  typegen: {},
};

describe('typegen config loading', () => {
  it('loads a .ts config exporting an array, through jiti', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'lumibase.typegen.config.ts'),
      [
        "type Target = { type: 'ts' | 'zod'; out: string };",
        "const targets: Target[] = [{ type: 'ts', out: 'a.d.ts' }];",
        "export default [{ name: 'web', targets }, { name: 'admin', targets: [{ type: 'zod', out: 'b.ts' }] }];",
      ].join('\n'),
    );
    const loaded = await loadTypegenConfig(join(dir, 'lumibase.typegen.config.ts'));
    expect(loaded.configs.map((config) => config.name)).toEqual(['web', 'admin']);
    expect(loaded.dir).toBe(dir);
  });

  it('loads a .js config exporting a single config, and a .json config', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'one.mjs'), "export default { targets: [{ type: 'graphql-sdl', out: 'schema.graphql' }] };");
    writeFileSync(join(dir, 'two.json'), JSON.stringify([{ targets: [{ type: 'openapi', out: 'o.json' }] }]));
    expect((await loadTypegenConfig(join(dir, 'one.mjs'))).configs).toHaveLength(1);
    expect((await loadTypegenConfig(join(dir, 'two.json'))).configs[0]?.targets[0]?.type).toBe('openapi');
  });

  it('finds the config file by walking up, preferring .ts', () => {
    const dir = tempDir();
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, 'lumibase.typegen.config.json'), '{}');
    writeFileSync(join(dir, 'lumibase.typegen.config.ts'), 'export default {}');
    expect(findTypegenConfigFile(nested)).toBe(join(dir, 'lumibase.typegen.config.ts'));
  });

  it('rejects bad configs with a message naming the key', () => {
    expect(() => validateTypegenConfig({ targets: [] })).toThrow(/targets.*non-empty/);
    expect(() => validateTypegenConfig({ targets: [{ type: 'yaml', out: 'x' }] })).toThrow(/type must be one of/);
    expect(() => validateTypegenConfig({ targets: [{ type: 'ts' }] })).toThrow(/out must be/);
    expect(() =>
      validateTypegenConfig({ source: { token: 'secret' }, targets: [{ type: 'ts', out: 'x' }] }),
    ).toThrow(/must not contain a "token"/);
    expect(() =>
      validateTypegenConfig([
        { targets: [{ type: 'ts', out: './types.ts' }] },
        { targets: [{ type: 'zod', out: 'types.ts' }] },
      ]),
    ).toThrow(/written by both/);
  });
});

describe('runTypegen — multiple configs and targets in one run', () => {
  it('two configs produce two outputs in one run, from one fetch per source', async () => {
    const dir = tempDir();
    const { fetcher, calls } = scriptedFetch([{ status: 200 }]);
    const plan = planTypegen(
      validateTypegenConfig([
        { name: 'web', include: ['articles'], targets: [{ type: 'ts', out: 'web/types.d.ts' }] },
        { name: 'admin', targets: [{ type: 'zod', out: 'admin/schemas.ts' }] },
      ]),
      { dir, env: {}, fallback: FALLBACK, request: { fetcher } },
    );

    const results = await runTypegen(plan, { cwd: dir });

    expect(results.map((r) => [r.config, r.status])).toEqual([
      ['web', 'written'],
      ['admin', 'written'],
    ]);
    const web = readFileSync(join(dir, 'web/types.d.ts'), 'utf8');
    const admin = readFileSync(join(dir, 'admin/schemas.ts'), 'utf8');
    expect(web).toContain('export interface Articles');
    expect(web).not.toContain('Pages'); // include filter applied per config
    expect(admin).toContain('export const PagesSchema = z.object(');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers['Authorization']).toBe('Bearer tok_abc');
  });

  it('writes every target type of one config', async () => {
    const dir = tempDir();
    const { fetcher } = scriptedFetch([{ status: 200 }]);
    const plan = planTypegen(
      validateTypegenConfig({
        targets: [
          { type: 'ts', out: 'out/types.d.ts' },
          { type: 'zod', out: 'out/zod.ts' },
          { type: 'graphql-sdl', out: 'out/schema.graphql' },
          { type: 'openapi', out: 'out/openapi.json' },
          { type: 'manifest', out: 'out/manifest.json' },
        ],
      }),
      { dir, env: {}, fallback: FALLBACK, request: { fetcher } },
    );
    await runTypegen(plan, { cwd: dir });
    expect(readFileSync(join(dir, 'out/schema.graphql'), 'utf8')).toMatch(/^# Generated by `lumibase types`/);
    expect(JSON.parse(readFileSync(join(dir, 'out/openapi.json'), 'utf8')).openapi).toBe('3.1.0');
    const saved = readFileSync(join(dir, 'out/manifest.json'), 'utf8');
    expect(saved).not.toContain('site_abc');
    expect(JSON.parse(saved).collections).toHaveLength(2);
  });

  it('uses per-config sources: named env vars, and a saved manifest file', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'saved.json'), JSON.stringify({ data: MANIFEST }));
    const { fetcher, calls } = scriptedFetch([{ status: 200 }]);
    const plan = planTypegen(
      validateTypegenConfig([
        {
          source: { urlEnv: 'STAGING_URL', site: 'site_staging', tokenEnv: 'STAGING_TOKEN' },
          targets: [{ type: 'ts', out: 'staging.d.ts' }],
        },
        { source: { manifest: 'saved.json' }, targets: [{ type: 'graphql-sdl', out: 'offline.graphql' }] },
      ]),
      {
        dir,
        env: { STAGING_URL: 'https://staging.example/', STAGING_TOKEN: 'tok_staging' },
        fallback: FALLBACK,
        request: { fetcher },
      },
    );
    await runTypegen(plan, { cwd: dir });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://staging.example/api/v1/typegen/schema');
    expect(calls[0]?.headers['X-Lumi-Site']).toBe('site_staging');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer tok_staging');
    expect(readFileSync(join(dir, 'offline.graphql'), 'utf8')).toContain('type Articles {');
  });

  it('fails clearly when a named env var is unset', () => {
    expect(() =>
      planTypegen(validateTypegenConfig({ source: { tokenEnv: 'NOPE' }, targets: [{ type: 'ts', out: 'x' }] }), {
        dir: tempDir(),
        env: {},
        fallback: FALLBACK,
      }),
    ).toThrow(/NOPE is not set/);
  });

  it('--check exits non-zero listing stale outputs, and never writes', async () => {
    const dir = tempDir();
    const { fetcher } = scriptedFetch([{ status: 200 }]);
    const configs = validateTypegenConfig([
      { targets: [{ type: 'ts', out: 'a.d.ts' }] },
      { targets: [{ type: 'graphql-sdl', out: 'b.graphql' }] },
    ]);
    const plan = () => planTypegen(configs, { dir, env: {}, fallback: FALLBACK, request: { fetcher } });

    await runTypegen(plan(), { cwd: dir });
    await expect(runTypegen(plan(), { cwd: dir, check: true })).resolves.toHaveLength(2);

    writeFileSync(join(dir, 'b.graphql'), 'stale');
    rmSync(join(dir, 'a.d.ts'));
    await expect(runTypegen(plan(), { cwd: dir, check: true })).rejects.toThrow(
      /2 of 2 generated file\(s\) are missing or out of date/,
    );
    expect(existsSync(join(dir, 'a.d.ts'))).toBe(false);
    expect(readFileSync(join(dir, 'b.graphql'), 'utf8')).toBe('stale');
  });
});

describe('typesCommand with a config file', () => {
  it('runs every config in the discovered file', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'lumibase.typegen.config.json'),
      JSON.stringify([
        { targets: [{ type: 'ts', out: 'one.d.ts' }] },
        { targets: [{ type: 'openapi', out: 'two.json' }] },
      ]),
    );
    const { fetcher } = scriptedFetch([{ status: 200 }]);
    const code = await typesCommand(parseArgs(['types']), { cwd: dir, env: ENV, request: { fetcher } });
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'one.d.ts'))).toBe(true);
    expect(existsSync(join(dir, 'two.json'))).toBe(true);
  });

  it('refuses single-output flags that the config would silently override', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'lumibase.typegen.config.json'), JSON.stringify({ targets: [{ type: 'ts', out: 'x' }] }));
    await expect(
      typesCommand(parseArgs(['types', '--out', 'y.d.ts']), { cwd: dir, env: ENV }),
    ).rejects.toThrow(/--out cannot be combined/);
  });

  it('--check through the command fails on a stale output', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'lumibase.typegen.config.json'), JSON.stringify({ targets: [{ type: 'ts', out: 'x.d.ts' }] }));
    writeFileSync(join(dir, 'x.d.ts'), 'old');
    const { fetcher } = scriptedFetch([{ status: 200 }]);
    await expect(
      typesCommand(parseArgs(['types', '--check']), { cwd: dir, env: ENV, request: { fetcher } }),
    ).rejects.toThrow(/out of date/);
  });
});

describe('watchTypegen', () => {
  const noSleep = vi.fn(async () => undefined);

  it('polls with If-None-Match and regenerates only when the schema changed', async () => {
    const dir = tempDir();
    const changed: TypegenManifest = { ...MANIFEST, collections: [MANIFEST.collections[1]!] };
    const { fetcher, calls } = scriptedFetch([
      { status: 200, etag: 'W/"a"' },
      { status: 304 },
      { status: 200, etag: 'W/"b"', body: { data: changed } },
    ]);
    const plan = planTypegen(validateTypegenConfig({ targets: [{ type: 'ts', out: 't.d.ts' }] }), {
      dir,
      env: {},
      fallback: FALLBACK,
      request: { fetcher },
    });

    const controller = new AbortController();
    const rounds: number[] = [];
    await watchTypegen(plan, {
      cwd: dir,
      signal: controller.signal,
      sleep: noSleep,
      onRound: (round) => {
        rounds.push(round.regenerated.length);
        if (rounds.length === 2) controller.abort();
      },
    });

    expect(rounds).toEqual([0, 1]);
    expect(calls[1]?.headers['If-None-Match']).toBe('W/"a"');
    expect(calls[2]?.headers['If-None-Match']).toBe('W/"a"');
    expect(readFileSync(join(dir, 't.d.ts'), 'utf8')).not.toContain('interface Articles');
  });

  it('treats an identical 200 (server without ETag) as unchanged', async () => {
    const dir = tempDir();
    const { fetcher } = scriptedFetch([{ status: 200 }]);
    const plan = planTypegen(validateTypegenConfig({ targets: [{ type: 'ts', out: 't.d.ts' }] }), {
      dir,
      env: {},
      fallback: FALLBACK,
      request: { fetcher },
    });
    const controller = new AbortController();
    const rounds: number[] = [];
    await watchTypegen(plan, {
      cwd: dir,
      signal: controller.signal,
      sleep: noSleep,
      onRound: (round) => {
        rounds.push(round.regenerated.length);
        if (rounds.length === 2) controller.abort();
      },
    });
    expect(rounds).toEqual([0, 0]);
  });

  it('backs off exponentially on errors, capped, and resets after a success', async () => {
    const dir = tempDir();
    const { fetcher } = scriptedFetch([
      { status: 200, etag: 'W/"a"' },
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 304 },
    ]);
    const plan = planTypegen(validateTypegenConfig({ targets: [{ type: 'ts', out: 't.d.ts' }] }), {
      dir,
      env: {},
      fallback: FALLBACK,
      request: { fetcher },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const controller = new AbortController();
    const delays: number[] = [];
    await watchTypegen(plan, {
      cwd: dir,
      intervalMs: 1000,
      maxBackoffMs: 3000,
      signal: controller.signal,
      sleep: noSleep,
      onRound: (round) => {
        delays.push(round.nextDelayMs);
        if (delays.length === 4) controller.abort();
      },
    });
    expect(delays).toEqual([2000, 3000, 3000, 1000]);
  });

  it('a manifest-file source regenerates when the file content changes', async () => {
    const dir = tempDir();
    const path = join(dir, 'm.json');
    writeFileSync(path, JSON.stringify(MANIFEST));
    const source = fileSource(path);
    await source.load();
    expect(await source.poll()).toBeNull();

    writeFileSync(path, JSON.stringify({ ...MANIFEST, collections: [] }));
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    expect((await source.poll())?.collections).toEqual([]);
    expect(await source.poll()).toBeNull();
  });
});
