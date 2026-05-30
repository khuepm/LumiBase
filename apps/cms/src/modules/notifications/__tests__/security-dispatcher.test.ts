import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  getSecurityNotificationDispatcher,
  scheduleWorkersDrain,
  __resetSecurityNotificationDispatcherForTests,
} from '../security-dispatcher';
import {
  createNotificationDispatcher,
  InProcessNotificationDispatcher,
} from '../dispatcher';
import {
  STANDARD_LOCKOUT_POLICY,
  type LockoutPolicy,
} from '../../setup/policy-codec';
import type { AppEnv } from '../../../env';
import type { Context } from 'hono';
import type {
  DeliveryResult,
  NotificationChannel,
  NotificationChannelAdapter,
  NotificationPayload,
} from '../types';

/**
 * Unit tests for the process-level security dispatcher accessor
 * (admin-setup-wizard task 9.5 / Req 13.1; design §6.3, §9.4).
 *
 * Focus: the route-level wiring contract —
 *   - one dispatcher per process (singleton, leak-free start),
 *   - email/webhook channels (re)registered from env + policy,
 *   - only non-null adapters registered,
 *   - Node runtime starts the background tick; Cloudflare does not.
 *
 * **Validates: Requirements 13.1**
 */

function freshPolicy(overrides?: Partial<LockoutPolicy>): LockoutPolicy {
  return {
    ...STANDARD_LOCKOUT_POLICY,
    notifyChannels: [...STANDARD_LOCKOUT_POLICY.notifyChannels],
    ...overrides,
  };
}

function envOf(extra: Record<string, string> = {}): AppEnv['Bindings'] {
  return { LUMIBASE_ENV: 'test', ...extra } as unknown as AppEnv['Bindings'];
}

afterEach(() => {
  __resetSecurityNotificationDispatcherForTests();
  vi.restoreAllMocks();
});

describe('getSecurityNotificationDispatcher', () => {
  it('returns the same singleton across calls', () => {
    const a = getSecurityNotificationDispatcher(envOf(), freshPolicy());
    const b = getSecurityNotificationDispatcher(envOf(), freshPolicy());
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(InProcessNotificationDispatcher);
  });

  it('starts the background tick exactly once on the Node runtime (leak-free)', () => {
    const startSpy = vi.spyOn(
      InProcessNotificationDispatcher.prototype,
      'start',
    );
    getSecurityNotificationDispatcher(envOf(), freshPolicy());
    getSecurityNotificationDispatcher(envOf(), freshPolicy());
    getSecurityNotificationDispatcher(envOf(), freshPolicy());
    // Constructed once → start called once, regardless of how many
    // times the accessor is called per request.
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT start the background tick on the Cloudflare runtime (task 9.6 owns the drain)', () => {
    const startSpy = vi.spyOn(
      InProcessNotificationDispatcher.prototype,
      'start',
    );
    getSecurityNotificationDispatcher(
      envOf({ LUMIBASE_RUNTIME: 'cloudflare' }),
      freshPolicy(),
    );
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('registers a webhook channel when the policy carries webhookUrl + webhookSecret', () => {
    const regSpy = vi.spyOn(
      InProcessNotificationDispatcher.prototype,
      'registerChannel',
    );
    getSecurityNotificationDispatcher(
      envOf(),
      freshPolicy({
        webhookUrl: 'https://hooks.example.com/lumibase',
        webhookSecret: 'shhh-very-secret',
      }),
    );
    const names = regSpy.mock.calls.map((c) => c[0]!.name);
    expect(names).toContain('webhook');
  });

  it('does NOT register a webhook channel when the policy has no webhook config', () => {
    const regSpy = vi.spyOn(
      InProcessNotificationDispatcher.prototype,
      'registerChannel',
    );
    getSecurityNotificationDispatcher(envOf(), freshPolicy());
    const names = regSpy.mock.calls.map((c) => c[0]!.name);
    expect(names).not.toContain('webhook');
  });

  it('registers an email channel when SMTP is configured (Node runtime)', () => {
    const regSpy = vi.spyOn(
      InProcessNotificationDispatcher.prototype,
      'registerChannel',
    );
    getSecurityNotificationDispatcher(
      envOf({ LUMIBASE_SMTP_URL: 'smtp://user:pass@localhost:1025' }),
      freshPolicy(),
    );
    const names = regSpy.mock.calls.map((c) => c[0]!.name);
    expect(names).toContain('email');
  });

  it('does NOT register an email channel in degraded mode (no SMTP on Node)', () => {
    const regSpy = vi.spyOn(
      InProcessNotificationDispatcher.prototype,
      'registerChannel',
    );
    getSecurityNotificationDispatcher(envOf(), freshPolicy());
    const names = regSpy.mock.calls.map((c) => c[0]!.name);
    expect(names).not.toContain('email');
  });
});

// ── scheduleWorkersDrain (task 9.6 / Req 13.4; design §9.4) ────────────

/**
 * A no-op channel adapter used to seed the dispatcher queue so
 * `pendingCount` is non-zero (a dispatch with no registered adapter
 * would otherwise enqueue nothing).
 */
class StubChannel implements NotificationChannelAdapter {
  constructor(readonly name: NotificationChannel) {}
  send(_payload: NotificationPayload): Promise<DeliveryResult> {
    return Promise.resolve({ ok: true });
  }
}

const stubPayload: NotificationPayload = {
  event: 'user_locked',
  timestamp: '2025-01-15T10:20:30.000Z',
  email: 'admin@example.com',
  ip: '203.0.113.5',
  country: 'US',
  userAgent: 'Mozilla/5.0',
  anomalyScore: null,
  action: 'locked',
};

/**
 * Build a dispatcher whose clock is frozen (so the seeded task never
 * actually sends during these synchronous assertions) and optionally
 * pre-load `n` pending tasks. `drain` is stubbed in the tests that
 * assert on it, so the frozen clock just keeps the queue stable.
 */
async function dispatcherWithPending(
  n: number,
): Promise<InProcessNotificationDispatcher> {
  const d = createNotificationDispatcher({
    channels: [new StubChannel('email')],
    now: () => 0,
  });
  for (let i = 0; i < n; i++) {
    // Distinct event per dispatch so the (event,email) rate-limit
    // window doesn't suppress the second+ enqueue.
    const event = i === 0 ? 'user_locked' : 'ip_blocked';
    await d.dispatch(event, ['email'], { ...stubPayload, event });
  }
  return d;
}

/**
 * Minimal Hono-context double exposing only what `scheduleWorkersDrain`
 * touches: `env` and the `executionCtx` getter. `executionCtx` is
 * modelled as a getter so we can make it *throw* (Hono's real getter
 * throws when no execution context is bound — the Node / test case).
 */
function makeCtx(opts: {
  env: AppEnv['Bindings'];
  waitUntil?: (p: Promise<unknown>) => void;
  throwOnExecutionCtx?: boolean;
}): Context<AppEnv> {
  const { env, waitUntil, throwOnExecutionCtx } = opts;
  const ctx = {
    env,
    get executionCtx() {
      if (throwOnExecutionCtx) {
        throw new Error('This context has no ExecutionContext');
      }
      return waitUntil ? { waitUntil } : undefined;
    },
  };
  return ctx as unknown as Context<AppEnv>;
}

describe('scheduleWorkersDrain', () => {
  it('calls executionCtx.waitUntil with the drain promise on Cloudflare when tasks are pending', async () => {
    const dispatcher = await dispatcherWithPending(1);
    const drainSpy = vi
      .spyOn(dispatcher, 'drain')
      .mockResolvedValue(undefined);
    const waitUntil = vi.fn<(p: Promise<unknown>) => void>();
    const c = makeCtx({
      env: envOf({ LUMIBASE_RUNTIME: 'cloudflare' }),
      waitUntil,
    });

    scheduleWorkersDrain(c, dispatcher, c.env);

    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    // The promise handed to waitUntil is exactly the drain() result.
    expect(waitUntil.mock.calls[0]![0]).toBeInstanceOf(Promise);
  });

  it('does NOT schedule a drain on the Node runtime (the setInterval tick handles it)', async () => {
    const dispatcher = await dispatcherWithPending(1);
    const drainSpy = vi
      .spyOn(dispatcher, 'drain')
      .mockResolvedValue(undefined);
    const waitUntil = vi.fn<(p: Promise<unknown>) => void>();
    // Default runtime (no LUMIBASE_RUNTIME) resolves to 'docker' → Node.
    const c = makeCtx({ env: envOf(), waitUntil });

    scheduleWorkersDrain(c, dispatcher, c.env);

    expect(drainSpy).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('does NOT schedule a drain on Cloudflare when the queue is empty', async () => {
    const dispatcher = await dispatcherWithPending(0);
    const drainSpy = vi
      .spyOn(dispatcher, 'drain')
      .mockResolvedValue(undefined);
    const waitUntil = vi.fn<(p: Promise<unknown>) => void>();
    const c = makeCtx({
      env: envOf({ LUMIBASE_RUNTIME: 'cloudflare' }),
      waitUntil,
    });

    scheduleWorkersDrain(c, dispatcher, c.env);

    expect(dispatcher.pendingCount).toBe(0);
    expect(drainSpy).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('does not throw when executionCtx is absent (Node/test) even on the cloudflare branch', async () => {
    const dispatcher = await dispatcherWithPending(1);
    const drainSpy = vi
      .spyOn(dispatcher, 'drain')
      .mockResolvedValue(undefined);
    // Cloudflare runtime + pending tasks, but executionCtx getter throws.
    const c = makeCtx({
      env: envOf({ LUMIBASE_RUNTIME: 'cloudflare' }),
      throwOnExecutionCtx: true,
    });

    expect(() => scheduleWorkersDrain(c, dispatcher, c.env)).not.toThrow();
    // No execution context to attach to → drain not invoked.
    expect(drainSpy).not.toHaveBeenCalled();
  });

  it('does not throw when executionCtx lacks a waitUntil method', async () => {
    const dispatcher = await dispatcherWithPending(1);
    const drainSpy = vi
      .spyOn(dispatcher, 'drain')
      .mockResolvedValue(undefined);
    // executionCtx present but no waitUntil (waitUntil omitted → undefined ctx).
    const c = makeCtx({
      env: envOf({ LUMIBASE_RUNTIME: 'cloudflare' }),
    });

    expect(() => scheduleWorkersDrain(c, dispatcher, c.env)).not.toThrow();
    expect(drainSpy).not.toHaveBeenCalled();
  });
});
