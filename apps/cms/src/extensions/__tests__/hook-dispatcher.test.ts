import { describe, expect, it, vi } from 'vitest';
import type { InferSelectModel } from 'drizzle-orm';
import type { extensions as extensionsTable } from '@lumibase/database';
import { HookDispatcher, HookTimeoutError } from '../hook-dispatcher';
import type { ExtensionSandbox } from '../sandbox';

type ExtensionRow = InferSelectModel<typeof extensionsTable>;

/** Minimal hook extension row; only the fields the dispatcher reads matter. */
function hookExtension(name: string): ExtensionRow {
  return {
    name,
    type: 'hook',
    enabled: true,
    bundleUrl: 'data:text/javascript,export default {}',
    capabilities: [],
  } as unknown as ExtensionRow;
}

/** Sandbox stub whose `load` returns a module with the given hook handler. */
function sandboxWithHandler(
  event: string,
  handler: (ctx: unknown) => unknown,
): ExtensionSandbox {
  return {
    load: vi.fn().mockResolvedValue({ hooks: { [event]: handler } }),
  } as unknown as ExtensionSandbox;
}

const baseCtx = { siteId: 'site_1', collection: 'posts', data: {} } as never;

describe('HookDispatcher timeout', () => {
  it('aborts a runaway before-hook and re-throws HookTimeoutError', async () => {
    const sandbox = sandboxWithHandler(
      'items.create.before',
      () => new Promise(() => {}), // never resolves
    );
    const dispatcher = new HookDispatcher(sandbox, [hookExtension('runaway')], 30);

    await expect(dispatcher.dispatch('items.create.before', baseCtx)).rejects.toBeInstanceOf(
      HookTimeoutError,
    );
  });

  it('swallows a runaway after-hook (logs, does not throw)', async () => {
    const sandbox = sandboxWithHandler(
      'items.create.after',
      () => new Promise(() => {}),
    );
    const dispatcher = new HookDispatcher(sandbox, [hookExtension('slow')], 30);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await dispatcher.dispatch('items.create.after', baseCtx);

    expect(result).toBeDefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('runs a fast before-hook normally and merges its result', async () => {
    const sandbox = sandboxWithHandler('items.create.before', () => ({ data: { ok: true } }));
    const dispatcher = new HookDispatcher(sandbox, [hookExtension('fast')], 1000);

    const result = await dispatcher.dispatch('items.create.before', baseCtx);

    expect((result as unknown as { data: { ok: boolean } }).data.ok).toBe(true);
  });
});
