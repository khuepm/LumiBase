import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ExtensionSandbox } from '../../sandbox';
import { evictExtensionProcesses, extensionProcessCount, resolveExtensionRuntime } from '../process-host';

/**
 * #990: on Node, `EXTENSION_RUNTIME=process` runs each bundle in a forked
 * child with an empty env and Node's permission model; its `ctx` calls are
 * answered by the host's capability-checked ctx. These tests fork real
 * processes (the child script is bundled on demand with esbuild).
 */

const bundle = (source: string) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

const PROBE_SOURCE = bundle(`
let calls = 0;
export default (ctx) => ({
  hooks: {
    'items.create.before': async (input) => {
      calls += 1;
      const out = { calls, envKeys: Object.keys(process.env).length, echo: input.collection };
      try { (await import('node:fs')).writeFileSync('/tmp/lumibase-ext-escape', 'x'); out.wrote = true; }
      catch (err) { out.writeError = err.code ?? String(err); }
      try { await import('node:child_process').then((m) => m.execSync('true')); out.spawned = true; }
      catch (err) { out.spawnError = err.code ?? String(err); }
      return out;
    },
    'items.update.before': async () => ({ secret: await ctx.env.EXTENSION_GREETING }),
    'items.delete.before': async () => ({ rows: await ctx.db.query('SELECT 1') }),
  },
  mcp: { tools: [{ name: 'add', handler: async (args) => ({ sum: args.a + args.b }) }] },
  handler: (app) => {
    app.get('/hello', (c) => c.json({ hello: c.req.query('name') ?? 'world', auth: c.req.header('authorization') ?? null }));
    app.post('/echo', async (c) => c.json(await c.req.json()));
  },
});
`);

const ORIGIN = 'https://extensions.test';
const BUNDLES: Record<string, string> = {};

/** Serves bundles from memory instead of the network; the trust gates still run. */
class TestSandbox extends ExtensionSandbox {
  protected override async fetchBundleSource(url: string): Promise<string> {
    const source = BUNDLES[url];
    if (!source) throw new Error(`no bundle at ${url}`);
    return source;
  }
}

const ENV = {
  EXTENSION_RUNTIME: 'process',
  EXTENSION_BUNDLE_ORIGINS: ORIGIN,
  EXTENSION_GREETING: 'hi from host',
  DATABASE_URL: 'postgres://secret@host/db',
} as Record<string, unknown>;

function sandbox(env = ENV) {
  return new TestSandbox(env as never, undefined);
}

function serve(name: string, source: string): string {
  const url = `${ORIGIN}/${name}.mjs`;
  BUNDLES[url] = source;
  return url;
}

const PROBE = serve('probe', PROBE_SOURCE);

describe('resolveExtensionRuntime', () => {
  it('follows EXTENSION_RUNTIME, else production → process', () => {
    expect(resolveExtensionRuntime({ EXTENSION_RUNTIME: 'process' })).toBe('process');
    expect(resolveExtensionRuntime({ EXTENSION_RUNTIME: 'in-process', LUMIBASE_ENV: 'production' })).toBe('in-process');
    expect(resolveExtensionRuntime({ LUMIBASE_ENV: 'production' })).toBe('process');
    expect(resolveExtensionRuntime({ NODE_ENV: 'production' })).toBe('process');
    expect(resolveExtensionRuntime({ LUMIBASE_ENV: 'development', NODE_ENV: 'test' })).toBe('in-process');
  });
});

describe('out-of-process extension host (#990)', () => {
  const saved = process.env.LUMIBASE_ENV;
  beforeAll(() => {
    // Keep resolveExtensionRuntime's process.env fallback from interfering.
    process.env.LUMIBASE_ENV = 'development';
  });
  afterEach(async () => {
    await evictExtensionProcesses();
  });
  afterAll(() => {
    process.env.LUMIBASE_ENV = saved;
  });

  it('runs hooks in a child with no env, no file writes and no child processes', async () => {
    const mod = await sandbox().load({ name: 'probe', bundleUrl: PROBE, capabilities: [], siteId: 'site_a', timeoutMs: 20_000 });
    expect(mod).not.toBeNull();
    const out = (await mod!.hooks!['items.create.before']!({ collection: 'posts' })) as Record<string, unknown>;
    expect(out).toMatchObject({ calls: 1, envKeys: 0, echo: 'posts', writeError: 'ERR_ACCESS_DENIED', spawnError: 'ERR_ACCESS_DENIED' });
    expect(out.wrote).toBeUndefined();
    expect(out.spawned).toBeUndefined();
  }, 30_000);

  it('answers ctx calls with the host capability checks', async () => {
    const denied = await sandbox().load({ name: 'probe', bundleUrl: PROBE, capabilities: [], siteId: 'site_a', timeoutMs: 20_000 });
    await expect(denied!.hooks!['items.update.before']!({ collection: 'posts' })).rejects.toThrow(/env:read/);
    await evictExtensionProcesses();

    const granted = await sandbox().load({ name: 'probe', bundleUrl: PROBE, capabilities: ['env:read'], siteId: 'site_a', timeoutMs: 20_000 });
    expect(await granted!.hooks!['items.update.before']!({ collection: 'posts' })).toEqual({ secret: 'hi from host' });
    // db:read without service-account is refused by the host, before any SQL.
    await expect(granted!.hooks!['items.delete.before']!({ collection: 'posts' })).rejects.toThrow(/db:read/);
  }, 40_000);

  it('keeps one child per site: module state is not shared between tenants', async () => {
    const a = await sandbox().load({ name: 'probe', bundleUrl: PROBE, capabilities: [], siteId: 'site_a', timeoutMs: 20_000 });
    const b = await sandbox().load({ name: 'probe', bundleUrl: PROBE, capabilities: [], siteId: 'site_b', timeoutMs: 20_000 });
    await a!.hooks!['items.create.before']!({ collection: 'x' });
    const second = (await a!.hooks!['items.create.before']!({ collection: 'x' })) as { calls: number };
    const other = (await b!.hooks!['items.create.before']!({ collection: 'x' })) as { calls: number };
    expect(second.calls).toBe(2);
    expect(other.calls).toBe(1);
    expect(extensionProcessCount()).toBe(2);
    await evictExtensionProcesses('probe');
    expect(extensionProcessCount()).toBe(0);
  }, 40_000);

  it('serves MCP tools and endpoint routes through the child', async () => {
    const mod = await sandbox().load({ name: 'probe', bundleUrl: PROBE, capabilities: [], siteId: 'site_a', timeoutMs: 20_000 });
    expect(await mod!.mcp!.tools![0]!.handler({ a: 2, b: 3 }, { siteId: 'site_a', runId: null })).toEqual({ sum: 5 });

    const app = new Hono();
    mod!.handler!(app);
    const hello = await app.request('http://ext.local/hello?name=lumi');
    expect(await hello.json()).toEqual({ hello: 'lumi', auth: null });
    const echo = await app.request('http://ext.local/echo', { method: 'POST', body: JSON.stringify({ ok: true }), headers: { 'content-type': 'application/json' } });
    expect(await echo.json()).toEqual({ ok: true });
  }, 30_000);

  it('the trust policy still runs first: an untrusted origin never reaches a child', async () => {
    const url = 'https://elsewhere.example/probe.mjs';
    BUNDLES[url] = PROBE_SOURCE;
    expect(await sandbox().load({ name: 'probe', bundleUrl: url, capabilities: [], siteId: 'site_a' })).toBeNull();
    expect(extensionProcessCount()).toBe(0);
  });

  it('a bundle that fails to load returns null and leaves no process', async () => {
    const broken = serve('broken', bundle('export default () => { throw new Error("nope"); };'));
    expect(await sandbox().load({ name: 'broken', bundleUrl: broken, capabilities: [], siteId: 'site_a', timeoutMs: 20_000 })).toBeNull();
    expect(extensionProcessCount()).toBe(0);
  }, 30_000);
});
