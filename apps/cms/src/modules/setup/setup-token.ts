/**
 * Setup token generation and verification.
 *
 * Implements Req 2.6, 2.7 and the secret handling rules in design §7.3.
 *
 * Behaviour summary:
 *   - {@link generateSetupToken} produces a CSPRNG token whose textual
 *     form is base64url with at least 24 characters and ≥128 bits of
 *     entropy (we generate 24 random bytes → 192 bits, ~32 chars).
 *     The hash returned alongside is `sha256(token).hex` and is what
 *     gets persisted in `system_state.setup_token_hash`. The plaintext
 *     value is only ever returned from this function — callers must
 *     print it once and forget it.
 *   - {@link verifySetupToken} runs constant-time over the stored hash
 *     so timing won't reveal a partial match.
 *   - {@link printSetupTokenIfRequired} encapsulates the startup-side
 *     logic (Req 2.6): when `LUMIBASE_REQUIRE_SETUP_TOKEN=true` and the
 *     instance is still uninitialized, generate a fresh token, persist
 *     its hash, and print the plaintext to stdout exactly once. The
 *     helper is idempotent across repeated invocations within the same
 *     process — once a hash already exists in `system_state`, it does
 *     not regenerate. It is called from the Node/Docker entrypoint via
 *     `./startup.ts` (`serve.ts` → `runSetupTokenStartup`); Cloudflare
 *     Workers have no process startup, so the flag is Node/Docker-only.
 *   - {@link isSetupTokenRequired} is the single parser of the flag. The
 *     side that *checks* a token (`routes.ts`) and the side that *mints*
 *     one (`startup.ts`) both go through it: if they disagreed about a
 *     value such as `1`, one side would demand a token the other never
 *     printed (#470).
 */

import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Database } from '@lumibase/database';
import { systemState } from '@lumibase/database';

const TOKEN_BYTES = 24; // 24 * 8 = 192 bits of entropy → above the 128-bit floor.

const textEncoder = new TextEncoder();

// ── encoding helpers ────────────────────────────────────────────────────

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  // btoa is portable across Node 20+ and Workers; the manual replacements
  // turn standard base64 into the URL-safe variant without padding.
  const b64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return toHex(new Uint8Array(digest));
}

/** Constant-time equality over hex strings (already canonical lowercase). */
function constantTimeStringEquals(a: string, b: string): boolean {
  // Compare a fixed-length form so length itself doesn't leak via early
  // exit. Pad to 64 (SHA-256 hex is 64 chars) plus an XOR of lengths.
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length, 64);
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

// ── public API ──────────────────────────────────────────────────────────

export interface GeneratedSetupToken {
  /** Raw token to print to stdout exactly once. base64url, ≥32 chars. */
  readonly plaintext: string;
  /** sha256(plaintext) hex; lives in `system_state.setup_token_hash`. */
  readonly hash: string;
}

/**
 * Mint a fresh Setup Token. Returns both the plaintext (for stdout) and
 * the hash (for `system_state.setup_token_hash`). The plaintext is
 * never persisted. Losing it is not fixed by a plain restart: the stored
 * hash survives, and {@link printSetupTokenIfRequired} deliberately does
 * not replace a hash whose token may already be in someone's hands. The
 * operator clears `setup_token_hash` and restarts (see `./startup.ts`).
 */
export async function generateSetupToken(): Promise<GeneratedSetupToken> {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  const plaintext = toBase64Url(bytes);
  const hash = await sha256Hex(plaintext);
  return { plaintext, hash };
}

/**
 * Verify a candidate plaintext against a stored hash. Returns `false`
 * for any malformed input rather than throwing so callers can map a
 * single error code without leaking parser state. The hex comparison
 * is constant-time.
 */
export async function verifySetupToken(
  plain: string,
  storedHash: string | null | undefined,
): Promise<boolean> {
  if (typeof plain !== 'string' || plain.length === 0) return false;
  if (typeof storedHash !== 'string' || storedHash.length === 0) return false;
  const candidate = await sha256Hex(plain);
  return constantTimeStringEquals(candidate, storedHash);
}

// ── flag parsing ────────────────────────────────────────────────────────

/** Environment key that turns the setup-token gate on (Req 2.6). */
export const REQUIRE_SETUP_TOKEN_ENV = 'LUMIBASE_REQUIRE_SETUP_TOKEN';

/**
 * Whether `LUMIBASE_REQUIRE_SETUP_TOKEN` is on in `env`.
 *
 * Accepts `true`, `1` and `yes` — exactly what the request path accepted
 * before this parser existed, so no deployment changes meaning. Takes a
 * plain record so it works for `process.env` (Node) and `c.env` (both
 * runtimes) without touching either runtime's bindings.
 */
export function isSetupTokenRequired(env: Readonly<Record<string, unknown>>): boolean {
  const v = env[REQUIRE_SETUP_TOKEN_ENV];
  if (typeof v !== 'string') return false;
  return v === 'true' || v === '1' || v === 'yes';
}

// ── startup wiring ──────────────────────────────────────────────────────

/**
 * Module-level guard so we only print the token once per process even
 * if `printSetupTokenIfRequired` is called multiple times (e.g. test
 * harnesses, dev-server re-loads).
 */
let didPrintThisProcess = false;

export interface SetupTokenStartupOptions {
  readonly db: Database;
  /**
   * Truthy when `LUMIBASE_REQUIRE_SETUP_TOKEN=true`. The caller is the
   * one that reads `process.env` so this module stays runtime-agnostic
   * (Workers don't have `process.env`).
   */
  readonly requireSetupToken: boolean;
  /** Optional sink for the plaintext line; defaults to `console.log`. */
  readonly print?: (line: string) => void;
}

/**
 * Idempotent startup hook (Req 2.6).
 *
 *   - Returns `'not_required'` when the operator hasn't opted into the
 *     token requirement.
 *   - Returns `'already_initialized'` when the instance is past setup.
 *   - Returns `'already_minted'` when a hash already exists in
 *     `system_state` (e.g. a previous boot already minted one) and we
 *     therefore can't surface the plaintext anymore.
 *   - Otherwise mints a new token, upserts the singleton row with the
 *     fresh hash, prints the plaintext exactly once and returns
 *     `'minted'`.
 *
 * The write is conditional (insert `ON CONFLICT DO NOTHING`, update only
 * `WHERE setup_token_hash IS NULL`), and the token is printed only by the
 * caller whose write landed. Several web replicas booting against a fresh
 * database therefore print exactly one token between them — the one whose
 * hash is stored — instead of each printing its own while the last writer
 * silently invalidates the rest, or the losers crashing on the primary key.
 *
 * Errors from the DB layer are *not* caught here — the caller decides
 * whether a startup failure should crash the process.
 */
export async function printSetupTokenIfRequired(
  options: SetupTokenStartupOptions,
): Promise<
  | 'not_required'
  | 'already_initialized'
  | 'already_minted'
  | 'minted'
> {
  if (!options.requireSetupToken) return 'not_required';

  const { db } = options;
  const print = options.print ?? ((line) => console.log(line));

  // Read or create the singleton row.
  const existing = await db
    .select()
    .from(systemState)
    .where(eq(systemState.id, 'singleton'))
    .limit(1);

  const row = existing[0];

  if (row && row.state === 'initialized') {
    return 'already_initialized';
  }

  if (row?.setupTokenHash) {
    // We must not reprint a token whose plaintext we no longer hold.
    return 'already_minted';
  }

  if (didPrintThisProcess) {
    // Defensive: another caller already printed in this process.
    return 'already_minted';
  }

  const token = await generateSetupToken();

  // Claim the slot. Only the caller whose write lands may print: another
  // process that got there first holds a token we must not invalidate.
  let claimed = false;
  if (!row) {
    const inserted = await db
      .insert(systemState)
      .values({ id: 'singleton', state: 'uninitialized', setupTokenHash: token.hash })
      .onConflictDoNothing()
      .returning({ id: systemState.id });
    claimed = inserted.length > 0;
  }
  if (!claimed) {
    // Either the row existed already, or a concurrent writer created it
    // between our read and our insert. Take it only while it still has no
    // hash and setup has not completed.
    const updated = await db
      .update(systemState)
      .set({ setupTokenHash: token.hash, updatedAt: new Date() })
      .where(
        and(
          eq(systemState.id, 'singleton'),
          isNull(systemState.setupTokenHash),
          ne(systemState.state, 'initialized'),
        ),
      )
      .returning({ id: systemState.id });
    claimed = updated.length > 0;
  }
  if (!claimed) {
    return 'already_minted';
  }

  // Single, well-marked stdout line so log scrapers can extract it.
  print(`[lumibase-cms] SETUP_TOKEN=${token.plaintext}`);
  didPrintThisProcess = true;
  return 'minted';
}

/**
 * Reset the in-process print guard. Used exclusively by tests.
 */
export function __resetSetupTokenPrintGuardForTests(): void {
  didPrintThisProcess = false;
}
