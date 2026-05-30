/**
 * RecoveryService — backup-code account recovery for the Bootstrap
 * Admin (admin-setup-wizard task 10.4; Req 14.4; design §6.3, §7.3,
 * Luồng C).
 *
 * This module implements the `recover()`, `forgotPath()`, and
 * `validateUnlockToken()` / `validateRecoveryToken()` surfaces of the
 * design's `RecoveryService` interface (design §6 line 458). The HTTP
 * wiring (rate-limit + routes) lands in tasks 10.6 / 10.7; this file
 * owns only the business logic so it can be unit-tested without a Hono
 * context or a live Postgres.
 *
 * ── recover(email, backupCode, ip) ──────────────────────────────────────
 *
 * Happy path (design §6.3 / Req 14.4):
 *   1. Look up the user by `lower(email)`.
 *   2. Gate on `users.isBootstrap` — only the bootstrap admin owns the
 *      backup codes, so a non-bootstrap match is treated as a failure
 *      (Req 14, design §6.3).
 *   3. Read `system_state.adminPath` — the value the caller needs to
 *      reach the Studio again.
 *   4. Scan the user's still-spendable codes
 *      (`admin_backup_codes WHERE used_at IS NULL`) and verify the
 *      supplied plaintext against each `code_hash` with
 *      {@link verifyPassword} (the hashes are in the shared
 *      `pbkdf2$100000$<salt>$<hash>` format — Req 14.2). The first row
 *      whose hash verifies is the match.
 *   5. In a single transaction:
 *        - stamp `used_at = now()` + `used_from_ip = ip` on the matched
 *          row (the `used_at IS NULL` guard in the UPDATE makes the
 *          redemption single-use even under a concurrent retry —
 *          Property 4 / Req 14.7);
 *        - clear the user's lockout (`lockedUntil`, `failedCount`,
 *          `failedCountWindowStart`);
 *        - drain the IP block for `ip` and the email's own failure
 *          burst. There is NO separate `ip_blocks` table — the
 *          sliding-window counter over `login_attempts` is the source
 *          of truth (design §6.4), so "unblock" means deleting the
 *          recent `result='fail'` rows for that IP (and email) inside
 *          the active `lockoutWindowSeconds`. This mirrors the
 *          `/unblock-ip` + `/unlock-user` handlers in
 *          `apps/cms/src/routes/admin-security.ts`;
 *        - persist the one-time unlock token's hash via the injected
 *          {@link UnlockTokenStore}.
 *   6. Return `{ adminPath, oneTimeUnlockToken }`. The plaintext token
 *      is handed back exactly once; only its `sha256` hash + an
 *      `expiresAt` ever touch storage (design §7.3).
 *
 * Failure paths (ALL collapse to the same generic `null` — the route
 * maps `null → 401`, task 10.7):
 *   - unknown email,
 *   - matched user is not the bootstrap admin,
 *   - the instance has no `adminPath` yet (inconsistent state),
 *   - no still-spendable code verifies against the supplied plaintext.
 *
 * ── forgotPath(email, ip) ────────────────────────────────────────────────
 *
 * The "I lost my Admin Path" flow (Req 14.5, 14.6, 14.7; design §6.3,
 * §4.8). Unlike `recover`, which returns a token to its caller,
 * `forgotPath` resolves to `void` and NEVER throws — its entire
 * contract is "always behave like an HTTP 200 generic response" so a
 * probe can't tell a known bootstrap email from an unknown one
 * (anti-enumeration — Req 14.5).
 *
 * Match path (only when the email belongs to the bootstrap admin):
 *   1. Look up the user by `lower(email)`.
 *   2. Gate on `users.isBootstrap === true` — a non-bootstrap match is
 *      treated as a no-match (do nothing, generic return). Same gate as
 *      `recover`.
 *   3. Mint a `Recovery_Token` (CSPRNG → base64url plaintext) with a
 *      30-minute TTL. Store ONLY its `sha256` hash + `expiresAt` via
 *      the injected {@link RecoveryTokenStore} — the plaintext never
 *      touches storage (design §7.3 / Req 14.6).
 *   4. Hand the plaintext token to the injected
 *      {@link RecoveryEmailSender}; the route layer (task 10.7) supplies
 *      a real sender backed by `EmailChannelFactory.fromEnv` + a
 *      recovery-email template. Sender errors are swallowed (best-effort
 *      — the response stays generic either way).
 *
 * No-op paths (unknown email, matched user isn't the bootstrap admin,
 * inconsistent state, or no email channel configured): do nothing — no
 * token is minted, nothing is stored, no email is sent — but the method
 * still resolves to `void` after the same random delay (below).
 *
 * "Email server configured" (Req 14.5): the sender is injected, so a
 * missing / no-op sender models "SMTP not configured" (design §12.3 /
 * §error-table: "Forgot-path vẫn trả 200 generic"). The default sender
 * is a log-only no-op, so an un-wired service still returns generically.
 * The service does not branch its return on whether a send happened —
 * the response is identical in every case.
 *
 * Token generation happens ONLY on the match path (don't burn entropy
 * or a DB write on every probe), but the random delay applies to ALL
 * paths (see anti-timing below). Because the match path does strictly
 * more work (mint + hash + store + email) than a no-match no-op, a
 * naive implementation would leak "this email matched" through wall
 * time; the uniform random delay dominates and masks that spread, the
 * same treatment `recover` applies.
 *
 * ── Recovery token vs unlock token (design §6.3, §7.3) ───────────────────
 *
 * The `oneTimeUnlockToken` (from `recover`) and the `Recovery_Token`
 * (from `forgotPath`) are semantically DISTINCT: different TTLs (15 min
 * vs 30 min) and different purposes (the unlock token re-enables a
 * locked account; the recovery token lets the operator recover/reset a
 * lost Admin_Path). They are kept in SEPARATE stores
 * ({@link UnlockTokenStore} vs {@link RecoveryTokenStore}) so an unlock
 * token can never be redeemed as a recovery token, or vice versa, even
 * though both share the same hash+expiresAt / single-use+TTL shape.
 * `validateRecoveryToken(token)` is the recovery-token counterpart of
 * `validateUnlockToken` — symmetric, consuming from its own store — and
 * the recovery route (task 10.7) uses it to exchange the emailed token
 * for an Admin_Path reset.
 *
 * ── Anti-enumeration + anti-timing (Req 14.4; design §6.3) ───────────────
 *
 * Every branch — success and failure alike — sleeps for a random
 * interval in `[200, 500]ms` ({@link randomDelayMs}) before returning.
 * The explicit requirement is "mọi nhánh thất bại trả 401 generic sau
 * random delay 200-500ms"; we extend the same treatment to the success
 * path so the two outcomes aren't trivially distinguishable by wall
 * time. The delay also masks the data-dependent cost of the PBKDF2
 * scan: verifying a backup code is ~50ms per candidate, and the number
 * of candidates varies (0 for an unknown user, up to 8 for the
 * bootstrap admin). A 300ms-wide random jitter dominates that spread so
 * the response time leaks neither "this email exists" nor "this email
 * has spendable codes". Internal errors are likewise mapped to `null`
 * (after the delay) so a DB hiccup can't become an oracle.
 *
 * The random delay is built from a CSPRNG byte pair (not `Math.random`)
 * so the jitter itself can't be predicted and subtracted out by an
 * attacker correlating many probes. The `sleep` function is injectable
 * (constructor `sleep` dep) so unit tests run with an instant no-op and
 * don't actually wait.
 *
 * ── UnlockTokenStore abstraction (design §7.3) ───────────────────────────
 *
 * There is no recovery-token / unlock-token TABLE in the schema yet
 * (the `users`, `system_state`, `admin_backup_codes`, `login_attempts`,
 * `login_baselines`, and `audit_log` tables exist — see
 * `packages/database/src/schema/security.ts` — but none stores the
 * `oneTimeUnlockToken` hash). Adding a migration is out of scope for
 * this task (it would prejudge schema decisions that belong to a
 * migration task), so token persistence is abstracted behind the
 * injectable {@link UnlockTokenStore}, mirroring the DI conventions
 * already used elsewhere (`SetupService`'s `backupCodesPersister` /
 * `auditWriter`, the LoginGuard hooks' `NotificationDeps`).
 *
 * The default {@link InMemoryUnlockTokenStore} is a `Map`-backed,
 * single-use, TTL-enforcing implementation. It is correct for a
 * single-process Node deployment, but it does NOT survive a restart and
 * is NOT shared across Cloudflare Workers isolates / multiple Node
 * instances. A production deployment must swap in a DB-backed store (a
 * `recovery_tokens` / unlock-token table holding `sha256(token)` +
 * `expiresAt`) — that wiring is a follow-up needed by the
 * `validateUnlockToken` consumers in task 10.7. Until then the
 * module-level shared instance ({@link sharedUnlockTokenStore}) means a
 * token saved by `recover()` is visible to `validateUnlockToken()`
 * within the same process.
 *
 * Validates: Requirements 14.4 (recover), 14.5, 14.6, 14.7 (forgotPath)
 * — design §6.3, §7.3, §4.8.
 */

import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import {
  adminBackupCodes,
  loginAttempts,
  systemState,
  users,
  type Database,
} from '@lumibase/database';

import { verifyPassword } from '../../services/auth/password';
import { normalizeEmail } from '../login-guard/email-normalize';
import { loadLockoutPolicyFromSettings } from '../login-guard/middleware';
import { STANDARD_LOCKOUT_POLICY } from '../setup/policy-codec';
// Type-only import keeps the dependency direction one-way (the audit
// module never imports back into recovery), mirroring how the LoginGuard
// hooks reference the logger. The real `AuditLogger` instance is built in
// the recovery routes (`routes.ts`) and injected via the constructor —
// admin-setup-wizard task 11.2 / Req 15.1, 15.2.
import type { AuditLogger, AuditLogWriteInput } from '../audit/logger';

// ── unlock-token store abstraction ──────────────────────────────────────

/**
 * Persistence seam for the one-time unlock token.
 *
 * Implementations store the token by its `sha256` HASH (never the
 * plaintext — design §7.3) alongside an absolute `expiresAt` deadline,
 * and enforce single-use semantics on {@link UnlockTokenStore.consume}.
 *
 * The production implementation will be DB-backed (a dedicated
 * unlock-token table); the default {@link InMemoryUnlockTokenStore} is
 * a correct single-process placeholder — see the module-level JSDoc for
 * its limitations.
 */
export interface UnlockTokenStore {
  /**
   * Persist a freshly minted token. `tokenHash` is `sha256(plaintext)`
   * (hex); `expiresAt` is the absolute expiry (mint time + TTL).
   */
  save(args: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<void>;

  /**
   * Consume an unexpired, unused token by its hash; returns the owning
   * `userId` or `null`. The operation is single-use: a successful
   * consume removes the token so a second call with the same hash
   * returns `null`. An expired token also returns `null` (and is
   * lazily evicted).
   */
  consume(
    tokenHash: string,
    now: Date,
  ): Promise<{ readonly userId: string } | null>;
}

/**
 * Default {@link UnlockTokenStore}: a `Map` from `tokenHash` to
 * `{ userId, expiresAt }`.
 *
 *   - **Single-use** — {@link consume} deletes the entry before
 *     returning the `userId`, so the same hash can never be redeemed
 *     twice (Property 4 / Req 14.7).
 *   - **TTL** — {@link consume} rejects (and lazily evicts) any entry
 *     whose `expiresAt` is at or before `now`.
 *
 * Limitations (flagged deliberately): this store lives in process
 * memory. It does not survive a restart, and it is not shared across
 * Cloudflare Workers isolates or multiple Node processes behind a load
 * balancer. Production must provide a DB-backed store (follow-up wiring
 * for task 10.7).
 */
export class InMemoryUnlockTokenStore implements UnlockTokenStore {
  private readonly tokens = new Map<
    string,
    { readonly userId: string; readonly expiresAt: Date }
  >();

  async save(args: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    this.tokens.set(args.tokenHash, {
      userId: args.userId,
      expiresAt: args.expiresAt,
    });
  }

  async consume(
    tokenHash: string,
    now: Date,
  ): Promise<{ readonly userId: string } | null> {
    const entry = this.tokens.get(tokenHash);
    if (!entry) return null;
    // TTL: reject + lazily evict once we're at/after the deadline.
    if (now.getTime() >= entry.expiresAt.getTime()) {
      this.tokens.delete(tokenHash);
      return null;
    }
    // Single-use: remove on the way out so a replay returns null.
    this.tokens.delete(tokenHash);
    return { userId: entry.userId };
  }

  /** Test/diagnostic helper — current number of live (un-consumed) tokens. */
  get size(): number {
    return this.tokens.size;
  }
}

/**
 * Process-wide default store so a token saved by {@link
 * RecoveryService.recover} is visible to {@link
 * RecoveryService.validateUnlockToken} within the same process. Swap
 * this for a DB-backed store in production (see module JSDoc).
 */
const sharedUnlockTokenStore = new InMemoryUnlockTokenStore();

// ── recovery-token store abstraction ────────────────────────────────────

/**
 * Persistence seam for the `Recovery_Token` minted by
 * {@link RecoveryService.forgotPath}.
 *
 * Mirrors {@link UnlockTokenStore} exactly (store by `sha256` HASH —
 * never the plaintext, design §7.3 — alongside an absolute `expiresAt`;
 * single-use on {@link RecoveryTokenStore.consume}) but is a SEPARATE
 * type/instance so the two token lifecycles never collide: a recovery
 * token must not be redeemable as an unlock token, nor the reverse
 * (design §6.3). The TTL differs too — 30 minutes here (Req 14.6) vs
 * 15 minutes for the unlock token.
 *
 * The production implementation will be DB-backed (a dedicated
 * recovery-token table); the default {@link InMemoryRecoveryTokenStore}
 * is a correct single-process placeholder — see the module-level JSDoc
 * for its limitations.
 */
export interface RecoveryTokenStore {
  /**
   * Persist a freshly minted recovery token. `tokenHash` is
   * `sha256(plaintext)` (hex); `expiresAt` is the absolute expiry
   * (mint time + 30-minute TTL).
   */
  save(args: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<void>;

  /**
   * Consume an unexpired, unused recovery token by its hash; returns
   * the owning `userId` or `null`. Single-use: a successful consume
   * removes the token so a second call with the same hash returns
   * `null`. An expired token also returns `null` (and is lazily
   * evicted).
   */
  consume(
    tokenHash: string,
    now: Date,
  ): Promise<{ readonly userId: string } | null>;
}

/**
 * Default {@link RecoveryTokenStore}: a `Map` from `tokenHash` to
 * `{ userId, expiresAt }`. Byte-for-byte the same semantics as
 * {@link InMemoryUnlockTokenStore} (single-use + TTL), but a distinct
 * instance so unlock and recovery tokens live in separate keyspaces and
 * can never be cross-redeemed (design §6.3 / Req 14.6).
 *
 * Limitations (flagged deliberately): this store lives in process
 * memory. It does not survive a restart, and it is not shared across
 * Cloudflare Workers isolates or multiple Node processes behind a load
 * balancer. Production must provide a DB-backed store (follow-up wiring
 * for task 10.7).
 */
export class InMemoryRecoveryTokenStore implements RecoveryTokenStore {
  private readonly tokens = new Map<
    string,
    { readonly userId: string; readonly expiresAt: Date }
  >();

  async save(args: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    this.tokens.set(args.tokenHash, {
      userId: args.userId,
      expiresAt: args.expiresAt,
    });
  }

  async consume(
    tokenHash: string,
    now: Date,
  ): Promise<{ readonly userId: string } | null> {
    const entry = this.tokens.get(tokenHash);
    if (!entry) return null;
    // TTL: reject + lazily evict once we're at/after the deadline.
    if (now.getTime() >= entry.expiresAt.getTime()) {
      this.tokens.delete(tokenHash);
      return null;
    }
    // Single-use: remove on the way out so a replay returns null.
    this.tokens.delete(tokenHash);
    return { userId: entry.userId };
  }

  /** Test/diagnostic helper — current number of live (un-consumed) tokens. */
  get size(): number {
    return this.tokens.size;
  }
}

/**
 * Process-wide default recovery-token store so a token saved by
 * {@link RecoveryService.forgotPath} is visible to {@link
 * RecoveryService.validateRecoveryToken} within the same process. Swap
 * this for a DB-backed store in production (see module JSDoc). Kept
 * separate from {@link sharedUnlockTokenStore} so the two token kinds
 * never collide.
 */
const sharedRecoveryTokenStore = new InMemoryRecoveryTokenStore();

// ── recovery-email sender abstraction ───────────────────────────────────

/**
 * Injectable seam for delivering the `Recovery_Token` to the operator
 * (design §6.3 / Req 14.5). Kept OUT of the `NotificationPayload`
 * pipeline on purpose: that payload is shaped for security *events*
 * (event/timestamp/ip/country/anomalyScore/...) and carries no place
 * for a recovery link, so shoehorning the recovery mail into it would
 * be a poor fit. Instead `forgotPath` depends on this tiny interface,
 * matching the DI conventions used elsewhere (`SetupService`'s
 * `backupCodesPersister` / `auditWriter`, the dispatcher's audit
 * writer) and keeping the service unit-testable without SMTP.
 *
 * Production wiring (task 10.7 routes) supplies a real sender backed by
 * `EmailChannelFactory.fromEnv(env)` plus a recovery-email template
 * that turns `{ to, recoveryToken, recoveryUrl }` into a message. The
 * service hands over the PLAINTEXT token exactly once (only its hash is
 * stored); building the `recoveryUrl` is left to the route/sender.
 */
export interface RecoveryEmailSender {
  /**
   * Send the recovery link/token to the operator. Resolves on send;
   * rejections/throws are swallowed by the service (best-effort,
   * anti-enumeration — the response stays generic either way).
   */
  sendRecoveryEmail(args: {
    readonly to: string;
    readonly recoveryToken: string;
    readonly recoveryUrl?: string;
  }): Promise<void>;
}

/**
 * Default {@link RecoveryEmailSender}: a log-only no-op modelling
 * "email server not configured" (design §12.3 — "Forgot-path vẫn trả
 * 200 generic"). With this default in place, an un-wired
 * {@link RecoveryService} still satisfies `forgotPath`'s contract — it
 * mints + stores the token and returns generically — without actually
 * delivering anything. Production replaces it via the `recoveryEmailSender`
 * constructor dep.
 */
export class NoopRecoveryEmailSender implements RecoveryEmailSender {
  async sendRecoveryEmail(args: {
    readonly to: string;
    readonly recoveryToken: string;
    readonly recoveryUrl?: string;
  }): Promise<void> {
    // Intentionally do not log the token (Req 15.3 — recovery tokens
    // are never written to logs). Record only that delivery was skipped
    // so operators can spot an un-configured email channel.
    void args;
    // eslint-disable-next-line no-console
    console.info(
      '[recovery] no recovery email sender configured; skipping delivery (forgot-path still returns generic 200)',
    );
  }
}

// ── timing / token helpers ──────────────────────────────────────────────

const UNLOCK_TOKEN_BYTES = 32; // 32 * 8 = 256 bits of entropy.
const RECOVERY_TOKEN_BYTES = 32; // 32 * 8 = 256 bits of entropy.
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes (design §7.3).
const DEFAULT_RECOVERY_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes (Req 14.6).
const DELAY_MIN_MS = 200;
const DELAY_MAX_MS = 500;
const DELAY_SPAN = DELAY_MAX_MS - DELAY_MIN_MS + 1; // inclusive [200, 500].

const textEncoder = new TextEncoder();

/**
 * Random anti-timing delay in **inclusive** `[200, 500]` milliseconds.
 *
 * Pure helper (no side effects) so it can be unit-tested in isolation.
 * The jitter is drawn from a CSPRNG byte pair rather than `Math.random`
 * so an attacker can't model and subtract the delay distribution out of
 * many timed probes. Returns an integer.
 */
export function randomDelayMs(): number {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  const sample = ((bytes[0]! << 8) | bytes[1]!) % DELAY_SPAN;
  return DELAY_MIN_MS + sample;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const b64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(binary, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/** `sha256(input)` as a lowercase hex string (Web Crypto, runtime-portable). */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(input),
  );
  return toHex(new Uint8Array(digest));
}

/**
 * Mint a fresh one-time unlock token. Mirrors the CSPRNG → base64url →
 * `sha256` hex approach in `apps/cms/src/modules/setup/setup-token.ts`:
 * 32 random bytes become the base64url plaintext, and only the hash is
 * ever persisted.
 */
async function generateUnlockToken(): Promise<{
  readonly plaintext: string;
  readonly hash: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(UNLOCK_TOKEN_BYTES));
  const plaintext = toBase64Url(bytes);
  const hash = await sha256Hex(plaintext);
  return { plaintext, hash };
}

/**
 * Mint a fresh `Recovery_Token`. Same construction as
 * {@link generateUnlockToken} (CSPRNG → base64url → `sha256` hex) — a
 * distinct helper so the two token kinds read clearly at their call
 * sites even though the byte count currently matches.
 */
async function generateRecoveryToken(): Promise<{
  readonly plaintext: string;
  readonly hash: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_TOKEN_BYTES));
  const plaintext = toBase64Url(bytes);
  const hash = await sha256Hex(plaintext);
  return { plaintext, hash };
}

// ── public types ────────────────────────────────────────────────────────

export interface RecoverResult {
  readonly adminPath: string;
  readonly oneTimeUnlockToken: string;
}

export interface RecoveryServiceDeps {
  readonly db: Database;
  /**
   * Persistence for unlock-token hashes. Defaults to the process-wide
   * {@link sharedUnlockTokenStore} so `validateUnlockToken` sees tokens
   * `recover` saved in the same process. Inject a DB-backed store in
   * production (follow-up for task 10.7).
   */
  readonly tokenStore?: UnlockTokenStore;
  /**
   * Persistence for recovery-token hashes (the `Recovery_Token` minted
   * by {@link RecoveryService.forgotPath}). Defaults to the process-wide
   * {@link sharedRecoveryTokenStore} so `validateRecoveryToken` sees
   * tokens `forgotPath` saved in the same process. Kept separate from
   * `tokenStore` so unlock and recovery tokens never cross-redeem
   * (design §6.3). Inject a DB-backed store in production (follow-up for
   * task 10.7).
   */
  readonly recoveryTokenStore?: RecoveryTokenStore;
  /**
   * Delivers the `Recovery_Token` to the operator's email. Defaults to
   * {@link NoopRecoveryEmailSender} (log-only), which models "email
   * server not configured" — `forgotPath` still returns generically.
   * Production supplies a real sender (task 10.7).
   */
  readonly recoveryEmailSender?: RecoveryEmailSender;
  /**
   * Sleep used for the anti-timing delay. Defaults to a real
   * `setTimeout`-backed promise; tests inject an instant no-op.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Wall-clock source. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Unlock-token TTL in ms. Defaults to 15 minutes (design §7.3). */
  readonly tokenTtlMs?: number;
  /** Recovery-token TTL in ms. Defaults to 30 minutes (Req 14.6). */
  readonly recoveryTokenTtlMs?: number;
  /**
   * Audit logger for the Req 15.1 recovery events (admin-setup-wizard
   * task 11.2): `recovery_initiated` (forgot-path match), and
   * `recovery_completed` + `backup_code_used` (recover success).
   *
   * OPTIONAL + injectable, defaulting to `undefined` (no-op) so the
   * large existing `service.test.ts` suite — which never passes an
   * `audit` — keeps passing unchanged. When absent, {@link writeAudit}
   * skips the write entirely; the recovery behaviour (token mint,
   * lockout clear, anti-timing delay, generic responses) is identical
   * with or without it. Production wires a `new AuditLogger({ db })`
   * via the recovery routes' `buildService(c)`.
   *
   * Audit entries are emitted ONLY on the success / match paths — never
   * on a failure branch — so the audit trail does not leak which emails
   * exist (anti-enumeration, Req 14.4 / 14.5). `AuditLogger.write` is
   * best-effort + never-throws (task 11.1), so a failed audit write can
   * never break recovery.
   */
  readonly audit?: AuditLogger | null;
}

// ── service ─────────────────────────────────────────────────────────────

export class RecoveryService {
  private readonly db: Database;
  private readonly tokenStore: UnlockTokenStore;
  private readonly recoveryTokenStore: RecoveryTokenStore;
  private readonly recoveryEmailSender: RecoveryEmailSender;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly tokenTtlMs: number;
  private readonly recoveryTokenTtlMs: number;
  private readonly audit: AuditLogger | null;

  constructor(deps: RecoveryServiceDeps) {
    this.db = deps.db;
    this.tokenStore = deps.tokenStore ?? sharedUnlockTokenStore;
    this.recoveryTokenStore =
      deps.recoveryTokenStore ?? sharedRecoveryTokenStore;
    this.recoveryEmailSender =
      deps.recoveryEmailSender ?? new NoopRecoveryEmailSender();
    this.sleep =
      deps.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => new Date());
    this.tokenTtlMs = deps.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.recoveryTokenTtlMs =
      deps.recoveryTokenTtlMs ?? DEFAULT_RECOVERY_TOKEN_TTL_MS;
    this.audit = deps.audit ?? null;
  }

  /**
   * Write a recovery audit entry through the injected {@link
   * AuditLogger}, no-oping when none is wired (admin-setup-wizard task
   * 11.2). The AuditLogger's `write()` is itself best-effort +
   * never-throws (task 11.1), but we still wrap in a try/catch as
   * belt-and-brace so a throwing test spy can never break recovery —
   * mirroring the `writeAudit` helper in the LoginGuard hooks.
   *
   * Called ONLY from the success / match paths so the audit trail never
   * reveals which emails exist (anti-enumeration, Req 14.4 / 14.5).
   */
  private async writeAudit(entry: AuditLogWriteInput): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.write(entry);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[recovery] audit write failed; recovery unaffected', err);
    }
  }

  /**
   * Recover the bootstrap admin via a backup code.
   *
   * Returns `{ adminPath, oneTimeUnlockToken }` on success, or `null`
   * on ANY failure (the route maps `null → 401`). A random
   * `[200, 500]ms` delay is applied to EVERY return path — success and
   * failure alike — to defeat enumeration + timing oracles
   * (Req 14.4). The plaintext token is returned exactly once; only its
   * `sha256` hash + `expiresAt` are persisted (design §7.3).
   */
  async recover(
    email: string,
    backupCode: string,
    ip: string,
  ): Promise<RecoverResult | null> {
    let result: RecoverResult | null = null;
    try {
      result = await this.attemptRecover(email, backupCode, ip);
    } catch (err) {
      // Any internal error collapses to the generic failure so a DB
      // hiccup can't become an enumeration / timing oracle. Log for
      // operators; never surface detail to the caller.
      // eslint-disable-next-line no-console
      console.warn('[recovery] recover() failed; returning generic null', err);
      result = null;
    }
    // Anti-timing: uniform random delay on success AND failure.
    await this.sleep(randomDelayMs());
    return result;
  }

  /**
   * Begin "I lost my Admin Path" recovery for the bootstrap admin.
   *
   * Resolves to `void` on EVERY path and NEVER throws (the route maps
   * this to a generic HTTP 200 `{ sent: true }`). Anti-enumeration is
   * the whole point: a probe must not be able to tell a known bootstrap
   * email from an unknown one — not via the response, and not via wall
   * time (Req 14.5).
   *
   * On the match path (the email belongs to the bootstrap admin and the
   * instance is in a consistent state) it mints a `Recovery_Token`
   * (30-minute TTL — Req 14.6), persists ONLY its `sha256` hash +
   * `expiresAt` via the injected {@link RecoveryTokenStore}, and hands
   * the plaintext to the injected {@link RecoveryEmailSender}. Every
   * other path (unknown email, non-bootstrap match, inconsistent state,
   * no email channel configured, or any internal error) is a silent
   * no-op. All paths sleep for the same random `[200, 500]ms` interval
   * before returning so the extra work the match path does (mint + hash
   * + store + email) isn't distinguishable by timing.
   */
  async forgotPath(email: string, ip: string): Promise<void> {
    try {
      await this.attemptForgotPath(email, ip);
    } catch (err) {
      // Swallow ALL errors → generic void. A DB hiccup or a throwing
      // email sender must not become an enumeration / timing oracle.
      // Log for operators; never surface detail to the caller.
      // eslint-disable-next-line no-console
      console.warn(
        '[recovery] forgotPath() failed; returning generic void',
        err,
      );
    }
    // Anti-timing: uniform random delay on the match AND no-match paths.
    await this.sleep(randomDelayMs());
  }

  /**
   * Validate (and consume) a one-time unlock token.
   *
   * Hashes the supplied plaintext and delegates to the injected
   * {@link UnlockTokenStore.consume}, which enforces single-use + TTL.
   * Returns `{ userId }` for a live token, or `null` for an unknown,
   * expired, or already-consumed token. Part of the design's
   * `RecoveryService` interface (§6) — the recovery route (task 10.7)
   * uses it to exchange the token for an authenticated unlock.
   */
  async validateUnlockToken(
    token: string,
  ): Promise<{ readonly userId: string } | null> {
    if (typeof token !== 'string' || token.length === 0) return null;
    const tokenHash = await sha256Hex(token);
    return this.tokenStore.consume(tokenHash, this.now());
  }

  /**
   * Validate (and consume) a `Recovery_Token` minted by
   * {@link forgotPath}.
   *
   * The recovery-token counterpart of {@link validateUnlockToken}:
   * hashes the supplied plaintext and delegates to the injected
   * {@link RecoveryTokenStore.consume}, which enforces single-use +
   * 30-minute TTL (Req 14.6). Returns `{ userId }` for a live token, or
   * `null` for an unknown, expired, or already-consumed token. Because
   * it reads from the recovery-token store — NOT the unlock-token store
   * — an `oneTimeUnlockToken` is never accepted here, and a
   * `Recovery_Token` is never accepted by `validateUnlockToken`
   * (design §6.3). The recovery route (task 10.7) uses it to exchange
   * the emailed token for an Admin_Path reset.
   */
  async validateRecoveryToken(
    token: string,
  ): Promise<{ readonly userId: string } | null> {
    if (typeof token !== 'string' || token.length === 0) return null;
    const tokenHash = await sha256Hex(token);
    return this.recoveryTokenStore.consume(tokenHash, this.now());
  }

  // ── internals ─────────────────────────────────────────────────────────

  /**
   * The un-delayed recovery logic. Returns `null` on every failure
   * branch; {@link recover} adds the uniform anti-timing delay around
   * this so the branches are timing-indistinguishable.
   */
  private async attemptRecover(
    email: string,
    backupCode: string,
    ip: string,
  ): Promise<RecoverResult | null> {
    const emailLower = normalizeEmail(email);
    if (emailLower.length === 0) return null;
    if (typeof backupCode !== 'string' || backupCode.length === 0) return null;

    // 1. Look up the user by lower-cased email (matches the
    //    `users_email_lower_unique` index convention used across the
    //    LoginGuard surface).
    const [user] = await this.db
      .select({ id: users.id, isBootstrap: users.isBootstrap })
      .from(users)
      .where(sql`lower(${users.email}) = ${emailLower}`)
      .limit(1);

    // 2. Unknown email OR non-bootstrap user → generic failure. The
    //    backup codes belong to the bootstrap admin (Req 14); even
    //    though they're FK'd to the user, we gate on `isBootstrap` per
    //    the design.
    if (!user || user.isBootstrap !== true) return null;

    // 3. The Admin Path the caller needs back. A bootstrap admin
    //    implies an initialized instance with a path set; a null here
    //    is an inconsistent state, so treat it as a failure rather than
    //    returning a useless empty path.
    const [stateRow] = await this.db
      .select({ adminPath: systemState.adminPath })
      .from(systemState)
      .where(eq(systemState.id, 'singleton'))
      .limit(1);
    const adminPath = stateRow?.adminPath ?? null;
    if (!adminPath) return null;

    // 4. Scan the user's still-spendable codes and find the one whose
    //    hash verifies against the supplied plaintext. The
    //    `used_at IS NULL` predicate is the source of truth for
    //    "spendable" — an already-redeemed code is never returned here
    //    so it can never match.
    const codeRows = await this.db
      .select({
        id: adminBackupCodes.id,
        codeHash: adminBackupCodes.codeHash,
      })
      .from(adminBackupCodes)
      .where(
        and(
          eq(adminBackupCodes.userId, user.id),
          isNull(adminBackupCodes.usedAt),
        ),
      );

    let matchedId: string | null = null;
    for (const row of codeRows) {
      // PBKDF2 verify (~50ms each). We deliberately do NOT early-break
      // on the first miss before scanning — the outer random delay
      // masks the count-dependent cost either way, and stopping at the
      // first match keeps the common case fast.
      // eslint-disable-next-line no-await-in-loop
      const ok = await verifyPassword(backupCode, row.codeHash);
      if (ok) {
        matchedId = row.id;
        break;
      }
    }
    if (!matchedId) return null;

    // 5. Mint the token OUTSIDE the transaction (CSPRNG + sha256) so we
    //    hold no locks during the crypto work — mirrors SetupService
    //    pre-hashing before its row lock.
    const now = this.now();
    const token = await generateUnlockToken();
    const expiresAt = new Date(now.getTime() + this.tokenTtlMs);
    const windowSeconds = await this.resolveLockoutWindowSeconds();

    // 6. Apply all success mutations atomically (design §6.3): mark the
    //    code used, clear the user lockout, drain the IP + email
    //    failure bursts, and save the token hash. A partial failure
    //    rolls the whole recovery back so we never leave a code spent
    //    without clearing the lockout, or vice versa.
    await this.db.transaction(async (tx) => {
      // 6a. Single-use redemption. The `used_at IS NULL` guard in the
      //     WHERE makes a concurrent double-redeem a no-op on the loser.
      await tx
        .update(adminBackupCodes)
        .set({ usedAt: now, usedFromIp: ip })
        .where(
          and(
            eq(adminBackupCodes.id, matchedId),
            isNull(adminBackupCodes.usedAt),
          ),
        );

      // 6b. Clear the user lockout (mirrors `/unlock-user`).
      await tx
        .update(users)
        .set({
          lockedUntil: null,
          failedCount: 0,
          failedCountWindowStart: null,
        })
        .where(eq(users.id, user.id));

      // 6c. Drain the email's recent failure burst inside the active
      //     window so the next login doesn't immediately re-lock.
      await tx
        .delete(loginAttempts)
        .where(
          and(
            eq(loginAttempts.emailLower, emailLower),
            eq(loginAttempts.result, 'fail'),
            gte(
              loginAttempts.createdAt,
              sql`now() - (${String(windowSeconds)} || ' seconds')::interval`,
            ),
          ),
        );

      // 6d. Drain the IP block. There's no `ip_blocks` table — the
      //     sliding-window counter is the source of truth (design
      //     §6.4), so deleting the IP's recent `fail` rows IS the
      //     unblock (mirrors `/unblock-ip`).
      await tx
        .delete(loginAttempts)
        .where(
          and(
            eq(loginAttempts.ip, ip),
            eq(loginAttempts.result, 'fail'),
            gte(
              loginAttempts.createdAt,
              sql`now() - (${String(windowSeconds)} || ' seconds')::interval`,
            ),
          ),
        );

      // 6e. Persist ONLY the token hash + expiry (design §7.3). For a
      //     DB-backed store this should run on the same `tx` so the
      //     token row commits atomically with the rest; the in-memory
      //     default is not transactional (documented limitation) but
      //     calling it here keeps the success mutations grouped.
      await this.tokenStore.save({
        userId: user.id,
        tokenHash: token.hash,
        expiresAt,
      });
    });

    // Req 15.1 — `recovery_completed` + `backup_code_used` audit
    // entries (task 11.2). Emitted post-commit (the recovery mutations
    // are durable), success-path only — a failure branch returns `null`
    // above WITHOUT writing any audit entry, so the trail never leaks
    // which emails exist or have spendable codes (anti-enumeration,
    // Req 14.4). Best-effort + never-throws via {@link writeAudit}. The
    // backup code itself is NEVER recorded — only the fact that a code
    // was redeemed (the code-row id, which is not a secret); the
    // AuditLogger would additionally mask a `backupCode` key if present
    // (Req 15.3).
    await this.writeAudit({
      event: 'backup_code_used',
      actorEmail: emailLower,
      targetEmail: emailLower,
      ip,
      metadata: { backupCodeId: matchedId },
    });
    await this.writeAudit({
      event: 'recovery_completed',
      actorEmail: emailLower,
      targetEmail: emailLower,
      ip,
      metadata: { method: 'backup_code' },
    });

    return { adminPath, oneTimeUnlockToken: token.plaintext };
  }

  /**
   * The un-delayed forgot-path logic. Returns `void` on every path;
   * {@link forgotPath} adds the uniform anti-timing delay and the
   * error-swallowing try/catch around this so the match and no-match
   * branches are timing-indistinguishable and the method never throws.
   *
   * Only the match path (bootstrap admin, consistent state) mints a
   * token, stores its hash, and emails the operator. Every other branch
   * returns early as a silent no-op — no token is generated, nothing is
   * stored, and no email is sent (Req 14.5).
   */
  private async attemptForgotPath(email: string, ip: string): Promise<void> {
    const emailLower = normalizeEmail(email);
    if (emailLower.length === 0) return;

    // 1. Look up the user by lower-cased email (same convention as
    //    `recover`).
    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        isBootstrap: users.isBootstrap,
      })
      .from(users)
      .where(sql`lower(${users.email}) = ${emailLower}`)
      .limit(1);

    // 2. Unknown email OR non-bootstrap user → silent no-op. Don't mint
    //    a token or send anything; the outer delay keeps this
    //    indistinguishable from the match path by timing.
    if (!user || user.isBootstrap !== true) return;

    // 3. A bootstrap admin implies an initialized instance with a path
    //    set. A missing path is an inconsistent state — there's nothing
    //    coherent to recover, so treat it as a no-op (still generic).
    const [stateRow] = await this.db
      .select({ adminPath: systemState.adminPath })
      .from(systemState)
      .where(eq(systemState.id, 'singleton'))
      .limit(1);
    if (!stateRow?.adminPath) return;

    // 4. Mint the Recovery_Token (CSPRNG + sha256) and persist ONLY its
    //    hash + expiry (design §7.3). The plaintext is handed to the
    //    sender exactly once and never stored.
    const now = this.now();
    const token = await generateRecoveryToken();
    const expiresAt = new Date(now.getTime() + this.recoveryTokenTtlMs);

    await this.recoveryTokenStore.save({
      userId: user.id,
      tokenHash: token.hash,
      expiresAt,
    });

    // Req 15.1 — `recovery_initiated` audit entry (task 11.2). Emitted
    // on the MATCH path only — right after the recovery token is minted
    // + stored — never on a no-match / no-op branch, so the audit trail
    // does not leak which emails belong to the bootstrap admin
    // (anti-enumeration, Req 14.5). Best-effort + never-throws via
    // {@link writeAudit}. The token plaintext is NEVER recorded; only
    // that recovery was initiated (the AuditLogger would additionally
    // mask a `recoveryToken` key if one were present — Req 15.3).
    await this.writeAudit({
      event: 'recovery_initiated',
      actorEmail: emailLower,
      targetEmail: user.email,
      ip,
      metadata: { method: 'forgot_path' },
    });

    // 5. Deliver to the operator's email. Best-effort: a throwing /
    //    rejecting sender must not change the generic outcome, so we
    //    isolate its failure here (the outer try/catch would also catch
    //    it, but swallowing locally keeps the token-store write
    //    committed and the contract obvious). We send to the user's
    //    stored email (its canonical casing), not the raw input.
    try {
      await this.recoveryEmailSender.sendRecoveryEmail({
        to: user.email,
        recoveryToken: token.plaintext,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[recovery] recovery email delivery failed; forgot-path still returns generic 200',
        err,
      );
    }
  }

  /**
   * Resolve the active sliding-window seconds from the persisted
   * Lockout_Policy, falling back to the Standard preset when the
   * settings row is missing or malformed — same convention as the
   * `/unlock-user` + `/unblock-ip` handlers.
   */
  private async resolveLockoutWindowSeconds(): Promise<number> {
    try {
      const policy = await loadLockoutPolicyFromSettings(this.db);
      return policy.lockoutWindowSeconds;
    } catch {
      return STANDARD_LOCKOUT_POLICY.lockoutWindowSeconds;
    }
  }
}
