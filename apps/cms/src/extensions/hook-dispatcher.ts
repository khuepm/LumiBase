/**
 * HookDispatcher — before/after item mutation hooks for extensions.
 *
 * Integrates with ExtensionSandbox to load enabled extensions and call
 * their hook handlers at the right points in the ItemService lifecycle.
 *
 * Hook events:
 *   items.create.before  — can mutate `item.data` before insert
 *   items.create.after   — called with the inserted item
 *   items.update.before  — can mutate `patch.data` before update
 *   items.update.after   — called with the updated item
 *   items.delete.before  — can cancel delete by throwing
 *   items.delete.after   — called after soft-delete
 *
 * A hook that returns a plain object merges its result into the payload.
 * A hook that throws aborts the operation and re-throws (caller must catch).
 *
 * Usage (in ItemService):
 *   const dispatcher = new HookDispatcher(sandbox, enabledExtensions);
 *   const finalData = await dispatcher.dispatch('items.create.before', ctx);
 *   // ... perform DB mutation ...
 *   await dispatcher.dispatch('items.create.after', ctx);
 */

import type { extensions as extensionsTable } from '@lumibase/database';
import type { InferSelectModel } from 'drizzle-orm';
import { ExtensionSandbox, type ExtensionHookContext } from './sandbox';
import { formatSafeError } from '@lumibase/shared/utils';

type ExtensionRow = InferSelectModel<typeof extensionsTable>;

export type HookEvent =
  | 'items.create.before'
  | 'items.create.after'
  | 'items.update.before'
  | 'items.update.after'
  | 'items.delete.before'
  | 'items.delete.after';

/** Default wall-clock budget for a single hook handler invocation (ms). */
const DEFAULT_HOOK_TIMEOUT_MS = 5000;

/** Thrown when an extension hook handler exceeds its time budget. */
export class HookTimeoutError extends Error {
  constructor(event: string, extension: string, timeoutMs: number) {
    super(`Extension "${extension}" hook ${event} timed out after ${timeoutMs}ms`);
    this.name = 'HookTimeoutError';
  }
}

/**
 * Race a hook handler against a timeout. A runaway handler (infinite loop,
 * never-resolving promise) can otherwise stall every item mutation, so we cap
 * each invocation. The handler keeps running in the background if it ignores
 * the timeout, but the dispatcher stops waiting and treats it as a failure.
 */
function withTimeout<T>(
  work: Promise<T>,
  event: string,
  extension: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new HookTimeoutError(event, extension, timeoutMs)),
      timeoutMs,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class HookDispatcher {
  constructor(
    private readonly sandbox: ExtensionSandbox,
    private readonly extensions: ExtensionRow[],
    private readonly hookTimeoutMs: number = DEFAULT_HOOK_TIMEOUT_MS,
  ) {}

  /**
   * Dispatch a hook event to all enabled extensions that declare the hook.
   *
   * Before hooks may return an updated context payload (merged into ctx).
   * After hooks return value is ignored (fire-and-forget semantics).
   *
   * @returns Possibly-mutated context (for before hooks).
   */
  async dispatch(event: HookEvent, ctx: ExtensionHookContext): Promise<ExtensionHookContext> {
    const enabled = this.extensions.filter((e) => e.enabled && e.type === 'hook');
    let current = { ...ctx };

    for (const ext of enabled) {
      const mod = await this.sandbox.load({
        name: ext.name,
        bundleUrl: ext.bundleUrl,
        capabilities: (ext.capabilities as string[]) ?? [],
      });

      if (!mod?.hooks?.[event]) continue;

      try {
        const result = await withTimeout(
          Promise.resolve(mod.hooks[event]!(current)),
          event,
          ext.name,
          this.hookTimeoutMs,
        );
        // Before hooks: merge returned object into context.
        if (event.endsWith('.before') && result && typeof result === 'object') {
          current = { ...current, ...result };
        }
      } catch (err) {
        if (event.endsWith('.before')) {
          // Before-hook abort — re-throw to cancel the mutation.
          console.error(`[hook-dispatcher] extension "${ext.name}" aborted ${event}:`, formatSafeError(err));
          throw err;
        } else {
          // After-hook error — log and continue (don't break the response).
          console.error(`[hook-dispatcher] extension "${ext.name}" errored in ${event}:`, formatSafeError(err));
        }
      }
    }

    return current;
  }
}
