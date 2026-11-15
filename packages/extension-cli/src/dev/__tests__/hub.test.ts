import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { isLoopbackUrl, parseExtensionDevReloadEvent, supersedesDevBuild } from '@lumibase/contracts/extensions';
import { startDevHub, type DevHub } from '../hub';
import { generateSessionToken, tokensMatch, assertUsableToken, defaultTokenFilePath } from '../session';
import { openSse } from './sse-client';

const TOKEN = generateSessionToken();
let hub: DevHub | null = null;

afterEach(async () => {
  await hub?.close();
  hub = null;
});

/** Raw request so the test controls the Host header (fetch forbids it). */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('session token', () => {
  it('generates 64-hex tokens and compares them in constant time', () => {
    expect(TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(tokensMatch(TOKEN, '')).toBe(false);
    expect(tokensMatch(TOKEN, null)).toBe(false);
  });

  it('rejects pinned tokens too short to be a secret', () => {
    expect(() => assertUsableToken('short')).toThrow(/at least 32/);
  });

  it('derives a per-port token file under the OS temp dir', () => {
    expect(defaultTokenFilePath(4790)).toMatch(/lumibase-ext-dev[\\/]4790\.token$/);
  });
});

describe('wire protocol helpers', () => {
  it('only treats loopback hosts as loopback', () => {
    for (const u of ['http://localhost:1', 'http://127.0.0.1:1', 'http://127.8.9.10', 'http://[::1]:4790']) {
      expect(isLoopbackUrl(u)).toBe(true);
    }
    for (const u of ['http://0.0.0.0:1', 'http://10.0.0.1', 'http://localhost.evil.example', 'file:///tmp/x', 'nope']) {
      expect(isLoopbackUrl(u)).toBe(false);
    }
  });

  it('rejects malformed reload events', () => {
    const ok = {
      protocol: 1, name: 'a', type: 'hook', session: '0123abcd', version: 1, builtAt: 'x',
      sha256: 'a'.repeat(64), capabilities: [], siteId: null,
    };
    expect(parseExtensionDevReloadEvent(ok)).toEqual(ok);
    expect(parseExtensionDevReloadEvent({ ...ok, name: '../etc' })).toBeNull();
    expect(parseExtensionDevReloadEvent({ ...ok, version: 0 })).toBeNull();
    expect(parseExtensionDevReloadEvent({ ...ok, type: 'shell' })).toBeNull();
    expect(parseExtensionDevReloadEvent({ ...ok, protocol: 2 })).toBeNull();
    expect(parseExtensionDevReloadEvent({ ...ok, session: undefined })).toBeNull();
    expect(parseExtensionDevReloadEvent({ ...ok, session: 'x' })).toBeNull();
  });

  it('a restarted CLI session supersedes the old one even with a lower version', () => {
    expect(supersedesDevBuild(undefined, { session: 'aaaa1111', version: 1 })).toBe(true);
    expect(supersedesDevBuild({ session: 'aaaa1111', version: 3 }, { session: 'aaaa1111', version: 3 })).toBe(false);
    expect(supersedesDevBuild({ session: 'aaaa1111', version: 3 }, { session: 'aaaa1111', version: 2 })).toBe(false);
    expect(supersedesDevBuild({ session: 'aaaa1111', version: 3 }, { session: 'aaaa1111', version: 4 })).toBe(true);
    // CLI restarted: its versions start at 1 again.
    expect(supersedesDevBuild({ session: 'aaaa1111', version: 3 }, { session: 'bbbb2222', version: 1 })).toBe(true);
  });
});

describe('dev hub', () => {
  it('refuses to bind a non-loopback interface', async () => {
    await expect(startDevHub({ token: TOKEN, host: '0.0.0.0', port: 0 })).rejects.toThrow(/non-loopback/);
  });

  it('requires the session token on every request', async () => {
    hub = await startDevHub({ token: TOKEN, port: 0 });
    expect((await fetch(`${hub.url}/events`)).status).toBe(401);
    expect((await fetch(`${hub.url}/events?token=${'0'.repeat(64)}`)).status).toBe(401);
    expect((await fetch(`${hub.url}/bundle/x`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('refuses non-loopback Origin and Host (DNS rebinding)', async () => {
    hub = await startDevHub({ token: TOKEN, port: 0 });
    const evil = await fetch(`${hub.url}/bundle/x?token=${TOKEN}`, { headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect(await rawGet(hub.port, `/bundle/x?token=${TOKEN}`, { host: `evil.example:${hub.port}` })).toBe(403);
    expect(await rawGet(hub.port, `/bundle/x?token=${TOKEN}`, { host: `localhost:${hub.port}` })).toBe(404);
  });

  it('answers CORS preflight for a loopback Studio origin', async () => {
    hub = await startDevHub({ token: TOKEN, port: 0 });
    const res = await fetch(`${hub.url}/events`, { method: 'OPTIONS', headers: { origin: 'http://localhost:2026' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:2026');
  });

  it('serves each published build by version and broadcasts reload events', async () => {
    hub = await startDevHub({ token: TOKEN, port: 0, retainVersions: 2 });
    const events: Array<{ event: string; data: unknown }> = [];
    const sse = openSse(`${hub.url}/events?token=${TOKEN}`, {}, (event, data) => events.push({ event, data }));
    await sse.ready;

    const base = { name: 'demo', type: 'hook' as const, capabilities: [], siteId: null };
    hub.publish({ ...base, version: 1, code: 'export default 1;' });
    hub.publish({ ...base, version: 2, code: 'export default 2;' });
    hub.publish({ ...base, version: 3, code: 'export default 3;' });

    const get = (q: string) => fetch(`${hub!.url}/bundle/demo${q}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(await (await get('?v=3')).text()).toBe('export default 3;');
    expect(await (await get('?v=2')).text()).toBe('export default 2;');
    expect((await get('?v=1')).status).toBe(404); // evicted (retainVersions: 2)
    expect(await (await get('')).text()).toBe('export default 3;');

    await expect.poll(() => events.filter((e) => e.event === 'reload').length).toBe(3);
    const last = events.filter((e) => e.event === 'reload').pop()?.data as { version: number; sha256: string };
    expect(last.version).toBe(3);
    expect(last.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((last as { session?: string }).session).toBe(hub.session);
    expect(hub.session).toMatch(/^[0-9a-f]{16}$/);
    sse.close();
  });

  it('greets late subscribers with the latest build of every extension', async () => {
    hub = await startDevHub({ token: TOKEN, port: 0 });
    hub.publish({ name: 'late', type: 'panel', version: 4, capabilities: [], siteId: null, code: 'x' });
    let hello: unknown = null;
    const sse = openSse(`${hub.url}/events`, { headers: { authorization: `Bearer ${TOKEN}` } }, (event, data) => {
      if (event === 'hello') hello = data;
    });
    await sse.ready;
    expect((hello as { extensions: Array<{ name: string; version: number }> }).extensions).toEqual([
      expect.objectContaining({ name: 'late', version: 4 }),
    ]);
    sse.close();
  });
});
