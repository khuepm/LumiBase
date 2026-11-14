/**
 * Password policy service (#733, epic #674 S04).
 *
 * The single gate every password-SETTING path goes through: self-service
 * registration, `/me/change-password`, `/auth/reset-password` (which is also
 * how an invited teammate sets a first password), the setup wizard's bootstrap
 * admin, and the backup-code recovery reset. Verifying an existing password
 * (login) never calls this — it must accept whatever was stored before.
 *
 * The rules themselves live in `@lumibase/contracts` (`evaluatePasswordPolicy`)
 * so the Studio checklist and strength meter run the exact same code. This
 * module adds what only the server can do:
 *
 *   - load the operator's policy (instance-wide `lumibase_settings` row
 *     `password_policy` under the `__default__` site — passwords belong to
 *     global `users` rows, so a per-site policy would let the weakest site set
 *     the password every other site accepts);
 *   - the optional Have I Been Pwned k-anonymity check: only the first 5 hex
 *     chars of the SHA-1 leave the process, with `Add-Padding: true` so the
 *     response size does not leak the match count. Off by default. Fails OPEN
 *     on network/HTTP errors (a third-party outage must not block password
 *     changes) with a warning and an audit event;
 *   - the structured error envelope `{ code: 'PASSWORD_POLICY', message, rules }`.
 */

import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { z } from 'zod';
import { settings, type Database } from '@lumibase/database';
import {
  DEFAULT_PASSWORD_POLICY,
  PasswordPolicySchema,
  evaluatePasswordPolicy,
  summarizePasswordPolicyFailure,
  type PasswordPolicy,
  type PasswordRuleResult,
  type PasswordStrengthScore,
} from '@lumibase/contracts/schemas';

import type { AppEnv } from '../../env';
import { systemDbFor } from '../../middleware/db';
import { AuditLogger } from '../../modules/audit/logger';
import { DEFAULT_SITE_ID } from '../../modules/setup/site-constants';

export const PASSWORD_POLICY_SETTINGS_KEY = 'password_policy';
export const PASSWORD_POLICY_ERROR_CODE = 'PASSWORD_POLICY';

/**
 * Request-body shape for a NEW password field. Deliberately only a bounded
 * string: the policy (incl. `max_length`) is applied by {@link checkNewPassword}
 * so a failure is reported per rule, while this cap keeps an oversized body
 * from ever reaching the hasher.
 */
export const NewPasswordInputSchema = z.string().min(1).max(1024);

export const HIBP_RANGE_ENDPOINT = 'https://api.pwnedpasswords.com/range/';
const HIBP_TIMEOUT_MS = 3000;

// ── policy storage ─────────────────────────────────────────────────────

type SettingsDb = Pick<Database, 'select'>;

/**
 * Read the instance-wide policy. Only the `__default__` row counts — a site
 * admin writing `password_policy` into their own site's settings through the
 * generic `/settings` store cannot weaken it. A missing row means the default
 * policy; a malformed row (hand-edited) also falls back to the default, which
 * is the conservative baseline rather than "no policy".
 */
export async function loadPasswordPolicy(db: SettingsDb): Promise<PasswordPolicy> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.siteId, DEFAULT_SITE_ID), eq(settings.key, PASSWORD_POLICY_SETTINGS_KEY)))
    .limit(1);
  const parsed = PasswordPolicySchema.safeParse(rows[0]?.value ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_PASSWORD_POLICY };
}

/** Persist the instance-wide policy (validated by the caller). */
export async function savePasswordPolicy(
  db: Pick<Database, 'insert'>,
  policy: PasswordPolicy,
): Promise<void> {
  await db
    .insert(settings)
    .values({ siteId: DEFAULT_SITE_ID, key: PASSWORD_POLICY_SETTINGS_KEY, value: policy, scope: 'site' })
    .onConflictDoUpdate({
      target: [settings.siteId, settings.key],
      set: { value: policy, updatedAt: new Date() },
    });
}

// ── breach check (HIBP k-anonymity) ────────────────────────────────────

export type BreachCheckResult =
  | { readonly status: 'clean' }
  | { readonly status: 'breached'; readonly count: number }
  | { readonly status: 'unavailable'; readonly reason: string };

export type BreachChecker = (password: string) => Promise<BreachCheckResult>;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function sha1Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * Build a HIBP range-API checker. Only `sha1(password)[0..5]` is sent; the
 * suffix comparison happens locally. `fetch` is injectable so tests never
 * touch the network.
 */
export function createHibpBreachChecker(options: {
  fetch?: FetchLike;
  endpoint?: string;
  timeoutMs?: number;
} = {}): BreachChecker {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const endpoint = options.endpoint ?? HIBP_RANGE_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? HIBP_TIMEOUT_MS;

  return async (password) => {
    const hash = await sha1Hex(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${endpoint}${prefix}`, {
        method: 'GET',
        headers: { 'Add-Padding': 'true', 'User-Agent': 'LumiBase-password-policy' },
        signal: controller.signal,
      });
      if (!res.ok) return { status: 'unavailable', reason: `http_${res.status}` };
      const body = await res.text();
      for (const line of body.split('\n')) {
        const [candidate, countRaw] = line.trim().split(':');
        if (candidate?.toUpperCase() !== suffix) continue;
        const count = Number.parseInt(countRaw ?? '0', 10);
        // Padding entries carry a count of 0 — they are not real breaches.
        return count > 0 ? { status: 'breached', count } : { status: 'clean' };
      }
      return { status: 'clean' };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return { status: 'unavailable', reason: aborted ? 'timeout' : 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── enforcement ────────────────────────────────────────────────────────

export interface PasswordPolicyFailure {
  readonly code: typeof PASSWORD_POLICY_ERROR_CODE;
  readonly message: string;
  readonly rules: readonly PasswordRuleResult[];
}

export type PasswordPolicyCheck =
  | { readonly ok: true; readonly score: PasswordStrengthScore; readonly rules: readonly PasswordRuleResult[] }
  | { readonly ok: false; readonly error: PasswordPolicyFailure };

export interface EnforcePasswordPolicyOptions {
  readonly policy: PasswordPolicy;
  /** E-mail / names of the account — passwords built from them score lower. */
  readonly userInputs?: readonly (string | null | undefined)[];
  /** Used only when `policy.breachCheck` is on. Defaults to the HIBP checker. */
  readonly breachChecker?: BreachChecker;
  /** Called when the breach check could not run (fail-open). */
  readonly onBreachCheckUnavailable?: (reason: string) => void | Promise<void>;
}

/**
 * Evaluate `password` against `policy`. Pure apart from the optional breach
 * check. The local rules run first; the network check runs only when the
 * password already passes them (no point leaking a prefix for a password we
 * are about to reject anyway).
 */
export async function enforcePasswordPolicy(
  password: string,
  options: EnforcePasswordPolicyOptions,
): Promise<PasswordPolicyCheck> {
  const evaluation = evaluatePasswordPolicy(password, options.policy, options.userInputs ?? []);
  const rules: PasswordRuleResult[] = [...evaluation.rules];

  if (options.policy.breachCheck && evaluation.ok) {
    const checker = options.breachChecker ?? createHibpBreachChecker();
    const result = await checker(password);
    if (result.status === 'unavailable') {
      await options.onBreachCheckUnavailable?.(result.reason);
      rules.push({
        rule: 'not_breached',
        ok: true,
        message: 'The breach check was unavailable; the password was accepted without it.',
      });
    } else {
      rules.push({
        rule: 'not_breached',
        ok: result.status === 'clean',
        ...(result.status === 'breached' ? { actual: result.count } : {}),
        message:
          result.status === 'clean'
            ? 'Not found in known data breaches.'
            : 'This password appears in known data breaches. Choose a different one.',
      });
    }
  }

  if (rules.every((r) => r.ok)) return { ok: true, score: evaluation.score, rules };
  return {
    ok: false,
    error: { code: PASSWORD_POLICY_ERROR_CODE, message: summarizePasswordPolicyFailure(rules), rules },
  };
}

/** `{ errors: [...] }` body for a failed check. */
export function passwordPolicyErrorBody(error: PasswordPolicyFailure): { errors: [PasswordPolicyFailure] } {
  return { errors: [error] };
}

// ── request-scoped entry point ─────────────────────────────────────────

/** Test seam: replace the breach checker used by {@link checkNewPassword}. */
let breachCheckerOverride: BreachChecker | null = null;
export function __setBreachCheckerForTests(checker: BreachChecker | null): void {
  breachCheckerOverride = checker;
}

/**
 * Route helper: load the instance policy and enforce it for a new password.
 * Returns `null` when the password is acceptable, or the failure to send as a
 * 400. `policy` may be passed explicitly (the setup wizard runs before any
 * policy row can exist and uses the default).
 */
export async function checkNewPassword(
  c: Context<AppEnv>,
  password: string,
  opts: { userInputs?: readonly (string | null | undefined)[]; policy?: PasswordPolicy } = {},
): Promise<PasswordPolicyFailure | null> {
  const policy = opts.policy ?? (await loadPasswordPolicy(systemDbFor(c)));
  const result = await enforcePasswordPolicy(password, {
    policy,
    userInputs: opts.userInputs,
    breachChecker: breachCheckerOverride ?? undefined,
    onBreachCheckUnavailable: async (reason) => {
      console.warn(`[password-policy] breach check unavailable (${reason}); accepting password (fail-open)`);
      const db = c.get('db');
      if (!db) return;
      await new AuditLogger({ db, siteId: c.get('siteId') ?? DEFAULT_SITE_ID }).write({
        event: 'password_breach_check_unavailable',
        requestId: c.get('requestId') ?? null,
        metadata: { reason },
      });
    },
  });
  return result.ok ? null : result.error;
}
