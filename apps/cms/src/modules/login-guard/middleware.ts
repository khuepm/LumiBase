/**
 * Login Guard middleware (admin-setup-wizard Req 7.3, 8.3; design §6.3,
 * Property 8).
 *
 * Runs **before** the `/api/v1/auth/login` route handler and short-
 * circuits the request whenever the caller is already locked out so
 * the password verification path never gets a chance to run on a
 * locked account or a blocked IP. Specifically:
 *
 *   1. **Account lockout (Req 7.3)** — when `users.lockedUntil > now()`
 *      for the email in the request body, return HTTP 423 with
 *      `{ errors: [{ code: 'ACCOUNT_LOCKED', retryAfterSeconds }] }`.
 *      `retryAfterSeconds` is the integer ceiling of `(lockedUntil -
 *      now)/1000` so the client never sees a fractional value or a
 *      stale "0 seconds" hint.
 *
 *   2. **IP rate-limit (Req 8.3)** — when the IP's failed-attempt
 *      count over the configured `lockoutWindowSeconds` is at or above
 *      `Lockout_Policy.ipMaxFailedAttempts`, return HTTP 429 with the
 *      RFC 7231 `Retry-After` header set to the remaining lockout
 *      duration.
 *
 *   3. **No-enumeration guarantees (Req 7.5; Property 8)** — for
 *      requests that are *not* blocked, this middleware never reveals
 *      whether the email exists. To keep response timing aligned
 *      between "email exists" and "email doesn't exist" branches the
 *      account-lockout check always issues exactly one
 *      `users` SELECT keyed on `lower(email)` (returning either the
 *      row or no row), and we never run an extra query in the
 *      "email-found" branch that we don't also run in the "email-
 *      missing" branch. The downstream handler (task 6.2) is
 *      responsible for password verification timing parity.
 *
 * What this middleware does **not** do:
 *
 *   - It never validates the password. That's task 6.2's job — a
 *     locked-account / IP-blocked response is the *only* reason this
 *     middleware short-circuits.
 *   - It never writes to `login_attempts`. That belongs to the
 *     `onFailure`/`onSuccess` hooks added in task 6.2.
 *   - It never emits notifications. The notification dispatcher is
 *     wired in Phase E (task 9.5).
 *
 * Design references:
 *   - design §6.3 — middleware ordering and contract.
 *   - design §13 / Property 8 — no-enumeration on login fail.
 *   - Req 6.3 / Req 8.2 — Lockout_Policy fields (`ipMaxFailedAttempts`,
 *     `ipLockoutDurationSeconds`, `lockoutWindowSeconds`) and the
 *     hard floor `ipMaxFailedAttempts ≥ 3`.
 *
 * Validates: Requirements 7.3, 8.3.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { users, type Database } from '@lumibase/database';

import type { AppEnv } from '../../env';
import {
  STANDARD_LOCKOUT_POLICY,
  parseLockoutPolicy,
  isPolicyValidationError,
  type LockoutPolicy,
} from '../setup/policy-codec';
import { extractClientIp, type ExtractClientIpOptions } from './ip-extract';
import {
  createCounterStore,
  type CounterStore,
  type CounterStoreEnv,
} from './counter';
import { normalizeEmail } from './email-normalize';

/** Settings key used to persist the canonical Lockout_Policy (Req 6.6). */
const POLICY_SETTINGS_KEY = 'login_security_policy';

// ── public types ───────────────────────────────────────────────────────

/**
 * Per-call hooks for {@link loginGuardMiddleware}. The factory accepts
 * these so tests can swap out time, IP resolution, the counter store,
 * and the policy loader without touching the production wiring.
 *
 * In production, the wiring task at 6.6 will pass the runtime adapter's
 * remote-address resolver via {@link LoginGuardOptions.ipExtraction};
 * the counter store and policy loader default to the Postgres
 * implementations that read `login_attempts` and the `settings` row
 * with `key='login_security_policy'`.
 */
export interface LoginGuardOptions {
  /** Override the wall-clock used to compute `retryAfterSeconds`. */
  readonly now?: () => Date;
  /** Override IP resolution (e.g. for tests or a custom proxy chain). */
  readonly ipExtraction?: ExtractClientIpOptions;
  /**
   * Provide a non-default counter store. Defaults to
   * {@link createCounterStore} which selects the Postgres
   * implementation (Redis adapter is a future no-op — see counter.ts).
   */
  readonly counterStore?: (db: Database, env: CounterStoreEnv) => CounterStore;
  /**
   * Override the Lockout_Policy loader. Defaults to
   * {@link loadLockoutPolicyFromSettings} which reads
   * `settings.value` for the row keyed on
   * `login_security_policy`. When the row is missing or invalid, the
   * "Standard" preset (Req 6.3 defaults) is used.
   */
  readonly loadPolicy?: (db: Database) => Promise<LockoutPolicy>;
}

/** Outcome of the precheck. Exposed for unit tests of the helper. */
export type PrecheckOutcome =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly status: 423 | 429;
      readonly body: ErrorEnvelope;
      readonly headers?: Readonly<Record<string, string>>;
    };

interface ErrorEnvelope {
  readonly errors: ReadonlyArray<{
    readonly code: string;
    readonly retryAfterSeconds?: number;
  }>;
}

// ── middleware factory ─────────────────────────────────────────────────

/**
 * Build the Hono middleware. Bound to `/api/v1/auth/login` only — the
 * factory itself doesn't enforce a path scope, the caller mounts it on
 * the `/auth/login` route.
 *
 * The middleware is intentionally lean: it normalises the email,
 * resolves the IP, loads the policy, asks {@link precheckLogin} for a
 * verdict, and either short-circuits the request with a stable response
 * or hands off to the next handler.
 */
export function loginGuardMiddleware(
  options: LoginGuardOptions = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const db = c.get('db');
    if (!db) {
      // Without DB access we can't make a lockout decision. Fail open
      // so the route handler sees the request — the handler will
      // produce its own error response if it also can't reach the DB.
      return next();
    }

    const email = await readEmailFromRequest(c);
    const ip = extractClientIp(c, options.ipExtraction);
    const policy = await loadPolicy(db, options);
    const counter = (options.counterStore ?? createCounterStore)(
      db,
      readEnvForCounter(c),
    );

    const verdict = await precheckLogin({
      db,
      counter,
      policy,
      email,
      ip,
      now: options.now ? options.now() : new Date(),
    });

    if (verdict.allow) {
      return next();
    }

    return buildBlockedResponse(verdict);
  };
}

// ── core logic (exported for tests) ────────────────────────────────────

interface PrecheckArgs {
  readonly db: Database;
  readonly counter: CounterStore;
  readonly policy: LockoutPolicy;
  readonly email: string;
  readonly ip: string;
  readonly now: Date;
}

/**
 * Pure(-ish) precheck function: given the per-request DB handle, the
 * counter store, the resolved policy, and the email/IP/clock, decide
 * whether to allow the login attempt to proceed or short-circuit it
 * with a 423/429 response.
 *
 * The function exposes its inputs so unit tests can drive it without
 * a Hono context. Production code calls {@link loginGuardMiddleware}.
 *
 * Order of checks:
 *
 *   1. **Account lockout first.** A 423 is the most specific signal
 *      and aligns with Req 7.3's "for every attempt to that email,
 *      including correct credentials". This also keeps the timing
 *      profile uniform — the lookup runs *before* any IP-counter
 *      query, so attackers can't tell whether their IP is blocked by
 *      probing for a known-locked account.
 *
 *   2. **IP rate-limit second.** Independent of the user check
 *      (Req 8.6) — a counter ≥ `ipMaxFailedAttempts` returns 429 even
 *      if no specific user is locked.
 *
 * A request that survives both checks gets `{ allow: true }` and the
 * caller forwards it to the login handler.
 *
 * Email handling for no-enumeration parity (Req 7.5):
 *
 *   - The email value coming from the request is normalised (trim +
 *     lowercase) before keying any DB lookups so the comparison
 *     matches `loginAttempts.emailLower` and the SetupService's
 *     `email_lower`-style indexing.
 *   - The lookup query is identical regardless of whether the email
 *     exists in `users`. We always issue one `SELECT lockedUntil FROM
 *     users WHERE lower(email) = $1 LIMIT 1`; an empty result set is
 *     interpreted as "not locked", which is observationally
 *     identical to a row whose `lockedUntil` is NULL or in the past.
 */
export async function precheckLogin(
  args: PrecheckArgs,
): Promise<PrecheckOutcome> {
  const { db, counter, policy, email, ip, now } = args;
  const emailLower = normalizeEmail(email);

  // ── 1. Account lockout check (Req 7.3) ──────────────────────────────
  //
  // Always run the SELECT, even when the email is empty/blank, so the
  // request timing profile doesn't change shape based on whether the
  // body parsed cleanly. A blank email simply won't match any row.
  const lockedUntil = await selectUserLockedUntil(db, emailLower);
  if (lockedUntil && lockedUntil.getTime() > now.getTime()) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000),
    );
    return {
      allow: false,
      status: 423,
      body: {
        errors: [
          {
            code: 'ACCOUNT_LOCKED',
            retryAfterSeconds,
          },
        ],
      },
    };
  }

  // ── 2. IP rate-limit check (Req 8.3) ────────────────────────────────
  //
  // Req 8.2 enforces a hard floor of 3 (any policy value < 3 is rejected
  // by the wizard — but defend in depth here too in case settings were
  // edited out-of-band). The IP block kicks in once the rolling failure
  // count is *at or above* the threshold; we don't add 1 because the
  // counter already includes the most recent failure that brought the
  // user here.
  const ipThreshold = Math.max(3, policy.ipMaxFailedAttempts);
  const ipFailures = await counter.ipFailedCount(ip, policy.lockoutWindowSeconds);
  if (ipFailures >= ipThreshold) {
    // Compute Retry-After from the policy's lockout duration. We don't
    // persist a per-IP `ipBlockedUntil` row in this phase (the spec
    // adds no new table for IP blocks — design §6.4 derives the block
    // state from the sliding-window counter), so the most accurate
    // upper bound is `ipLockoutDurationSeconds`. This matches Req 8.3:
    // the `Retry-After` header tells the client how long until they
    // can try again, and the counter naturally drains as old `fail`
    // rows age out of the window.
    const retryAfterSeconds = Math.max(1, policy.ipLockoutDurationSeconds);
    return {
      allow: false,
      status: 429,
      body: {
        errors: [{ code: 'IP_BLOCKED', retryAfterSeconds }],
      },
      headers: { 'retry-after': String(retryAfterSeconds) },
    };
  }

  return { allow: true };
}

// ── lockout policy loader ──────────────────────────────────────────────

/**
 * Load the active Lockout_Policy from the `settings` row keyed on
 * `login_security_policy` (Req 6.6).
 *
 * Open question 8 (design §15.8 / tasks notes #7) leaves the settings
 * row's `siteId` ownership unresolved — the bootstrap admin's instance-
 * wide policy doesn't naturally fit the per-site `(siteId, key)` unique
 * constraint. Until that lands, we look up the policy by `key` alone
 * and pick the first row (`LIMIT 1`). When no row exists yet (the
 * SetupService deferred the write — see service.ts comment at §10),
 * we fall back to the Standard preset so the LoginGuard still has
 * sensible thresholds. The same fallback applies if the JSON parse
 * fails (an operator hand-edited the row to invalid contents).
 */
export async function loadLockoutPolicyFromSettings(
  db: Database,
): Promise<LockoutPolicy> {
  // Use a parameterised raw SQL fragment because the strict
  // `(siteId, key)` unique constraint means we can't rely on a typed
  // Drizzle helper without picking a siteId. Selecting all rows for
  // `key='login_security_policy'` and taking the first lets us survive
  // both "single-site instance" and "no site row yet" deployments.
  // The schema guarantees `value` is `jsonb`, so the row is already
  // parsed by the driver.
  type Row = { value: unknown };
  const rows = (await db.execute(
    sql`SELECT value FROM lumibase_settings WHERE key = ${POLICY_SETTINGS_KEY} LIMIT 1`,
  )) as unknown as Row[] | { rows: Row[] };

  // postgres-js returns the array directly; node-postgres wraps it in
  // `{ rows: [...] }`. Handle both shapes so the loader runs the same
  // way in tests and production.
  const list: Row[] = Array.isArray(rows)
    ? rows
    : Array.isArray((rows as { rows?: Row[] }).rows)
      ? ((rows as { rows: Row[] }).rows ?? [])
      : [];
  const value = list[0]?.value;
  if (value === undefined || value === null) {
    return { ...STANDARD_LOCKOUT_POLICY } as LockoutPolicy;
  }

  // `parseLockoutPolicy` accepts a JSON string, so re-stringify the
  // jsonb-decoded object. This also forces a canonical round-trip
  // through the codec so an operator-set policy with extra fields gets
  // normalised the same way fresh writes are.
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  const parsed = parseLockoutPolicy(json);
  if (isPolicyValidationError(parsed)) {
    return { ...STANDARD_LOCKOUT_POLICY } as LockoutPolicy;
  }
  return parsed;
}

// ── helpers ────────────────────────────────────────────────────────────

async function loadPolicy(
  db: Database,
  options: LoginGuardOptions,
): Promise<LockoutPolicy> {
  if (options.loadPolicy) return options.loadPolicy(db);
  try {
    return await loadLockoutPolicyFromSettings(db);
  } catch {
    // Settings table missing / DB hiccup: fall back to the Standard
    // preset so the guard doesn't itself become a denial of service.
    return { ...STANDARD_LOCKOUT_POLICY } as LockoutPolicy;
  }
}

/**
 * Read the email from the request body without consuming it for the
 * downstream handler. Hono's `c.req.json()` caches the parsed body on
 * the request, so the login route handler's own `c.req.json()` will
 * return the same object without re-reading the stream.
 */
async function readEmailFromRequest(
  c: Context<AppEnv>,
): Promise<string> {
  try {
    const body = (await c.req.json()) as unknown;
    if (typeof body !== 'object' || body === null) return '';
    const email = (body as { email?: unknown }).email;
    return typeof email === 'string' ? email : '';
  } catch {
    // Malformed JSON: the route handler will produce a 400 once it
    // tries to parse the body. We just want to make sure we don't
    // throw out of the middleware.
    return '';
  }
}

function readEnvForCounter(c: Context<AppEnv>): CounterStoreEnv {
  const env = c.env as unknown as Record<string, unknown> | undefined;
  if (!env) return {};
  const url = env.LUMIBASE_REDIS_URL;
  return typeof url === 'string' ? { LUMIBASE_REDIS_URL: url } : {};
}

/**
 * Select `users.lockedUntil` for the given lower-cased email. Returns
 * the `Date` when locked, `null` when the row doesn't exist or
 * `lockedUntil` is null.
 *
 * Uses raw SQL with `lower(email) = $1` so the comparison matches the
 * lower-cased index name `users_email_lower_unique` from design §3.1.
 * The current `users` table doesn't yet expose that index in the
 * Drizzle schema (task 1.1 added the column but not the index — see
 * core.ts), so a `lower()` SQL fragment keeps the lookup correct
 * regardless of how the row was inserted. Once the index lands the
 * planner picks it up automatically without changing this query.
 */
async function selectUserLockedUntil(
  db: Database,
  emailLower: string,
): Promise<Date | null> {
  if (emailLower.length === 0) {
    // Still issue a query so the timing profile matches; the empty
    // string won't match any row, and the LIMIT 1 keeps it cheap.
    const rows = await db
      .select({ lockedUntil: users.lockedUntil })
      .from(users)
      .where(sql`lower(${users.email}) = ${emailLower}`)
      .limit(1);
    return coerceLockedUntil(rows[0]?.lockedUntil);
  }
  const rows = await db
    .select({ lockedUntil: users.lockedUntil })
    .from(users)
    .where(sql`lower(${users.email}) = ${emailLower}`)
    .limit(1);
  return coerceLockedUntil(rows[0]?.lockedUntil);
}

function coerceLockedUntil(
  raw: unknown,
): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date) return raw;
  // Drizzle/postgres-js returns timestamps as `Date` already, but tests
  // sometimes inject ISO strings or numbers — accept both shapes
  // defensively.
  if (typeof raw === 'string' || typeof raw === 'number') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ── response shaping ───────────────────────────────────────────────────

/**
 * Build the short-circuit response. We deliberately mint a fresh
 * `Response` (rather than calling `c.json()`) so we can pin the header
 * set: the body is the only field the response should differ on, and
 * we avoid `vary` / cache hints that could leak the route's identity.
 *
 * For 429 (`IP_BLOCKED`), the spec mandates `Retry-After` (Req 8.3);
 * we surface it via a lower-cased header name to keep the byte
 * representation stable across runtimes.
 */
function buildBlockedResponse(
  verdict: Extract<PrecheckOutcome, { allow: false }>,
): Response {
  const body = JSON.stringify(verdict.body);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(new TextEncoder().encode(body).byteLength),
  };
  if (verdict.headers) {
    for (const [k, v] of Object.entries(verdict.headers)) {
      headers[k.toLowerCase()] = v;
    }
  }
  return new Response(body, { status: verdict.status, headers });
}
