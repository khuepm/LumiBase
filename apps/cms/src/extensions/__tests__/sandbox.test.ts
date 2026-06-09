import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import { CapabilityError, ExtensionSandbox, type ExtensionActorDataAccess } from '../sandbox';

declare global {
  // eslint-disable-next-line no-var
  var __lumibaseExtensionCtx: Record<string, unknown> | undefined;
}

function bundleUrl(name: string): string {
  const source = `export default (ctx) => { globalThis.__lumibaseExtensionCtx = ctx; return {}; }`;
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source + `\n//# sourceURL=${name}.js`)}`;
}

async function loadCtx(
  capabilities: string[],
  deps: {
    db?: Database;
    actorDataAccess?: ExtensionActorDataAccess;
    audit?: ConstructorParameters<typeof ExtensionSandbox>[3];
  } = {},
) {
  globalThis.__lumibaseExtensionCtx = undefined;
  const sandbox = new ExtensionSandbox({}, deps.db, deps.actorDataAccess, deps.audit);
  vi.spyOn(sandbox as any, 'isTrustedBundleUrl').mockReturnValue(true);
  await sandbox.load({
    name: `test_${capabilities.join('_') || 'actor'}`,
    bundleUrl: bundleUrl(`test_${capabilities.join('_') || 'actor'}`),
    capabilities,
  });
  return globalThis.__lumibaseExtensionCtx!;
}

describe('ExtensionSandbox data access', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('exposes actor-scoped item helpers for default extension data access', async () => {
    const actorDataAccess = {
      list: vi.fn().mockResolvedValue({ data: [{ id: 'post_1' }] }),
      detail: vi.fn(),
      create: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };
    const ctx = await loadCtx([], { actorDataAccess });

    await expect((ctx.items as any).list('posts', { limit: 1 })).resolves.toEqual({
      data: [{ id: 'post_1' }],
    });
    expect(actorDataAccess.list).toHaveBeenCalledWith('posts', { limit: 1 });
  });

  it('blocks raw DB reads without the service-account capability', async () => {
    const db = { execute: vi.fn() } as unknown as Database;
    const ctx = await loadCtx(['db:read'], { db });

    await expect((ctx.db as any).query('SELECT 1')).rejects.toBeInstanceOf(CapabilityError);
    expect(db.execute).not.toHaveBeenCalled();
  });



  it('blocks extension http:fetch calls to private network targets', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const ctx = await loadCtx(['http:fetch']);

    await expect((ctx.fetch as any)('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/blocked/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows extension http:fetch calls to public HTTPS targets', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const ctx = await loadCtx(['http:fetch']);

    await expect((ctx.fetch as any)('https://example.com/api')).resolves.toBeInstanceOf(Response);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/api', undefined);
  });

  it('audits service-account raw DB reads and writes', async () => {
    const db = { execute: vi.fn().mockResolvedValue([{ ok: true }]) } as unknown as Database;
    const audit = vi.fn().mockResolvedValue(undefined);
    const ctx = await loadCtx(['db:read', 'db:write', 'service-account'], { db, audit });

    await expect((ctx.db as any).query("SELECT * FROM posts WHERE title = 'secret'")).resolves.toEqual([{ ok: true }]);
    await expect((ctx.db as any).execute("UPDATE posts SET title = 'secret'")).resolves.toEqual([{ ok: true }]);

    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith({
      extensionName: 'test_db:read_db:write_service-account',
      operation: 'query',
      statement: "SELECT * FROM posts WHERE title = 'secret'",
    });
    expect(audit).toHaveBeenCalledWith({
      extensionName: 'test_db:read_db:write_service-account',
      operation: 'execute',
      statement: "UPDATE posts SET title = 'secret'",
    });
  });
});
