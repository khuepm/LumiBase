import type { Context } from 'hono';

import type { AppEnv } from '../env';

/**
 * Run `promise` detached from the response. On Workers it hands off to
 * `executionCtx.waitUntil`; on Node/Docker/tests it's fire-and-forget.
 *
 * Hono's `c.executionCtx` getter *throws* (`This context has no
 * ExecutionContext`) when no context is bound (Node / Docker / tests), so the
 * probe MUST be wrapped in try/catch — optional chaining (`c.executionCtx?.x`)
 * does not guard against a throw during the getter itself. Mirrors
 * `scheduleWorkersDrain` in the notifications dispatcher.
 */
export function runDetached(c: Context<AppEnv>, promise: Promise<unknown>): void {
  try {
    const ctx = c.executionCtx as { waitUntil?: (p: Promise<unknown>) => void } | undefined;
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(promise);
      return;
    }
  } catch {
    // No execution context bound — fall through to fire-and-forget.
  }
  void promise;
}
