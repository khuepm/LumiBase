import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  DEFAULT_PASSWORD_POLICY,
  PASSWORD_SPECIAL_CHARS,
  PasswordPolicySchema,
  estimatePasswordStrength,
  evaluatePasswordPolicy,
  toPublicPasswordPolicy,
  type PasswordPolicy,
} from '@lumibase/contracts/schemas';

import {
  createHibpBreachChecker,
  enforcePasswordPolicy,
  loadPasswordPolicy,
  type BreachChecker,
} from '../password-policy';

/**
 * Password policy service (#733). No test here touches the network: the HIBP
 * checker always gets an injected `fetch`, and `enforcePasswordPolicy` an
 * injected checker.
 */

const policy = (over: Partial<PasswordPolicy> = {}): PasswordPolicy => ({ ...DEFAULT_PASSWORD_POLICY, ...over });
const failed = (rules: ReadonlyArray<{ rule: string; ok: boolean }>) => rules.filter((r) => !r.ok).map((r) => r.rule);

async function sha1Upper(value: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

describe('default policy', () => {
  it('is the pre-#733 baseline plus a "fair" strength floor, breach check OFF', () => {
    expect(DEFAULT_PASSWORD_POLICY).toEqual({
      minLength: 12,
      requireLowercase: true,
      requireUppercase: true,
      requireDigit: true,
      requireSpecial: true,
      minStrength: 2,
      breachCheck: false,
    });
  });

  it('rejects out-of-range and unknown settings', () => {
    expect(PasswordPolicySchema.safeParse({ minLength: 6 }).success).toBe(false);
    expect(PasswordPolicySchema.safeParse({ minStrength: 5 }).success).toBe(false);
    expect(PasswordPolicySchema.safeParse({ hibpApiKey: 'x' }).success).toBe(false);
  });

  it('public view adds only max length + special-char set', () => {
    expect(toPublicPasswordPolicy(DEFAULT_PASSWORD_POLICY)).toEqual({
      ...DEFAULT_PASSWORD_POLICY,
      maxLength: 256,
      specialChars: PASSWORD_SPECIAL_CHARS,
    });
  });
});

describe('evaluatePasswordPolicy — names every failed rule', () => {
  it('reports each failed class and the length with its parameters', () => {
    const r = evaluatePasswordPolicy('abc', policy());
    expect(r.ok).toBe(false);
    expect(failed(r.rules)).toEqual(['min_length', 'uppercase', 'digit', 'special', 'min_strength']);
    expect(r.rules.find((x) => x.rule === 'min_length')).toMatchObject({ ok: false, min: 12, actual: 3 });
    expect(r.rules.find((x) => x.rule === 'special')).toMatchObject({ chars: PASSWORD_SPECIAL_CHARS });
  });

  it('flags a guessable password that passes every class rule, with the reason', () => {
    const r = evaluatePasswordPolicy('Password1234!', policy());
    expect(failed(r.rules)).toEqual(['min_strength']);
    const rule = r.rules.find((x) => x.rule === 'min_strength')!;
    expect(rule.weaknesses).toContain('common_password');
    expect(rule.message).toMatch(/commonly used password/);
  });

  it('counts the user e-mail / name against the score', () => {
    const pw = 'Janedoe!2024xq';
    expect(estimatePasswordStrength(pw, ['jane.doe@example.com']).weaknesses).toContain('contains_user_input');
    expect(estimatePasswordStrength(pw, ['jane.doe@example.com']).score).toBeLessThan(
      estimatePasswordStrength(pw).score,
    );
  });

  it('honours a configured policy (longer min, classes off, strength off)', () => {
    const custom = policy({ minLength: 16, requireSpecial: false, requireUppercase: false, minStrength: 0 });
    expect(failed(evaluatePasswordPolicy('lowercase digits 1', custom).rules)).toEqual([]);
    expect(failed(evaluatePasswordPolicy('short 1a', custom).rules)).toEqual(['min_length']);
    expect(evaluatePasswordPolicy('x', custom).rules.map((r) => r.rule)).not.toContain('special');
  });

  it('accepts the existing fixture passwords (non-breaking default)', () => {
    for (const pw of ['CorrectHorseBatteryStaple!42', 'NewStrongPass!42', 'Sup3r$ecret!Pass', 'Golden-Path-E2E-1!']) {
      expect(evaluatePasswordPolicy(pw).ok, pw).toBe(true);
    }
  });

  it('property: class/length verdicts match an independent oracle, ok ⇔ all rules ok', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.integer({ min: 8, max: 20 }), (pw, minLength) => {
        const r = evaluatePasswordPolicy(pw, policy({ minLength, minStrength: 0 }));
        const verdict = Object.fromEntries(r.rules.map((x) => [x.rule, x.ok]));
        expect(verdict.min_length).toBe([...pw].length >= minLength);
        expect(verdict.lowercase).toBe(/[a-z]/.test(pw));
        expect(verdict.uppercase).toBe(/[A-Z]/.test(pw));
        expect(verdict.digit).toBe(/\d/.test(pw));
        expect(verdict.special).toBe([...pw].some((ch) => PASSWORD_SPECIAL_CHARS.includes(ch)));
        expect(r.ok).toBe(r.rules.every((x) => x.ok));
      }),
    );
  });

  it('property: the strength score is deterministic and within 0–4', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (pw) => {
        const a = estimatePasswordStrength(pw);
        expect(a).toEqual(estimatePasswordStrength(pw));
        expect(a.score).toBeGreaterThanOrEqual(0);
        expect(a.score).toBeLessThanOrEqual(4);
      }),
    );
  });

  it('scores obvious patterns low and random strings high', () => {
    for (const weak of ['password', 'qwertyuiop', 'aaaaaaaaaaaa', 'abcdefghijkl', '123456789012', 'Welcome2026!']) {
      expect(estimatePasswordStrength(weak).score, weak).toBeLessThanOrEqual(1);
    }
    expect(estimatePasswordStrength('kX9#mP2$vL7q').score).toBe(4);
  });
});

describe('createHibpBreachChecker — k-anonymity', () => {
  it('sends only the 5-char SHA-1 prefix with Add-Padding, and matches the suffix locally', async () => {
    const pw = 'CorrectHorseBatteryStaple!42';
    const hash = await sha1Upper(pw);
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(`0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n${hash.slice(5)}:42\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0`),
    );
    const result = await createHibpBreachChecker({ fetch })(pw);

    expect(result).toEqual({ status: 'breached', count: 42 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
    expect(url).not.toContain(hash.slice(5));
    expect(url).not.toContain(pw);
    expect((init?.headers as Record<string, string>)['Add-Padding']).toBe('true');
  });

  it('treats a padding entry (count 0) as clean', async () => {
    const pw = 'some-password';
    const hash = await sha1Upper(pw);
    const fetch = vi.fn(async () => new Response(`${hash.slice(5)}:0\n`));
    expect(await createHibpBreachChecker({ fetch })(pw)).toEqual({ status: 'clean' });
  });

  it('is "unavailable" (never throws) on HTTP errors, network errors and timeouts', async () => {
    expect(await createHibpBreachChecker({ fetch: async () => new Response('', { status: 503 }) })('x')).toEqual({
      status: 'unavailable',
      reason: 'http_503',
    });
    expect(
      await createHibpBreachChecker({
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
      })('x'),
    ).toEqual({ status: 'unavailable', reason: 'network_error' });
    const hanging = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    expect(await createHibpBreachChecker({ fetch: hanging, timeoutMs: 5 })('x')).toEqual({
      status: 'unavailable',
      reason: 'timeout',
    });
  });
});

describe('enforcePasswordPolicy', () => {
  const strong = 'CorrectHorseBatteryStaple!42';

  it('never calls the breach checker while breachCheck is off (default)', async () => {
    const checker = vi.fn<BreachChecker>();
    const r = await enforcePasswordPolicy(strong, { policy: policy(), breachChecker: checker });
    expect(r.ok).toBe(true);
    expect(checker).not.toHaveBeenCalled();
  });

  it('rejects a breached password with a not_breached rule', async () => {
    const r = await enforcePasswordPolicy(strong, {
      policy: policy({ breachCheck: true }),
      breachChecker: async () => ({ status: 'breached', count: 7 }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('PASSWORD_POLICY');
    expect(failed(r.error.rules)).toEqual(['not_breached']);
    expect(r.error.message).toMatch(/not_breached/);
  });

  it('fails OPEN when the breach service is unavailable, and reports it', async () => {
    const onUnavailable = vi.fn();
    const r = await enforcePasswordPolicy(strong, {
      policy: policy({ breachCheck: true }),
      breachChecker: async () => ({ status: 'unavailable', reason: 'timeout' }),
      onBreachCheckUnavailable: onUnavailable,
    });
    expect(r.ok).toBe(true);
    expect(onUnavailable).toHaveBeenCalledWith('timeout');
  });

  it('skips the network check for a password the local rules already reject', async () => {
    const checker = vi.fn<BreachChecker>();
    const r = await enforcePasswordPolicy('weak', { policy: policy({ breachCheck: true }), breachChecker: checker });
    expect(r.ok).toBe(false);
    expect(checker).not.toHaveBeenCalled();
  });
});

describe('loadPasswordPolicy', () => {
  function fakeDb(rows: unknown[]) {
    const seen: { where?: SQL } = {};
    const db = {
      select: () => ({
        from: () => ({
          where: (w: SQL) => {
            seen.where = w;
            return { limit: () => Promise.resolve(rows) };
          },
        }),
      }),
    };
    return { db: db as never, seen };
  }

  it('reads only the instance-wide (__default__) row', async () => {
    const { db, seen } = fakeDb([]);
    expect(await loadPasswordPolicy(db)).toEqual(DEFAULT_PASSWORD_POLICY);
    const query = new PgDialect().sqlToQuery(seen.where!);
    expect(query.params).toEqual(['__default__', 'password_policy']);
  });

  it('returns a stored policy, filling defaults for omitted fields', async () => {
    const { db } = fakeDb([{ value: { minLength: 16, breachCheck: true } }]);
    expect(await loadPasswordPolicy(db)).toEqual({ ...DEFAULT_PASSWORD_POLICY, minLength: 16, breachCheck: true });
  });

  it('falls back to the default policy on a malformed row', async () => {
    const { db } = fakeDb([{ value: { minLength: 'twelve' } }]);
    expect(await loadPasswordPolicy(db)).toEqual(DEFAULT_PASSWORD_POLICY);
  });
});
