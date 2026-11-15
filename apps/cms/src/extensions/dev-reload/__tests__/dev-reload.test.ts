import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferSelectModel } from 'drizzle-orm';
import type { extensions as extensionsTable } from '@lumibase/database';
import { EXTENSION_DEV_PROTOCOL, type ExtensionDevReloadEvent } from '@lumibase/contracts/extensions';
import { validateProductionConfig } from '../../../config/production';
import { HookDispatcher } from '../../hook-dispatcher';
import { ExtensionSandbox } from '../../sandbox';
import { resolveExtensionDevConfig } from '../config';
import { startExtensionDevClient } from '../client';
import {
  DevExtensionRegistry,
  ExtensionDevRefusedError,
  devExtensionRegistry,
  type DevExtensionBuild,
} from '../registry';

type ExtensionRow = InferSelectModel<typeof extensionsTable>;

const TOKEN = 'a'.repeat(64);
const DEV_ENV = { NODE_ENV: 'development', LUMIBASE_EXTENSION_DEV: '1' };

afterEach(() => {
  devExtensionRegistry.deactivate();
  vi.restoreAllMocks();
});

/** A dev build whose hooks record which version handled each event. */
function hookBuild(version: number, calls: string[], gate?: Promise<void>, siteId: string | null = null): DevExtensionBuild {
  return {
    name: 'dev-hook',
    type: 'hook',
    version,
    sha256: '0'.repeat(64),
    capabilities: [],
    siteId,
    module: {
      hooks: {
        'items.create.before': async () => {
          calls.push(`before@v${version}`);
          await gate;
          return { patch: { stampedBy: version } };
        },
        'items.create.after': async () => {
          calls.push(`after@v${version}`);
        },
      },
    },
  };
}

// ─── Prod refusal ────────────────────────────────────────────────────────────

describe('extension hot reload — production refusal', () => {
  it('is off unless explicitly requested', () => {
    expect(resolveExtensionDevConfig({ NODE_ENV: 'development' })).toMatchObject({
      enabled: false,
      reason: 'not-requested',
    });
  });

  it.each([
    [{ ...DEV_ENV, NODE_ENV: 'production' }, 'production'],
    [{ ...DEV_ENV, LUMIBASE_ENV: 'production' }, 'production'],
    [{ LUMIBASE_EXTENSION_DEV: '1' }, 'node-env'],
    [{ ...DEV_ENV, NODE_ENV: 'staging' }, 'node-env'],
    [{ ...DEV_ENV, LUMIBASE_EXTENSION_DEV_URL: 'http://10.0.0.5:4790' }, 'non-loopback-url'],
    [{ ...DEV_ENV, LUMIBASE_EXTENSION_DEV_URL: 'http://evil.example:4790' }, 'non-loopback-url'],
    [{ ...DEV_ENV, LUMIBASE_EXTENSION_DEV_TOKEN: 'short' }, 'weak-token'],
  ])('refuses %j (%s)', (env, reason) => {
    expect(resolveExtensionDevConfig(env)).toMatchObject({ enabled: false, reason });
  });

  it('allows a loopback hub in development', () => {
    expect(resolveExtensionDevConfig({ ...DEV_ENV, LUMIBASE_EXTENSION_DEV_URL: 'http://localhost:5000/' })).toEqual({
      enabled: true,
      hubUrl: 'http://localhost:5000',
      token: null,
      tokenFile: null,
      hubPort: 5000,
    });
  });

  it('fails the production start when the flag is set', () => {
    const prod = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@db.example.com:5432/x?sslmode=require',
      REDIS_URL: 'rediss://r.example.com:6379',
      JWT_SECRET: 'prod-jwt-secret-with-enough-entropy',
      ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      CORS_ALLOWED_ORIGINS: 'https://studio.example.com',
    };
    expect(() => validateProductionConfig(prod)).not.toThrow();
    expect(() => validateProductionConfig({ ...prod, LUMIBASE_EXTENSION_DEV: '1' })).toThrow(
      /LUMIBASE_EXTENSION_DEV must not be enabled in production/,
    );
  });

  it('registry refuses to activate in production and stays inert', () => {
    const reg = new DevExtensionRegistry();
    expect(() => reg.activate({ NODE_ENV: 'production' })).toThrow(ExtensionDevRefusedError);
    expect(() => reg.activate({ LUMIBASE_ENV: 'production' })).toThrow(ExtensionDevRefusedError);
    expect(reg.isActive()).toBe(false);
    expect(() => reg.swap(hookBuild(1, []))).toThrow(ExtensionDevRefusedError);
    expect(reg.snapshot().size).toBe(0);
  });

  it('registry refuses when the live process env is production, whatever env is passed', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => new DevExtensionRegistry().activate({ NODE_ENV: 'development' })).toThrow(ExtensionDevRefusedError);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('an inactive registry never overrides a sandbox load', async () => {
    const sandbox = new ExtensionSandbox({});
    // Not activated → no override; untrusted bundle URL → refused (null).
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sandbox.load({ name: 'dev-hook', bundleUrl: 'lumibase-dev:dev-hook', capabilities: [] })).toBeNull();
    expect(sandbox.devHookBuilds('site_1')).toEqual([]);
  });
});

// ─── Hook swap atomicity ─────────────────────────────────────────────────────

describe('extension hot reload — hook swap atomicity', () => {
  it('versions only ever move forward', () => {
    const reg = new DevExtensionRegistry();
    reg.activate({ NODE_ENV: 'development' });
    expect(reg.swap(hookBuild(2, []))).toBe(true);
    expect(reg.swap(hookBuild(1, []))).toBe(false);
    expect(reg.swap(hookBuild(2, []))).toBe(false);
    expect(reg.snapshot().get('dev-hook')?.version).toBe(2);
  });

  it('a snapshot is never mutated by a later swap (copy-on-write)', () => {
    const reg = new DevExtensionRegistry();
    reg.activate({ NODE_ENV: 'development' });
    reg.swap(hookBuild(1, []));
    const before = reg.snapshot();
    reg.swap(hookBuild(2, []));
    expect(before.get('dev-hook')?.version).toBe(1);
    expect(reg.snapshot().get('dev-hook')?.version).toBe(2);
    expect(reg.snapshot()).not.toBe(before);
  });

  it('an in-flight request finishes on the old version; new requests get the new one', async () => {
    devExtensionRegistry.activate({ NODE_ENV: 'development' });
    const calls: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    devExtensionRegistry.swap(hookBuild(1, calls, gate));

    // Request A starts on v1 and blocks inside its before-hook.
    const dispatcherA = new HookDispatcher(new ExtensionSandbox({}), []);
    const ctx = { siteId: 'site_1', collection: 'posts' };
    const beforeA = dispatcherA.dispatch('items.create.before', ctx);
    await vi.waitFor(() => expect(calls).toEqual(['before@v1']));

    // Reload lands mid-request.
    devExtensionRegistry.swap(hookBuild(2, calls));

    // Request B starts after the swap → v2 for every hook.
    const dispatcherB = new HookDispatcher(new ExtensionSandbox({}), []);
    const resultB = await dispatcherB.dispatch('items.create.before', ctx);
    await dispatcherB.dispatch('items.create.after', ctx);

    // Request A resumes and completes — still v1, including its after-hook.
    release();
    const resultA = await beforeA;
    await dispatcherA.dispatch('items.create.after', ctx);

    expect(resultA.patch).toEqual({ stampedBy: 1 });
    expect(resultB.patch).toEqual({ stampedBy: 2 });
    expect(calls).toEqual(['before@v1', 'before@v2', 'after@v2', 'after@v1']);
  });

  it('a --site build only applies to that site', async () => {
    devExtensionRegistry.activate({ NODE_ENV: 'development' });
    const calls: string[] = [];
    devExtensionRegistry.swap(hookBuild(1, calls, undefined, 'site_a'));
    await new HookDispatcher(new ExtensionSandbox({}), []).dispatch('items.create.after', { siteId: 'site_b', collection: 'p' });
    expect(calls).toEqual([]);
    await new HookDispatcher(new ExtensionSandbox({}), []).dispatch('items.create.after', { siteId: 'site_a', collection: 'p' });
    expect(calls).toEqual(['after@v1']);
  });

  it('overrides an installed extension of the same name without its bundle URL or signature gate', async () => {
    devExtensionRegistry.activate({ NODE_ENV: 'development' });
    const calls: string[] = [];
    devExtensionRegistry.swap(hookBuild(3, calls));
    const row = {
      name: 'dev-hook',
      type: 'hook',
      enabled: true,
      bundleUrl: 'https://cdn.example/dev-hook.mjs',
      capabilities: [],
    } as unknown as ExtensionRow;
    const verify = vi.fn().mockResolvedValue(false);
    await new HookDispatcher(new ExtensionSandbox({}), [row], undefined, () => ({
      isOfficial: true,
      requireSignature: true,
      verify,
    })).dispatch('items.create.after', { siteId: 's', collection: 'p' });
    expect(calls).toEqual(['after@v3']); // ran once — not duplicated as an extra dev target
  });
});

// ─── CMS dev client ──────────────────────────────────────────────────────────

function sseResponse(blocks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const b of blocks) controller.enqueue(enc.encode(b));
        // Leave the stream open, like a live hub.
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function reloadEvent(code: string, overrides: Partial<ExtensionDevReloadEvent> = {}): ExtensionDevReloadEvent {
  return {
    protocol: EXTENSION_DEV_PROTOCOL,
    name: 'dev-hook',
    type: 'hook',
    version: 1,
    builtAt: new Date().toISOString(),
    sha256: createHash('sha256').update(code).digest('hex'),
    capabilities: [],
    siteId: null,
    ...overrides,
  };
}

describe('extension hot reload — CMS dev client', () => {
  const config = {
    enabled: true as const,
    hubUrl: 'http://127.0.0.1:4790',
    token: TOKEN,
    tokenFile: null,
    hubPort: 4790,
  };

  it('authenticates, verifies the bundle digest and swaps the new version in', async () => {
    const code = 'export const hooks = {};';
    const event = reloadEvent(code, { version: 7 });
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
      if (String(url).endsWith('/events')) {
        return sseResponse([`event: hello\ndata: {"protocol":1,"extensions":[]}\n\n`, `event: reload\ndata: ${JSON.stringify(event)}\n\n`]);
      }
      expect(String(url)).toBe('http://127.0.0.1:4790/bundle/dev-hook?v=7');
      return new Response(code);
    });
    const importModule = vi.fn(async () => ({ hooks: { marker: 7 } }));
    const client = startExtensionDevClient({
      config,
      registry: devExtensionRegistry,
      env: DEV_ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      importModule,
      log: () => undefined,
    });
    await vi.waitFor(() => expect(devExtensionRegistry.snapshot().get('dev-hook')?.version).toBe(7));
    expect(importModule).toHaveBeenCalledWith(code);
    client.stop();
    expect(devExtensionRegistry.isActive()).toBe(false);
  });

  it('rejects a bundle whose sha256 does not match the event', async () => {
    const event = reloadEvent('export const a = 1;');
    const logs: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/events')
        ? sseResponse([`event: reload\ndata: ${JSON.stringify(event)}\n\n`])
        : new Response('export const a = 2; /* tampered */'),
    );
    const client = startExtensionDevClient({
      config,
      registry: devExtensionRegistry,
      env: DEV_ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      importModule: vi.fn(),
      log: (l) => logs.push(l),
    });
    await vi.waitFor(() => expect(logs.some((l) => l.includes('sha256 mismatch'))).toBe(true));
    expect(devExtensionRegistry.snapshot().size).toBe(0);
    client.stop();
  });

  it('ignores UI slot reloads (those belong to Studio)', async () => {
    const event = reloadEvent('x', { type: 'interface' });
    const fetchImpl = vi.fn(async () => sseResponse([`event: reload\ndata: ${JSON.stringify(event)}\n\n`]));
    const client = startExtensionDevClient({
      config,
      registry: devExtensionRegistry,
      env: DEV_ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      importModule: vi.fn(),
      log: () => undefined,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no bundle fetch
    client.stop();
  });

  it('refuses to start in production even if handed an enabled config', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() =>
        startExtensionDevClient({ config, registry: new DevExtensionRegistry(), env: { NODE_ENV: 'production' }, log: () => undefined }),
      ).toThrow(ExtensionDevRefusedError);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('imports real bundle source as a fresh module per version (data URL)', async () => {
    const v1 = 'export default () => ({ hooks: { "items.create.after": async () => "v1" } });';
    const v2 = 'export default () => ({ hooks: { "items.create.after": async () => "v2" } });';
    const events = [reloadEvent(v1, { version: 1 }), reloadEvent(v2, { version: 2 })];
    const codes: Record<string, string> = { '1': v1, '2': v2 };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url));
      if (u.pathname === '/events') {
        return sseResponse(events.map((e) => `event: reload\ndata: ${JSON.stringify(e)}\n\n`));
      }
      return new Response(codes[u.searchParams.get('v') ?? ''] ?? '');
    });
    const client = startExtensionDevClient({
      config,
      registry: devExtensionRegistry,
      env: DEV_ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => undefined,
    });
    await vi.waitFor(() => expect(devExtensionRegistry.snapshot().get('dev-hook')?.version).toBe(2));
    const mod = await new ExtensionSandbox({}).load({ name: 'dev-hook', bundleUrl: 'lumibase-dev:dev-hook', capabilities: [] });
    expect(await mod?.hooks?.['items.create.after']?.({ collection: 'p' })).toBe('v2');
    client.stop();
  });
});
