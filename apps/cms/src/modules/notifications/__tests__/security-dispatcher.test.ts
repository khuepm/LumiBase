import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  getSecurityNotificationDispatcher,
  __resetSecurityNotificationDispatcherForTests,
} from '../security-dispatcher';
import { InProcessNotificationDispatcher } from '../dispatcher';
import {
  STANDARD_LOCKOUT_POLICY,
  type LockoutPolicy,
} from '../../setup/policy-codec';
import type { AppEnv } from '../../../env';

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
