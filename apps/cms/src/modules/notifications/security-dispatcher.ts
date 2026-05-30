/**
 * Process-level security-notification dispatcher accessor
 * (admin-setup-wizard task 9.5 / Req 13.1; design §6.3, §9.4).
 *
 * The `/auth/login` route (and any future LoginGuard call site) needs
 * a {@link NotificationDispatcher} to hand into the hooks so the four
 * Req 13.1 events (`user_locked`, `ip_blocked`, `anomaly_triggered`,
 * `anomaly_lock`) reach the operator's configured channels. This
 * module owns the *lifecycle* of that dispatcher so the route handler
 * stays declarative.
 *
 * ── Why a process singleton (not a per-request instance) ───────────────
 *
 * The {@link InProcessNotificationDispatcher} holds an in-memory retry
 * queue and a per-`(event,email)` rate-limit table, and drains the
 * queue on a 250ms `setInterval` worker tick (design §9.4). Two
 * constraints fall out of that:
 *
 *   1. **Leak-free.** Calling `start()` per request would spawn a new
 *      interval on every login — an unbounded timer leak. We therefore
 *      construct the dispatcher **once** per process and `start()` it
 *      **once** (for the Node runtime, where a long-running background
 *      loop is available). The interval is `unref()`d inside `start()`
 *      so it never keeps the process alive on its own.
 *
 *   2. **Stateful across requests.** The retry queue and the 60s
 *      rate-limit window (Req 13.5) only make sense if they persist
 *      between requests. A fresh per-request dispatcher would lose
 *      every queued retry and reset the rate-limit window on each
 *      login, defeating both features. The singleton preserves them.
 *
 * This mirrors the established module-singleton pattern already used
 * for the Docker runtime (`middleware/runtime.ts`) and the dummy
 * password hash (`routes/auth.ts`).
 *
 * ── Runtime split (Node vs Cloudflare Workers) ─────────────────────────
 *
 * On the **Node / Docker** runtime we `start()` the background tick so
 * queued notifications actually drain. On **Cloudflare Workers** there
 * is no long-running process to host a `setInterval`, so we
 * deliberately do **not** `start()` here — task 9.6 wires
 * `ctx.waitUntil(...)` to drive {@link InProcessNotificationDispatcher
 * .processTick} per request instead. Until 9.6 lands, dispatch on
 * Workers still enqueues correctly (the hooks' dispatch is
 * fire-and-forget); only the *drain* is deferred. Threading the
 * dispatcher in here is the scope of task 9.5; the Workers drain path
 * is 9.6.
 *
 * ── Channel registration ───────────────────────────────────────────────
 *
 * Channels are (re)resolved on every accessor call from the current
 * env + policy so a policy change (e.g. a freshly-set webhook URL) is
 * picked up without a process restart:
 *
 *   - email   → {@link EmailChannelFactory.fromEnv} (null when no SMTP
 *               / MailChannels transport is available — degraded mode).
 *   - webhook → {@link WebhookChannelFactory.fromPolicy} (null when the
 *               policy has no `webhookUrl` + `webhookSecret`).
 *
 * Only non-null adapters are registered. The dispatcher keys adapters
 * by name, so re-registering atomically swaps the live adapter without
 * disturbing in-flight tasks (which hold their own adapter reference).
 *
 * Validates: Requirements 13.1 — see also design §6.3, §9.4.
 */

import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import type { LockoutPolicy } from '../setup/policy-codec';
import {
  createNotificationDispatcher,
  type InProcessNotificationDispatcher,
} from './dispatcher';
import { EmailChannelFactory } from './email-channel';
import { WebhookChannelFactory } from './webhook-channel';

/**
 * The one dispatcher per process. Lazily constructed on first use so a
 * deployment that never triggers a security event pays nothing.
 */
let singleton: InProcessNotificationDispatcher | null = null;

/**
 * Resolve the process-level security dispatcher, (re)registering the
 * email + webhook channels from the supplied env / policy.
 *
 * @param env    Hono `Bindings` — read for `LUMIBASE_RUNTIME` (to
 *               decide whether to start the Node tick) and the SMTP /
 *               MailChannels config the email factory consumes.
 * @param policy The active {@link LockoutPolicy}; `webhookUrl` /
 *               `webhookSecret` drive the webhook channel factory.
 * @returns      The shared dispatcher, ready for
 *               `dispatch(event, channels, payload)`.
 */
export function getSecurityNotificationDispatcher(
  env: AppEnv['Bindings'],
  policy: LockoutPolicy,
): InProcessNotificationDispatcher {
  if (!singleton) {
    singleton = createNotificationDispatcher();
    // Only the long-running Node runtime can host the background
    // drain loop; on Cloudflare Workers task 9.6 drives the drain via
    // `ctx.waitUntil` + `processTick`. `start()` is idempotent and
    // `unref()`s its interval, so this is safe to call once here.
    if (resolveRuntime(env) !== 'cloudflare') {
      singleton.start();
    }
  }

  // Refresh channels from the current env + policy. `registerChannel`
  // replaces by adapter name, so this picks up a newly-configured SMTP
  // transport or rotated webhook secret on the next login.
  const email = EmailChannelFactory.fromEnv(env);
  if (email) singleton.registerChannel(email);

  const webhook = WebhookChannelFactory.fromPolicy(policy);
  if (webhook) singleton.registerChannel(webhook);

  return singleton;
}

/**
 * On the Cloudflare Workers runtime, keep the dispatcher's queued
 * deliveries alive past the HTTP response by handing the drain to
 * `ctx.waitUntil(...)` (admin-setup-wizard task 9.6 / Req 13.4;
 * design §9.4).
 *
 * ── Why this exists ────────────────────────────────────────────────────
 *
 * The `/login` hooks enqueue notifications fire-and-forget, but on
 * Workers nothing drains that queue: there's no long-running process,
 * so {@link getSecurityNotificationDispatcher} deliberately skips
 * `start()` on `runtime='cloudflare'`. Without intervention the
 * isolate is torn down the instant the response is returned and the
 * queued `user_locked` / `ip_blocked` / `anomaly_*` notifications
 * never go out.
 *
 * `ctx.waitUntil(promise)` is the Workers primitive for exactly this:
 * it tells the runtime "don't kill me until this promise settles"
 * **without** making the response wait for it. So the login response
 * returns immediately (best-effort, non-blocking per Req 13.4) while
 * the runtime keeps the isolate alive long enough for
 * {@link InProcessNotificationDispatcher.drain} to walk the retry
 * schedule — bounded by the ~30s Worker execution ceiling the design
 * flags.
 *
 * ── Runtime gating ─────────────────────────────────────────────────────
 *
 *   - **Cloudflare only.** On Node the background `setInterval` tick
 *     already drains the queue, so scheduling a `waitUntil` drain
 *     there would double-drain (harmless) and, more importantly, isn't
 *     needed — this is a no-op off Workers.
 *   - **Only when there's work.** If `pendingCount === 0` there's
 *     nothing to keep alive, so we skip the `waitUntil` call entirely
 *     (no empty promise, no wasted budget).
 *
 * ── Defensive `c.executionCtx` access ──────────────────────────────────
 *
 * Hono's `c.executionCtx` getter **throws** when there is no execution
 * context bound to the request — which is the case under Node's
 * `@hono/node-server` and in most test harnesses. Reading it
 * unguarded would turn a missing context into a 500 on the login path.
 * We therefore probe it inside a `try/catch` and bail quietly if it's
 * absent or doesn't expose `waitUntil`. Belt-and-brace: the
 * `waitUntil(...)` call itself is also guarded so a runtime that
 * surfaces a malformed context can never break the response.
 *
 * Call this once near the end of the `/login` handler, **before** each
 * `return c.json(...)` — `waitUntil` must be invoked during the
 * request (synchronously, before the response is finalised); the drain
 * promise it receives then runs after the response is sent.
 *
 * @param c          The Hono request context.
 * @param dispatcher The process dispatcher whose queue should drain.
 * @param env        Hono `Bindings` — read for `LUMIBASE_RUNTIME`.
 *
 * Validates: Requirements 13.4 — see also design §9.4.
 */
export function scheduleWorkersDrain(
  c: Context<AppEnv>,
  dispatcher: InProcessNotificationDispatcher,
  env: AppEnv['Bindings'],
): void {
  // Node drains via the background tick; this path is Workers-only.
  if (resolveRuntime(env) !== 'cloudflare') return;

  // Nothing queued → nothing to keep the isolate alive for.
  if (dispatcher.pendingCount === 0) return;

  // `c.executionCtx` throws when no execution context is bound (Node /
  // tests). Probe defensively so a missing context never 500s login.
  let executionCtx: ExecutionContextLike | null = null;
  try {
    const ctx = c.executionCtx as unknown as ExecutionContextLike | undefined;
    if (ctx && typeof ctx.waitUntil === 'function') {
      executionCtx = ctx;
    }
  } catch {
    // No execution context available — best-effort no-op.
    executionCtx = null;
  }
  if (!executionCtx) return;

  // Hand the bounded drain to the runtime. `drain()` never throws (it
  // logs + swallows internally), so the promise always settles and
  // can't surface an unhandled rejection inside waitUntil.
  try {
    executionCtx.waitUntil(dispatcher.drain());
  } catch {
    // A runtime that rejects waitUntil (e.g. context already closed)
    // must not break the response — swallow.
  }
}

/**
 * Minimal structural view of the Cloudflare Workers `ExecutionContext`
 * — just the `waitUntil` method {@link scheduleWorkersDrain} needs.
 * Declared locally so this module doesn't take a hard dependency on
 * `@cloudflare/workers-types`, matching the loose typing the rest of
 * the runtime-split code uses.
 */
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Test seam — drop the process singleton (and stop its tick if
 * running) so a test file can observe the first-construction behaviour
 * deterministically and not leak an interval across test files.
 */
export function __resetSecurityNotificationDispatcherForTests(): void {
  if (singleton) {
    singleton.stop();
    singleton = null;
  }
}

/**
 * Read `LUMIBASE_RUNTIME` off the Hono bindings, defaulting to
 * `'docker'`. Mirrors the resolution in `email-channel.ts` /
 * `middleware/runtime.ts` so the runtime decision stays consistent
 * across the codebase.
 */
function resolveRuntime(env: AppEnv['Bindings']): string {
  const v = (env as unknown as Record<string, unknown>).LUMIBASE_RUNTIME;
  return typeof v === 'string' && v.length > 0 ? v : 'docker';
}
