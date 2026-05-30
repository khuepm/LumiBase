/**
 * RecoveryService — backup-code account recovery for the Bootstrap
 * Admin (admin-setup-wizard task 10.4; Req 14.4; design §6.3, §7.3,
 * Luồng C).
 *
 * This module implements the `recover()` and `validateUnlockToken()`
 * surfaces of the design's `RecoveryService` interface (design §6
 * line 458). `forgotPath()` is intentionally NOT implemented here — it
 * belongs to task 10.5. The HTTP wiring (rate-limit + routes) lands in
 * tasks 10.6 / 10.7; this file owns only the business logic so it can
 * be unit-tested without a Hono context or a live Postgres.
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
 * Validates: Requirements 14.4 (design §6.3, §7.3).
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

// ── timing / token helpers ──────────────────────────────────────────────

const UNLOCK_TOKEN_BYTES = 32; // 32 * 8 = 256 bits of entropy.
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes (design §7.3).
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
   * Sleep used for the anti-timing delay. Defaults to a real
   * `setTimeout`-backed promise; tests inject an instant no-op.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Wall-clock source. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Unlock-token TTL in ms. Defaults to 15 minutes (design §7.3). */
  readonly tokenTtlMs?: number;
}

// ── service ─────────────────────────────────────────────────────────────

export class RecoveryService {
  private readonly db: Database;
  private readonly tokenStore: UnlockTokenStore;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly tokenTtlMs: number;

  constructor(deps: RecoveryServiceDeps) {
    this.db = deps.db;
    this.tokenStore = deps.tokenStore ?? sharedUnlockTokenStore;
    this.sleep =
      deps.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => new Date());
    this.tokenTtlMs = deps.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
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

    return { adminPath, oneTimeUnlockToken: token.plaintext };
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
